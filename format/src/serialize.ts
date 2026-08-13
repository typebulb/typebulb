/** Serialize a bulb's blocks back into `.bulb.md` text. */

import { type SubscriptKind, blocks, orderedKinds, BULB_FORMAT } from './registry.js'
import { FENCE_OPEN_RE, fenceCloseRe } from './parse.js'
import { escapeYamlString } from './yaml.js'

/** A fence long enough not to collide with any run of backticks already in the content. */
function getFence(content: string): string {
  const match = content.match(/^`{3,}/gm)
  const maxLen = match ? Math.max(...match.map(m => m.length)) : 0
  return '`'.repeat(Math.max(3, maxLen + 1))
}

export type BulbSource = { name: string } & Partial<Record<SubscriptKind, string>>

/** One `**path**` block section: header + fenced content, fence sized to the content. */
function blockSection(kind: SubscriptKind, content: string): string {
  const { path } = blocks[kind]
  const lang = path.split('.').pop()!
  const fence = getFence(content)
  return `**${path}**\n\n${fence}${lang}\n${content}\n${fence}`
}

/** Serialize a bulb to `.bulb.md` text: YAML frontmatter then one `**filename**` block per present kind. */
export function serializeBulb(source: BulbSource): string {
  const sections = orderedKinds
    .filter(kind => source[kind])
    .map(kind => blockSection(kind, source[kind]!))

  return [
    '---',
    `format: ${BULB_FORMAT}`,
    `name: ${escapeYamlString(source.name)}`,
    '---',
    '',
    ...sections,
  ].join('\n')
}

/** Where one block sits in split `.bulb.md` lines, and how its fence is written. */
type BlockSpan = { header: number; open: number; close: number; fence: string; lang: string }

/**
 * Locate a block for surgical rewriting: `'unterminated'` when its fence never closes — the defect
 * parseBulb only warns on, which neither writer may touch (rewriting inside it would guess at its
 * extent, and appending past it would plant a block inside the open fence) — and `null` when the
 * block is simply absent, which each writer answers its own way.
 */
function locateBlock(lines: string[], path: string): BlockSpan | 'unterminated' | undefined {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]?.trim() !== `**${path}**`) continue
    let open = i + 1
    while (open < lines.length && lines[open]?.trim() === '') open++
    const m = lines[open]?.match(FENCE_OPEN_RE)
    if (!m) continue
    const closeRe = fenceCloseRe(m[1])
    let close = open + 1
    while (close < lines.length && !lines[close]?.match(closeRe)) close++
    if (close >= lines.length) return 'unterminated'
    return { header: i, open, close, fence: m[1], lang: m[2] }
  }
  return undefined
}

/**
 * Replace one block's fence content in existing `.bulb.md` text, surgically — everything else
 * (frontmatter beyond format/name, inter-block prose, block order) is preserved verbatim, which a
 * parse→serialize round trip would lose. Appends the block at the end when absent. The fence grows
 * if the new content carries a longer backtick run; an unterminated block is left untouched.
 */
export function replaceBulbBlock(content: string, kind: SubscriptKind, newContent: string): string {
  const lines = content.split('\n')
  const span = locateBlock(lines, blocks[kind].path)
  if (span === 'unterminated') return content
  if (!span) return `${content.replace(/\s*$/, '')}\n\n${blockSection(kind, newContent)}\n`

  const grown = getFence(newContent)
  const fence = grown.length > span.fence.length ? grown : span.fence
  return [
    ...lines.slice(0, span.open),
    fence + span.lang,
    ...newContent.split('\n'),
    fence,
    ...lines.slice(span.close + 1),
  ].join('\n')
}

/**
 * Remove one block — header, fence, and content — from existing `.bulb.md` text, surgically: the
 * deletion counterpart of `replaceBulbBlock`, preserving everything else verbatim. The blank run
 * that separated the block from what follows goes with it, so removal leaves no gap. An absent or
 * unterminated block returns the input unchanged (a caller tells the two apart by checking presence
 * first, as `typebulb put` does).
 */
export function removeBulbBlock(content: string, kind: SubscriptKind): string {
  const lines = content.split('\n')
  const span = locateBlock(lines, blocks[kind].path)
  if (!span || span === 'unterminated') return content

  let end = span.close + 1
  while (end < lines.length && lines[end]?.trim() === '') end++
  return [...lines.slice(0, span.header), ...lines.slice(end)].join('\n').replace(/\s*$/, '') + '\n'
}
