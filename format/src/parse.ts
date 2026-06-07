/** Parse a `.bulb.md` file: strict Markdown bundle with YAML frontmatter and `**filename**` blocks. */

import { type SubscriptKind, blocks, orderedKinds, isBulbFormat } from './registry.js'
import { unescapeYamlString } from './yaml.js'

export interface BulbFrontmatter {
  format: string
  name: string
}

export interface ParsedBulb {
  frontmatter: BulbFrontmatter
  /** Block contents keyed by filename (e.g. `code.tsx`). */
  files: Map<string, string>
}

/** Structured per-block content, keyed by kind. */
export type BulbData = { name: string } & Record<SubscriptKind, string>

/** Parse a `.bulb.md` file into frontmatter and file contents, or null if malformed. */
export function parseBulb(content: string): ParsedBulb | null {
  try {
    const lines = content.split('\n')
    let i = 0

    // Parse frontmatter
    if (lines[i]?.trim() !== '---') return null
    i++

    const frontmatterLines: string[] = []
    while (i < lines.length && lines[i]?.trim() !== '---') {
      frontmatterLines.push(lines[i])
      i++
    }
    if (lines[i]?.trim() !== '---') return null
    i++

    const frontmatter = parseFrontmatter(frontmatterLines)
    if (!frontmatter) return null

    // Parse file sections
    const files = new Map<string, string>()

    while (i < lines.length) {
      const line = lines[i]?.trim()

      // Look for **filename** (bold markdown, tolerant of whitespace)
      const fileMatch = line?.match(/^\*\*(.+)\*\*$/)
      if (fileMatch) {
        const filename = fileMatch[1].trim()
        i++

        // Skip empty lines until fence
        while (i < lines.length && lines[i]?.trim() === '') i++

        // Parse fenced code block (tolerant of trailing whitespace)
        const fenceMatch = lines[i]?.match(/^(`{3,})(\w*)\s*$/)
        if (!fenceMatch) { i++; continue }

        const fence = fenceMatch[1]
        i++

        const contentLines: string[] = []
        while (i < lines.length && !lines[i]?.match(new RegExp(`^${fence}\\s*$`))) {
          contentLines.push(lines[i])
          i++
        }
        i++ // Skip closing fence

        files.set(filename, contentLines.join('\n'))
      } else {
        i++
      }
    }

    return { frontmatter, files }
  } catch {
    return null
  }
}

function parseFrontmatter(lines: string[]): BulbFrontmatter | null {
  const fm: Partial<BulbFrontmatter> = {}

  for (const line of lines) {
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue

    const key = line.slice(0, colonIdx).trim()
    const value = line.slice(colonIdx + 1).trim()

    switch (key) {
      case 'format': fm.format = value; break
      case 'name': fm.name = unescapeYamlString(value); break
    }
  }

  if (!isBulbFormat(fm.format) || !fm.name) return null
  return fm as BulbFrontmatter
}

/** Convert a parsed bulb to a structured per-kind object (missing blocks become ''). */
export function toBulbData(parsed: ParsedBulb): BulbData {
  const kinds = Object.fromEntries(
    orderedKinds.map(kind => [kind, parsed.files.get(blocks[kind].path) || ''])
  ) as Record<SubscriptKind, string>
  return { name: parsed.frontmatter.name, ...kinds }
}
