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

export type BulbSource = { name: string } & Partial<Record<SubscriptKind, string | null>>

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

/**
 * Replace one block's fence content in existing `.bulb.md` text, surgically — everything else
 * (frontmatter beyond format/name, inter-block prose, block order) is preserved verbatim, which a
 * parse→serialize round trip would lose. Appends the block at the end when absent. The fence grows
 * if the new content carries a longer backtick run; an unterminated block is left untouched (the
 * same defect parseBulb only warns on — rewriting inside it would guess at its extent).
 */
export function replaceBulbBlock(content: string, kind: SubscriptKind, newContent: string): string {
  const { path } = blocks[kind]
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]?.trim() !== `**${path}**`) continue
    let j = i + 1
    while (j < lines.length && lines[j]?.trim() === '') j++
    const m = lines[j]?.match(FENCE_OPEN_RE)
    if (!m) continue
    const closeRe = fenceCloseRe(m[1])
    let k = j + 1
    while (k < lines.length && !lines[k]?.match(closeRe)) k++
    // Unterminated fence: refuse to touch the file at all — rewriting inside it would guess at its
    // extent, and falling through to append would plant a duplicate block inside the open fence.
    if (k >= lines.length) return content
    const grown = getFence(newContent)
    const fence = grown.length > m[1].length ? grown : m[1]
    return [...lines.slice(0, j), fence + m[2], ...newContent.split('\n'), fence, ...lines.slice(k + 1)].join('\n')
  }
  return `${content.replace(/\s*$/, '')}\n\n${blockSection(kind, newContent)}\n`
}
