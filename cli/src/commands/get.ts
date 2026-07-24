import * as fs from 'fs/promises'
import { parseBulb, blocks, type SubscriptKind } from 'typebulb/format'

/**
 * `typebulb get <file> <kind>` — print one block's content to stdout (TB-Get-Put.md): the read half
 * of the block-I/O pair. stdout carries only the block body (one trailing newline) so `… | jq`
 * works; diagnostics go to stderr. An absent block exits 2 — the GET-404 half of the deliberate
 * asymmetry with `put`'s upsert, kept machine-distinguishable from real errors (exit 1) so a
 * probing script's "no data yet" never reads as a typo'd path (`wait`'s exit-code convention).
 */
export async function runGet(bulbPath: string, kind: SubscriptKind): Promise<void> {
  const content = await fs.readFile(bulbPath, 'utf-8')
  const parsed = parseBulb(content)
  if (!parsed) {
    console.error(`Not a valid bulb: ${bulbPath}`)
    process.exit(1)
  }
  const path = blocks[kind].path
  const body = parsed.files.get(path)
  if (body === undefined) {
    console.error(`No **${path}** block in ${bulbPath}`)
    process.exit(2)
  }
  if (body.length) process.stdout.write(body.endsWith('\n') ? body : body + '\n')
}
