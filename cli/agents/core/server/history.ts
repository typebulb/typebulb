import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { typebulbHome } from '../../../src/servers.js'

/** A JSON-lines file under ~/.typebulb kept to a window of time, shared by every mirror on the machine.
 *  A home that can't be read or written leaves the history to this run. */
export function windowFile<T extends { at: number }>(name: string, windowMs: number) {
  const path = () => join(typebulbHome(), name)
  const read = (now: number): T[] => {
    let lines: string[] = []
    try { lines = readFileSync(path(), 'utf8').split('\n') } catch {}
    return lines.flatMap(l => { try { return [JSON.parse(l) as T] } catch { return [] } }).filter(r => r.at >= now - windowMs)
  }
  return {
    read,
    /** The window, rewritten so the file doesn't grow past it. */
    load(now: number): T[] {
      const rows = read(now)
      try { mkdirSync(typebulbHome(), { recursive: true }); writeFileSync(path(), rows.map(r => JSON.stringify(r) + '\n').join('')) } catch {}
      return rows
    },
    append(rows: T[]) { if (rows.length) try { appendFileSync(path(), rows.map(r => JSON.stringify(r) + '\n').join('')) } catch {} },
  }
}
