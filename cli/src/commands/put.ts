import * as fs from 'fs/promises'
import { parseBulb, replaceBulbBlock, removeBulbBlock, blocks, type SubscriptKind } from 'typebulb/format'
import type { BlockPair } from '../blockPairs.js'
import { readStdin, normalizeContent } from '../payload.js'

/**
 * `typebulb put <file> <kind>=<source>…` — write file (or stdin) content into a bulb's blocks,
 * surgically (TB-Get-Put.md): the terminal gesture over `replaceBulbBlock`, sibling to the infer
 * modal's Save-to-bulb. Upsert (replace in place, append when absent), atomic across pairs (one
 * read → every replacement in memory → one write), and a no-op when nothing changed — a
 * byte-identical rewrite would still bump mtime and spuriously hot-reload a served bulb. An empty
 * source **removes** the block: the format holds empty === absent everywhere (`toBulbData`,
 * `serializeBulb`, `pull`'s comparison), so removal is that state's canonical spelling, and it is
 * the only way to clear block clutter.
 * Trust-free: editing your own file at your own command is the editor tier. Payload sanity is the
 * caller's — an invalid source file is written verbatim, by design.
 */
export async function runPut(bulbPath: string, pairs: BlockPair[]): Promise<void> {
  const original = await fs.readFile(bulbPath, 'utf-8')

  const puts: ResolvedPut[] = []
  for (const { kind, source } of pairs) {
    let raw: string
    try {
      raw = source === '-' ? await readStdin() : await fs.readFile(source, 'utf-8')
    } catch (e) {
      fail(`Cannot read ${kind}'s source: ${e instanceof Error ? e.message : String(e)}`)
    }
    puts.push({ kind, content: normalizeContent(raw), label: source === '-' ? 'stdin' : source })
  }

  let outcome: PutOutcome
  try {
    outcome = applyPuts(original, puts)
  } catch (e) {
    fail(`${bulbPath}: ${e instanceof Error ? e.message : String(e)}`)
  }

  for (const kind of outcome.upToDate) console.log(`${blocks[kind].path}: already up to date`)
  if (!outcome.written.length) return

  await fs.writeFile(bulbPath, outcome.text)
  for (const w of outcome.written) {
    console.log(w.action === 'removed'
      ? `${blocks[w.kind].path}: removed (${w.label} is empty)`
      : `${blocks[w.kind].path}: ${w.action} from ${w.label} (${w.chars.toLocaleString()} chars)`)
  }
}

/** One resolved write: the target kind and its normalized content (`label` names the source in reports). */
export interface ResolvedPut { kind: SubscriptKind; content: string; label?: string }

export interface PutOutcome {
  text: string
  written: { kind: SubscriptKind; action: 'replaced' | 'created' | 'removed'; chars: number; label?: string }[]
  upToDate: SubscriptKind[]
}

/**
 * The pure core, all-or-nothing: apply every put to the bulb text in memory, or throw — a non-bulb,
 * or an unterminated target fence (the one refusal the primitives signal by returning their input,
 * told apart from the deliberate up-to-date no-op by checking the current block first).
 * The comparison normalizes both sides, so a line-ending-only difference is a no-op, not a rewrite.
 */
export function applyPuts(original: string, puts: ResolvedPut[]): PutOutcome {
  const parsed = parseBulb(original)
  let text = original
  const written: PutOutcome['written'] = []
  const upToDate: SubscriptKind[] = []
  for (const { kind, content, label } of puts) {
    const path = blocks[kind].path
    const current = parsed.files.get(path)
    // Empty content means "no content", and the format spells that as an absent block — so remove
    // it. Nothing is lost that wasn't already empty, and a bulb that never had the block is
    // already in the requested state.
    if (!content) {
      if (current === undefined) { upToDate.push(kind); continue }
      text = refuseIfUnchanged(removeBulbBlock(text, kind), text, path)
      written.push({ kind, action: 'removed', chars: 0, label })
      continue
    }
    if (current !== undefined && normalizeContent(current) === content) {
      upToDate.push(kind)
      continue
    }
    text = refuseIfUnchanged(replaceBulbBlock(text, kind, content), text, path)
    written.push({ kind, action: current === undefined ? 'created' : 'replaced', chars: content.length, label })
  }
  return { text, written, upToDate }
}

/** A primitive that returns its input has hit the one defect it refuses to guess at. */
function refuseIfUnchanged(next: string, previous: string, path: string): string {
  if (next === previous) throw new Error(`the **${path}** block's fence is unterminated; refusing to rewrite inside it`)
  return next
}

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}
