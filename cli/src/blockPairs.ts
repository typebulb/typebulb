/**
 * The `get`/`put` block-address grammar (TB-Get-Put.md): a block kind token (`get <file> <kind>`)
 * and the `<kind>=<source>` pair (`put <file> <kind>=<source>…`, `source` a path or `-` for stdin).
 *
 * The localOverride.ts pattern: this module owns the domain's types and throwing parsers; args.ts
 * catches at the flag boundary (print + exit), the command handlers consume the parsed values.
 */

import { orderedKinds, type SubscriptKind } from 'typebulb/format'

/** One `put` write: a block kind and its content source (a file path, or `-` for stdin). */
export interface BlockPair { kind: SubscriptKind; source: string }

/** Validate a block-kind token (`get`'s positional; each `put` pair's key). Throws naming the valid set. */
export function parseBlockKind(token: string): SubscriptKind {
  if (!(orderedKinds as readonly string[]).includes(token)) {
    throw new Error(`Unknown block kind '${token}' (one of: ${orderedKinds.join(', ')})`)
  }
  return token as SubscriptKind
}

/** Parse `put`'s `<kind>=<source>` pairs (split on the first `=`). Throws on a malformed pair, an
 *  unknown or duplicate kind, or a second stdin source — stdin holds one payload. */
export function parseBlockPairs(tokens: string[]): BlockPair[] {
  const pairs: BlockPair[] = []
  for (const token of tokens) {
    const eq = token.indexOf('=')
    if (eq <= 0 || eq === token.length - 1) {
      throw new Error(`Expected <kind>=<source>, got '${token}' (e.g. data=results.json, or data=- for stdin)`)
    }
    const kind = parseBlockKind(token.slice(0, eq))
    if (pairs.some((p) => p.kind === kind)) {
      throw new Error(`Duplicate block kind '${kind}' — each block can be written once per invocation`)
    }
    pairs.push({ kind, source: token.slice(eq + 1) })
  }
  if (pairs.filter((p) => p.source === '-').length > 1) {
    throw new Error('Only one <kind>=- can read stdin')
  }
  return pairs
}
