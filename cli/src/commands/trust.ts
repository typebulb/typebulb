import * as path from 'path'
import { setBulbTrusted, listTrustedBulbs } from '../serve/trustStore.js'

/**
 * `typebulb trust [file]` / `typebulb untrust <file>` — set or clear a bulb's remembered trust in the
 * CLI's store (TB-Security.md). The agent-facing policy lever: trust a bulb once and a
 * later `typebulb <file>` grants fs/AI/server.ts without `--trust`. No-arg `trust` lists the
 * remembered set. The store is shared with claude.bulb's launcher, so GUI and CLI agree.
 */
export async function runTrust(file: string | undefined, trust: boolean): Promise<void> {
  if (!file) {
    if (!trust) { console.error('Usage: typebulb untrust <file.bulb.md>'); process.exit(1) }
    const list = listTrustedBulbs()
    if (!list.length) { console.log('No bulbs are remembered as trusted.'); return }
    console.log('Trusted bulbs (run with fs/AI/server.ts without --trust):')
    for (const p of list) console.log(`  ${p}`)
    return
  }
  const abs = path.resolve(file)
  if (!abs.endsWith('.bulb.md')) { console.error('File must have .bulb.md extension'); process.exit(1) }
  setBulbTrusted(abs, trust)
  console.log(trust
    ? `Trusted ${path.basename(abs)} — runs with fs / AI / server.ts (no --trust needed).`
    : `Untrusted ${path.basename(abs)} — runs Restricted.`)
  console.log(`  ${abs}`)
}
