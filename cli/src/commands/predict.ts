import { readBulb } from '../pipeline.js'
import { predictTrust } from '../bulb/predictTrust.js'
import { isBulbTrusted } from '../serve/trustStore.js'

/**
 * `typebulb predict [file]` — print the privileged capability a bulb probably needs WITHOUT running
 * it: the agent-side equivalent of claude.bulb's pre-launch trust probe (the launcher calls
 * `predictBulbTrust` before spawning; this is the same scan from the terminal). Lets an agent add
 * `--trust` up front, or report a bulb's needs without launching. Probabilistic, never a gate
 * (TB-Trust.md "Proactive prediction"): a clean result means "nothing obvious
 * spotted", never "safe" — the server-side gate is the only enforcement.
 */
export async function runPredict(bulbPath: string, trustHint: string): Promise<void> {
  const { bulb } = await readBulb(bulbPath)
  const cap = predictTrust(bulb)
  if (isBulbTrusted(bulbPath)) {
    console.log(`remembered-trusted — runs with filesystem / AI / server.ts automatically (\`typebulb untrust\` to revoke).`)
    if (cap) console.log(`  (it uses ${cap})`)
    return
  }
  if (cap) {
    console.log(`This bulb appears to use ${cap}; it runs Restricted unless you grant trust:`)
    console.log(`  ${trustHint}`)
  } else {
    console.log('No privileged capability detected — runs Restricted by default. (A clean scan is a hint, not a guarantee.)')
  }
}
