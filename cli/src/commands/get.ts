import * as fs from 'fs/promises'
import { parseBulb, blocks, type SubscriptKind } from 'typebulb/format'

/**
 * `typebulb get <file> <kind>` — print one block's content to stdout (TB-Get-Put.md): the read half
 * of the block-I/O pair. stdout carries only the block body (one trailing newline) so `… | jq`
 * works; diagnostics go to stderr. No content — an absent block, or an empty one — exits 2, kept
 * machine-distinguishable from real errors (exit 1) so a probing script's "nothing there yet" never
 * reads as a typo'd path (`wait`'s exit-code convention). Empty and absent share one exit code
 * because the format holds them one state (`toBulbData`, `serializeBulb`, `pull`'s comparison);
 * the stderr line still tells a reader which spelling it found.
 */
export async function runGet(bulbPath: string, kind: SubscriptKind): Promise<void> {
  const content = await fs.readFile(bulbPath, 'utf-8')
  // Throws with the reason; main()'s handler prints `Error: <message>` and exits 1.
  const parsed = parseBulb(content)
  const path = blocks[kind].path
  const body = parsed.files.get(path)
  if (!body) {
    console.error(body === undefined
      ? `No **${path}** block in ${bulbPath}`
      : `The **${path}** block in ${bulbPath} is empty`)
    process.exit(2)
  }
  process.stdout.write(body.endsWith('\n') ? body : body + '\n')
}
