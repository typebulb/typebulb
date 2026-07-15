import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join, isAbsolute } from 'path'
import { launchBulbServer, listBulbServers, stopBulbServer, readServerLog, listBulbFiles as listProjectBulbFiles, slugifyBulbName, isBulbTrusted, setBulbTrusted, predictBulbTrust, openInEditor, ensureDeclaredDependencies } from '../../../src/servers.js'
import { projectCwd } from './context.js'
import { searchHits, type SearchTurn } from './search.js'
import { extractDescription } from 'typebulb/format'

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
  // The embed render path is forgiving of an undeclared import (render.ts), but a real `.bulb.md` must
  // satisfy the authored-config contract (the local run / `check` enforce UNDECLARED_IMPORT). So at the
  // moment a throwaway becomes a kept file, derive any missing `config.json` `dependencies` from the
  // imports — a model that omitted config.json (the GLM case) still breaks out to a correct, runnable
  // bulb. Idempotent: a fully-declared bulb is returned unchanged (TB-Lint-Transpile.md).
  const bulb = ensureDeclaredDependencies(source)
  // Bulbs land in a `typebulbs/` folder (created on demand), keeping the project
  // root clean and mirroring the repo's own convention.
  const dir = join(cwd, 'typebulbs')
  mkdirSync(dir, { recursive: true })
  const slug = slugifyBulbName(bulb)
  // Never clobber a file we didn't write: an identical existing file is reused (idempotent relaunch; the
  // comparison is against the derived bulb, so re-breaking-out the same embed re-uses its file); a name
  // clash with different content takes the next -N.
  let file = `${slug}.bulb.md`
  for (let n = 2; existsSync(join(dir, file)) && readFileSync(join(dir, file), 'utf8') !== bulb; n++) {
    file = `${slug}-${n}.bulb.md`
  }
  const path = join(dir, file)
  if (!existsSync(path)) writeFileSync(path, bulb)
  const rel = join('typebulbs', file)
  // The launch itself — cross-platform detached spawn, idempotency (one server per file,
  // so a repeated breakout re-attaches instead of double-spawning), and registration so
  // listBreakouts/stopBreakout can find and stop it — is the typebulb capability. The host
  // owns only the file policy above. cwd = project root so the bulb resolves its rel path.
  // `open: false` for the same reason as launchBulb: a mirror-spawned bulb is windowless by virtue
  // of the mirror being its surface (the launcher row carries the `:port` link), never dependent on
  // an inherited TERM_PROGRAM=vscode that's absent outside a VS Code integrated terminal.
  const server = await launchBulbServer(rel, { cwd, open: false })
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
    // Headless (server-only) bulbs run in console mode with no port, so the launcher's dev-server
    // model — play → `:port` link, stop — can't represent them (a play click spawns a process that
    // never registers). They stay a terminal feature (`typebulb <file>` / `call`), not a launcher row.
    .filter(f => !f.serverOnly)
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
  // Same headless filter as listBulbFiles — a search hit on a server-only bulb would surface an
  // equally unlaunchable row.
  for (const f of listProjectBulbFiles(projectCwd).filter(f => !f.serverOnly).sort((a, b) => b.mtime - a.mtime)) {
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
  // `open: false` (→ `--no-open`): the mirror IS the surface — its launcher row already exposes the
  // running bulb's `:port` link (and Enter opens it), so a launcher click must never auto-pop an
  // external browser. Crucially this can't rely on the spawned bulb's own VS-Code auto-open default
  // (`open: !inVsCode` in parseArgs): that only suppresses when the bulb inherits TERM_PROGRAM=vscode,
  // which holds only if the whole spawn chain traces back to a VS Code *integrated terminal*. Spawn
  // the mirror from anywhere else (an agent/tool-runner shell, a plain terminal) and TERM_PROGRAM is
  // unset, so the inherited default flips to open and a window pops. Forcing it here makes windowless
  // a property of *being launched by the mirror*, not of the mirror's accidental environment.
  const server = await launchBulbServer(file, { cwd, open: false, trust })
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

// ---- samples: typebulb.com's curated sample bulbs, downloadable on demand ----
//
// The catalog is the site's promotion set (the `samples` user's public bulbs, stubs variant —
// specs/SEO.md), minus `welcome` (a homepage duplicate, not a sample). A sample becomes a file
// only on a play click (downloadSample), landing under `typebulbs/u/samples/` — the `u/<user>/`
// segment echoes the site's own URL structure, so the folder name IS the owner's slug (path
// identity), unambiguous next to the sibling `typebulbs/<bulb>/` data-folder convention. Moving a
// file out makes it an ordinary bulb; the folder belongs to the download — a re-download
// overwrites, never merges.

const SAMPLES_API = 'https://api.typebulb.com'
const SAMPLES_TTL = 60 * 60 * 1000
const CATALOG_TIMEOUT = 5000
const DOWNLOAD_TIMEOUT = 15_000
let samplesCache: { samples: { slug: string; name: string; description: string }[]; fetchedAt: number } | null = null
let samplesFetch: Promise<{ slug: string; name: string; description: string }[]> | null = null

// The catalog, cached like the model catalog (modelCatalog.ts): bounded fetch, stale-or-empty on
// failure — an offline mirror degrades to a launcher without a samples section, never an error.
// Single-flight: concurrent cold callers (attach + first menu open) share one request.
export async function listSamples() {
  if (samplesCache && Date.now() - samplesCache.fetchedAt <= SAMPLES_TTL) return samplesCache.samples
  samplesFetch ??= fetchSamples().finally(() => { samplesFetch = null })
  return samplesFetch
}

async function fetchSamples() {
  try {
    const res = await fetch(`${SAMPLES_API}/api/scripts/u/samples?stubs`, { signal: AbortSignal.timeout(CATALOG_TIMEOUT) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const bulbs = await res.json() as { slug: string; name: string; config?: string }[]
    const samples = bulbs
      .filter(b => b.slug !== 'welcome')
      .map(b => ({ slug: b.slug, name: b.name, description: extractDescription(b.config) }))
    samplesCache = { samples, fetchedAt: Date.now() }
    return samples
  } catch {
    return samplesCache?.samples ?? []
  }
}

// Fetch one sample's serialized markdown (the `.md` route — the same bytes a .bulb.md holds) and
// write it under typebulbs/u/samples/. The slug crosses the RPC boundary from the client, so pin it
// to slug shape before it touches a path. Returns the rel path for the caller to launch.
export async function downloadSample(slug: string) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) return { ok: false, error: 'bad slug' }
  let md: string
  try {
    const res = await fetch(`${SAMPLES_API}/api/scripts/u/samples/${slug}.md`, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT) })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    md = await res.text()
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? String(e) }
  }
  const dir = join('typebulbs', 'u', 'samples')
  mkdirSync(join(projectCwd, dir), { recursive: true })
  const rel = join(dir, `${slug}.bulb.md`)
  writeFileSync(join(projectCwd, rel), md)
  return { ok: true, file: rel }
}
