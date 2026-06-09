import { readFile } from 'fs/promises'
import { parseBulb, toLocalBulb } from '../bulb/bulbParser.js'
import { predictTrust } from '../bulb/predictTrust.js'

/**
 * Node wrapper around predictTrust: read a `.bulb.md` and return the privileged capability it
 * probably needs (or undefined). For a host that wants to offer `--trust` BEFORE launching a bulb
 * — the proactive half of the trust model run at the *decision point*, so the offer lands before
 * the tab opens rather than after the server registers (TB-Security.md "Proactive
 * prediction"). Best-effort and probabilistic, never a gate: an unreadable/malformed bulb returns
 * undefined and falls through to the runtime gate, the same as any false negative.
 */
export async function predictBulbTrust(file: string): Promise<string | undefined> {
  try {
    const parsed = parseBulb(await readFile(file, 'utf-8'))
    if (!parsed) return undefined
    return predictTrust(toLocalBulb(parsed))
  } catch {
    return undefined
  }
}
