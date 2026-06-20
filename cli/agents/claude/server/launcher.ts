import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join, isAbsolute } from 'path'
import { launchBulbServer, listBulbServers, stopBulbServer, readServerLog, listBulbFiles as listProjectBulbFiles, slugifyBulbName, isBulbTrusted, setBulbTrusted, predictBulbTrust, openInEditor } from '../../../src/servers.js'
import { projectCwd } from './context.js'
import { searchHits, type SearchTurn } from './transcript.js'

// The mirror's bulb-side RPCs: open a cited file in the editor, promote an embedded bulb to a file
// (breakout), and the status-bar launcher (list / launch / stop / trust / tail this project's bulbs).
// These touch only the project cwd + the typebulb capabilities in src/servers.js — none of the
// transcript machinery — so they live apart from the core (the A→B split: this is A, the core is B).

// ---- editor integration ----

export async function openFile(filePath: string, line?: number) {
  // The detached spawn + editor resolution is the typebulb capability (openInEditor); the host owns
  // the policy that a relative-path citation routes here (onMarkdownClick). The path is
  // attacker-influenced (M5, TB-Security-Attacks.md), so confine it to a real file: openInEditor runs
  // no shell, and a citation names an existing file by contract — refusing a non-file is a
  // version-independent backstop so a junk/injection path never reaches the (Windows cmd.exe) spawn.
  const abs = isAbsolute(filePath) ? filePath : join(projectCwd, filePath)
  if (!existsSync(abs)) return { ok: false, error: 'file not found' }
  openInEditor(abs, line)
  return { ok: true }
}

// ---- breakout: promote an embedded bulb to a standalone file + launch it ----

// The filename comes from the bulb's own `name:` frontmatter, slugified (slugifyBulbName,
// the typebulb capability) — no prompt, no guess. The host owns only *where* the file lands.
export async function breakout(source: string) {
  const cwd = projectCwd
  // Bulbs land in a `typebulbs/` folder (created on demand), keeping the project
  // root clean and mirroring the repo's own convention.
  const dir = join(cwd, 'typebulbs')
  mkdirSync(dir, { recursive: true })
  const slug = slugifyBulbName(source)
  // Never clobber a file we didn't write: an identical existing file is reused
  // (idempotent relaunch); a name clash with different content takes the next -N.
  let file = `${slug}.bulb.md`
  for (let n = 2; existsSync(join(dir, file)) && readFileSync(join(dir, file), 'utf8') !== source; n++) {
    file = `${slug}-${n}.bulb.md`
  }
  const path = join(dir, file)
  if (!existsSync(path)) writeFileSync(path, source)
  const rel = join('typebulbs', file)
  // The launch itself — cross-platform detached spawn, idempotency (one server per file,
  // so a repeated breakout re-attaches instead of double-spawning), and registration so
  // listBreakouts/stopBreakout can find and stop it — is the typebulb capability. The host
  // owns only the file policy above. cwd = project root so the bulb resolves its rel path.
  const server = await launchBulbServer(rel, { cwd, open: true })
  return { ok: true, file: rel, pid: server.pid, url: server.url }
}

// The running bulb dev servers for the status-bar pill — scoped to *this project* (projectCwd), the
// same project whose sessions and files we mirror. The registry is cross-project, but a mirror for
// one CC project shouldn't surface another project's bulbs (or another project's claude.bulb); the
// cwd scope mirrors the file walk and keeps projects from bleeding into each other. listBulbServers
// prunes dead entries on read; the UI still drops this host's own pid (see info()).
export async function listBreakouts() {
  return listBulbServers(projectCwd)
}

// Stop one by pid (SIGTERM + deregister). Idempotent — an already-gone pid is a no-op.
export async function stopBreakout(pid: number) {
  await stopBulbServer(pid)
  return { ok: true }
}

