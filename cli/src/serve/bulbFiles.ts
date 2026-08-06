/**
 * Discover a project's `*.bulb.md` files — the read-only walk a launcher host
 * (the agent mirror's bulbs pill, a future codex mirror's, …) would otherwise copy verbatim.
 * The capability half of "list the project's bulbs"; the host overlays its own
 * concerns (trust memory, MRU, the running registry) and renders the UI.
 *
 * Node-only (fs walk), so it ships on the `./servers` entry, never the browser one.
 */

import { readdirSync, readFileSync, statSync, type Dirent } from 'fs'
import { join, basename } from 'path'
import { parseBulb } from 'typebulb/format'
import { isServerOnly, toLocalBulb } from '../bulb/bulbParser.js'
import { bulbName } from '../bulb/source.js'
import { bulbDataDir } from '../pipeline.js'

export interface BulbFileInfo {
  /** Absolute path to the .bulb.md. */
  path: string
  /** The bulb's `name:` frontmatter title, or the filename stem when unnamed. */
  name: string
  /** File mtime (epoch ms); 0 if it vanished mid-walk. */
  mtime: number
  /**
   * A headless bulb: a `server.ts` block and no `code.tsx` page, so it runs in console mode
   * (runConsole) — no HTTP server, no port. A dev-server launcher can't represent it (nothing to
   * open, nothing that registers), so a host offering play/stop/`:port` rows filters these out.
   * Reported here as a fact; the filtering policy is the host's.
   */
  serverOnly: boolean
}

// Skip dot-dirs (.git, .typebulb, .vscode, …) and node_modules; bounded depth
// keeps a deep tree cheap.
function walk(dir: string, depth: number, out: string[]): string[] {
  if (depth > 8) return out
  let ents: Dirent[]
  try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of ents) {
    if (e.isDirectory()) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue
      walk(join(dir, e.name), depth + 1, out)
    } else if (e.isFile() && e.name.endsWith('.bulb.md')) {
      out.push(join(dir, e.name))
    }
  }
  return out
}

/** A bulb's named batches — the immediate subdirectories of `<bulb-folder>/batches/`, newest
 *  folder-mtime first (the boot-time touch makes that last-invocation order — TB-Batch.md
 *  Invariant 3). Location is the marker: every directory here is a batch, nothing else ever is
 *  (Invariant 1), so there's no stub file to check and no manifest to consult. */
export function listBulbBatches(bulbPath: string): string[] {
  const dir = join(bulbDataDir(bulbPath), 'batches')
  let ents: Dirent[]
  try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return [] }
  return ents
    .filter(e => e.isDirectory())
    .map(e => {
      let mtime = 0
      try { mtime = statSync(join(dir, e.name)).mtimeMs } catch { /* vanished mid-list ⇒ sorts last */ }
      return { name: e.name, mtime }
    })
    .sort((a, b) => b.mtime - a.mtime)
    .map(b => b.name)
}

// One bulb's parse-derived fields, read fresh: the frontmatter name (or filename stem) and the
// headless flag (the full parse is what tells a headless bulb from a launchable one).
function readInfo(path: string, mtime: number): { mtime: number; name: string; serverOnly: boolean } {
  let name: string | undefined
  let serverOnly = false
  try {
    const content = readFileSync(path, 'utf8')
    name = bulbName(content.slice(0, 1024))
    const parsed = parseBulb(content)
    serverOnly = !!parsed && isServerOnly(toLocalBulb(parsed))
  } catch { /* unreadable ⇒ filename, and not treated as headless */ }
  return { mtime, name: name ?? basename(path).replace(/\.bulb\.md$/, ''), serverOnly }
}

/** Every `*.bulb.md` under `cwd`, each with its frontmatter name (or filename stem), mtime, and
 *  headless (`serverOnly`) flag. Parses are cached by mtime — launcher hosts poll this over the
 *  whole corpus every few seconds, so only a changed file re-reads. */
let parsed = new Map<string, ReturnType<typeof readInfo>>()
export function listBulbFiles(cwd: string): BulbFileInfo[] {
  const next: typeof parsed = new Map()
  const out = walk(cwd, 0, []).map(path => {
    let mtime = 0
    try { mtime = statSync(path).mtimeMs } catch { /* vanished mid-walk ⇒ sorts last */ }
    const hit = mtime ? parsed.get(path) : undefined     // mtime 0 is never cached, so a stat failure retries
    const entry = hit?.mtime === mtime ? hit : readInfo(path, mtime)
    if (mtime) next.set(path, entry)
    return { path, ...entry }
  })
  parsed = next   // swap, not merge: entries for vanished files fall away here
  return out
}
