/** Parse a `.bulb.md` file: strict Markdown bundle with YAML frontmatter and `**filename**` blocks. */

import { type SubscriptKind, blocks, orderedKinds, isBulbFormat } from './registry.js'
import { unescapeYamlString } from './yaml.js'

// The block grammar: a `**filename**` header on its own line, then a fenced code block (3+ backticks,
// optional language).
const BLOCK_HEADER_RE = /^\*\*(.+)\*\*$/
const FENCE_OPEN_RE = /^(`{3,})(\w*)\s*$/
const BLOCK_PATHS = new Set<string>(orderedKinds.map(k => blocks[k].path))

export interface BulbFrontmatter {
  format: string
  name: string
}

export interface ParsedBulb {
  frontmatter: BulbFrontmatter
  /** Block contents keyed by filename (e.g. `code.tsx`). */
  files: Map<string, string>
  /** Structural defects tolerated during parse (an unterminated fence); empty when well-formed. */
  warnings: string[]
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
    const warnings: string[] = []

    while (i < lines.length) {
      const line = lines[i]?.trim()

      // Look for **filename** (bold markdown, tolerant of whitespace)
      const fileMatch = line?.match(BLOCK_HEADER_RE)
      if (fileMatch) {
        const filename = fileMatch[1].trim()
        i++

        // Skip empty lines until fence
        while (i < lines.length && lines[i]?.trim() === '') i++

        // Parse fenced code block (tolerant of trailing whitespace)
        const fenceMatch = lines[i]?.match(FENCE_OPEN_RE)
        if (!fenceMatch) { i++; continue }

        const fence = fenceMatch[1]
        i++

        const contentLines: string[] = []
        while (i < lines.length && !lines[i]?.match(new RegExp(`^${fence}\\s*$`))) {
          contentLines.push(lines[i])
          i++
        }
        const terminated = i < lines.length
        i++ // Skip closing fence (no-op past EOF)

        warnings.push(...blockWarnings(filename, contentLines, terminated))
        files.set(filename, contentLines.join('\n'))
      } else {
        i++
      }
    }

    return { frontmatter, files, warnings }
  } catch {
    return null
  }
}

// Structural defects an unterminated fence causes, reported per block: it either swallows a later block
// (that block's header lands inside this body, followed by its own fence) or simply runs to EOF. The
// swallow is the more specific signal, so prefer it. Anchored to the block registry (the authoritative
// set of block names), so a `**name**` in prose isn't mistaken for a real block start.
function blockWarnings(filename: string, body: string[], terminated: boolean): string[] {
  const swallowed: string[] = []
  for (let j = 0; j < body.length; j++) {
    const m = body[j]?.trim().match(BLOCK_HEADER_RE)
    if (m && BLOCK_PATHS.has(m[1].trim()) && fenceFollows(body, j)) swallowed.push(m[1].trim())
  }
  if (swallowed.length) return swallowed.map(sw => `**${filename}** block has an unterminated code fence — it swallowed the **${sw}** block.`)
  if (!terminated) return [`**${filename}** block has an unterminated code fence (it runs to the end of the file).`]
  return []
}

// A `**name**` line is a genuine swallowed block start (not prose mentioning a filename) only when a
// fence opens right after it — the same header+fence shape parseBulb requires.
function fenceFollows(body: string[], headerIdx: number): boolean {
  let k = headerIdx + 1
  while (k < body.length && body[k]?.trim() === '') k++
  return !!body[k]?.match(FENCE_OPEN_RE)
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

/**
 * Structural problems parseBulb tolerates silently — chiefly an unterminated code fence, which makes
 * the blocks below it fall *inside* the open one. parseBulb still "succeeds" (it just produces wrong
 * blocks), so on its own a malformed bulb compiles and renders as if clean — the gap a caller needs
 * flagged. A thin read over parseBulb's own structural pass (same single walk, so the two can't drift);
 * `null` (not a bulb at all) has no fence warnings to report. Empty when well-formed; never throws.
 */
export function validateBulbStructure(content: string): string[] {
  return parseBulb(content)?.warnings ?? []
}

/** Convert a parsed bulb to a structured per-kind object (missing blocks become ''). */
export function toBulbData(parsed: ParsedBulb): BulbData {
  const kinds = Object.fromEntries(
    orderedKinds.map(kind => [kind, parsed.files.get(blocks[kind].path) || ''])
  ) as Record<SubscriptKind, string>
  return { name: parsed.frontmatter.name, ...kinds }
}
