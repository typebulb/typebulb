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

/** Every `*.bulb.md` under `cwd`, each with its frontmatter name (or filename stem),
 *  mtime, and headless (`serverOnly`) flag. Reads each file whole — small by nature, and the
 *  full parse is what tells a headless bulb from a launchable one. */
export function listBulbFiles(cwd: string): BulbFileInfo[] {
  return walk(cwd, 0, []).map(path => {
    let mtime = 0
    try { mtime = statSync(path).mtimeMs } catch { /* vanished mid-walk ⇒ sorts last */ }
    let name: string | undefined
    let serverOnly = false
    try {
      const content = readFileSync(path, 'utf8')
      name = bulbName(content.slice(0, 1024))
      const parsed = parseBulb(content)
      serverOnly = !!parsed && isServerOnly(toLocalBulb(parsed))
    } catch { /* unreadable ⇒ filename, and not treated as headless */ }
    return { path, name: name ?? basename(path).replace(/\.bulb\.md$/, ''), mtime, serverOnly }
  })
}