// ---- launcher: the project's .bulb.md files, launchable from the status bar ----
//
// Per-bulb trust memory lives in the CLI's store (isBulbTrusted/setBulbTrusted from typebulb/servers),
// not here — so the launcher toggle, a bare `typebulb <file>`, and `typebulb trust` all share one
// source of truth (TB-Security.md). The launcher just reads/writes that store.

// The project's *.bulb.md candidates for the launcher. The walk (listProjectBulbFiles) is the typebulb
// capability; it lists every project bulb. The mirror itself is no longer a bulb (it's CLI code), so
// there's nothing to exclude from this file walk — the running mirror is dropped from the *server*
// list by its `agent` field, not here. The host only overlays each bulb's remembered trust tier.
export async function listBulbFiles() {
  return listProjectBulbFiles(projectCwd)
    .map(f => ({ ...f, trusted: isBulbTrusted(f.path) }))
}

// Full-text search over the project's bulb files — the launcher's analogue of searchSessions, for
// finding a bulb by what's inside it (a dependency, an API, a phrase in its data) when the name
// doesn't say. The corpus is each file's non-empty lines read raw: a bulb file is all content, so
// none of the transcript's display-cleaning applies — and at a handful of small files per
// (debounced) query, no cache either; the session cache exists for MB-scale JSONL parses.
// Newest-first, matching searchSessions' contract; the launcher re-sorts after joining its rows.
export async function searchBulbs(query: string) {
  const q = query.toLowerCase()
  const out: { path: string; hitCount: number; snippet: string }[] = []
  for (const f of listProjectBulbFiles(projectCwd).sort((a, b) => b.mtime - a.mtime)) {
    let raw = ''
    try { raw = readFileSync(f.path, 'utf8') } catch { continue }
    const chunks: SearchTurn[] = []
    for (const line of raw.split('\n')) {
      const text = line.replace(/\s+/g, ' ').trim()
      if (text) chunks.push({ text, lower: text.toLowerCase() })
    }
    const { hitCount, snippet } = searchHits(chunks, q)
    if (hitCount) out.push({ path: f.path, hitCount, snippet })
  }
  return out
}

// Launch (or re-attach to) a dev server for an existing project bulb — the same node capability
// breakout uses, minus the file write. Idempotent per file. `trust` is the explicit choice (the
// elevation modal / toggle); passing it persists the decision to the CLI store. When omitted, the
// spawned server resolves the remembered tier itself (its main() consults the same store) — so the
// effective-tier decision lives in one place; we just report the tier it actually came up in.
export async function launchBulb(file: string, trust?: boolean) {
  const cwd = projectCwd
  // Only a real boolean is an explicit decision. `undefined` (no decision) crosses the tb.server
  // JSON boundary as `null`, so guard on `!= null` — a bare launch must NOT clobber the store.
  if (trust != null) setBulbTrusted(file, trust)
  const server = await launchBulbServer(file, { cwd, open: true, trust })
  return { ok: true, file: server.file, pid: server.pid, url: server.url, trust: !!server.trust }
}

// Scan a bulb for privileged tb.* usage BEFORE launching, so the launcher can raise the trust
// offer at the decision point rather than after the spawned server registers (TB-Security.md
// "Proactive prediction"). Returns a capability label or undefined; a hint, never a gate.
export async function predictTrustOf(file: string) {
  return { cap: await predictBulbTrust(file) }
}

// Set (or clear) a bulb's remembered trust decision (the launcher's trust toggle) — delegates to the
// CLI's shared store. Writing the memory only takes effect on the next launch; a running server's tier
// is fixed at process start, so to apply it now the launcher stops and relaunches that server itself.
export async function setBulbTrust(file: string, trust: boolean) {
  setBulbTrusted(file, trust)
  return { ok: true }
}

// Tail a running server's console (its `<pid>.log`). New bytes since `offset`; the server
// writes the file, any host reads it — the same drain-from-offset shape as the transcript.
export async function readBulbLog(pid: number, offset: number) {
  return readServerLog(pid, offset)
}
