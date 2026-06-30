import { existsSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import type { SessionFile } from '../events.js'

// List the `.jsonl` session files in `dir` as SessionFile[] — sessionId is the filename stem. The
// session *directory* is the schema-specific part each adapter computes (CC: ~/.claude/projects/…;
// Pi: ~/.pi/agent/sessions/…); the listing itself is identical across agents (both name files
// `*.jsonl` and key by stem), so it lives here once instead of in every adapter.
export function listJsonlFiles(dir: string): SessionFile[] {
  if (!existsSync(dir)) return []
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return [] }
  const out: SessionFile[] = []
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue
    const file = join(dir, name)
    try {
      const s = statSync(file)
      if (s.isFile()) out.push({ sessionId: name.slice(0, -'.jsonl'.length), file, mtime: s.mtimeMs })
    } catch { /* races / permissions — skip */ }
  }
  return out
}
