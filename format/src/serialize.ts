/** Serialize a bulb's blocks back into `.bulb.md` text. */

import { type SubscriptKind, blocks, orderedKinds, BULB_FORMAT } from './registry.js'
import { escapeYamlString } from './yaml.js'

/** A fence long enough not to collide with any run of backticks already in the content. */
function getFence(content: string): string {
  const match = content.match(/^`{3,}/gm)
  const maxLen = match ? Math.max(...match.map(m => m.length)) : 0
  return '`'.repeat(Math.max(3, maxLen + 1))
}

export type BulbSource = { name: string } & Partial<Record<SubscriptKind, string | null>>

/** Serialize a bulb to `.bulb.md` text: YAML frontmatter then one `**filename**` block per present kind. */
export function serializeBulb(source: BulbSource): string {
  const sections = orderedKinds
    .filter(kind => source[kind])
    .map(kind => {
      const { path } = blocks[kind]
      const content = source[kind]!
      const lang = path.split('.').pop()!
      const fence = getFence(content)
      return `**${path}**\n\n${fence}${lang}\n${content}\n${fence}`
    })

  return [
    '---',
    `format: ${BULB_FORMAT}`,
    `name: ${escapeYamlString(source.name)}`,
    '---',
    '',
    ...sections,
  ].join('\n')
}
