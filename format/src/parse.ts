/** Parse a `.bulb.md` file: strict Markdown bundle with YAML frontmatter and `**filename**` blocks. */

import { type SubscriptKind, blocks, orderedKinds, isBulbFormat } from './registry.js'
import { unescapeYamlString } from './yaml.js'

// The block grammar: a `**filename**` header on its own line, then a fenced code block (3+ backticks,
// optional language). Exported so the surgical writer (serialize.ts replaceBulbBlock) shares this
// grammar rather than restating it — parse and replace must never disagree about what a fence is.
const BLOCK_HEADER_RE = /^\*\*(.+)\*\*$/
export const FENCE_OPEN_RE = /^(`{3,})(\w*)\s*$/
const BLOCK_PATHS = new Set<string>(orderedKinds.map(k => blocks[k].path))

/** The closing-fence test for a given opening fence (the fence chars alone, trailing whitespace ok). */
export const fenceCloseRe = (fence: string): RegExp => new RegExp(`^${fence}\\s*$`)

export interface BulbFrontmatter {
  format: string
  name: string
}

export interface ParsedBulb {
  frontmatter: BulbFrontmatter
  /** Block contents keyed by filename (e.g. `code.tsx`). */
  files: Map<string, string>
  /**
   * 1-based line number, in the `.bulb.md`, of each block's FIRST content line (the line after its
   * opening fence), keyed by filename. A bulb is a container: every tool inside it — tsc, lint, a
   * browser stack trace — reports block coordinates, while the only file the user can open and link
   * to is the bulb. This is the offset that maps one to the other (TB-CLI.md, One coordinate space).
   */
  starts: Map<string, number>
  /** Structural defects tolerated during parse (an unterminated fence); empty when well-formed. */
  warnings: string[]
  /**
   * Line index (0-based, into the parsed content's `split('\n')`) just past the last *captured* block's
   * closing fence — i.e. where the bulb's body ends. NOT end-of-content: trailing lines that set no block
   * (prose, a stray `---`) sit beyond it. Equals the line after the frontmatter when no block was captured.
   * Lets a caller slice a bulb out of surrounding prose without swallowing what follows it (see
   * `findUnfencedBulbs`).
   */
  bodyEndLine: number
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
    const starts = new Map<string, number>()
    const warnings: string[] = []
    // Where the body ends: bumped to the line past each captured block's closing fence. Starts at the
    // first line after the frontmatter, so a block-less bulb reports that.
    let bodyEndLine = i

    while (i < lines.length) {
      const line = lines[i]?.trim()

      // Look for **filename** (bold markdown, tolerant of whitespace)
      const fileMatch = line?.match(BLOCK_HEADER_RE)
      if (fileMatch) {
        const filename = fileMatch[1].trim()
        i++

        // Skip empty lines until fence
        while (i < lines.length && lines[i]?.trim() === '') i++

        // Parse fenced code block (tolerant of trailing whitespace). No fence: re-examine
        // the current line from the top of the loop — it may itself be the next block's
        // header, which an unconditional skip here would swallow (and every block after it).
        const fenceMatch = lines[i]?.match(FENCE_OPEN_RE)
        if (!fenceMatch) { warnings.push(`**${filename}** has no code fence — block skipped`); continue }

        const fence = fenceMatch[1]
        i++

        const startLine = i + 1   // 1-based: the first line inside the fence
        const contentLines: string[] = []
        const closeRe = fenceCloseRe(fence)
        while (i < lines.length && !lines[i]?.match(closeRe)) {
          contentLines.push(lines[i])
          i++
        }
        const terminated = i < lines.length
        i++ // Skip closing fence (no-op past EOF)

        warnings.push(...blockWarnings(filename, contentLines, terminated))
        files.set(filename, contentLines.join('\n'))
        starts.set(filename, startLine)
        bodyEndLine = i
      } else {
        i++
      }
    }

    return { frontmatter, files, warnings, bodyEndLine, starts }
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

/** A bulb found sitting "naked" in prose — frontmatter and blocks dumped straight into the text with no
 * enclosing ````bulb```` fence. `start`/`end` are the half-open `[start, end)` line range (0-based, into
 * `content.split('\n')`); `source` is that slice, ready to feed back to `parseBulb` or a renderer. */
export interface UnfencedBulb {
  start: number
  end: number
  source: string
}

/**
 * Find bulbs inline unfenced in arbitrary prose. The normal path wraps a bulb in a ````bulb```` fence
 * (and the mislabel-tolerant host promotes a fence whose body parses); but some non-SOTA models — Kimi
 * notably — skip the fence entirely and dump the raw frontmatter + blocks into the message, using `---`
 * thematic breaks as ad-hoc delimiters, so no fence token ever wraps the bulb. This scans for that.
 *
 * The frontmatter gate (`---\nformat: typebulb…`) is the same near-zero-false-positive signal the fenced
 * mislabel tolerance leans on, so we anchor on a `---` line, run `parseBulb` from there, and accept it
 * only if it yields at least one real block. The extent is `parseBulb`'s own `bodyEndLine` (just past the
 * last captured block) — NOT end-of-text — so trailing prose after the bulb (Kimi's closing `---`, a
 * follow-up paragraph) stays prose instead of being swallowed into the inline bulb. Returned spans are
 * non-overlapping and in document order; the caller slices the surrounding prose around them.
 */
export function findUnfencedBulbs(content: string): UnfencedBulb[] {
  const lines = content.split('\n')
  const found: UnfencedBulb[] = []
  let i = 0
  while (i < lines.length) {
    if (lines[i]?.trim() !== '---') { i++; continue }
    const parsed = parseBulb(lines.slice(i).join('\n'))
    // Require at least one captured block: a lone `---…---` frontmatter region with no blocks isn't a
    // renderable bulb (and `bodyEndLine` would be the frontmatter end — an empty slice).
    if (parsed && parsed.files.size > 0) {
      const end = i + parsed.bodyEndLine
      found.push({ start: i, end, source: lines.slice(i, end).join('\n') })
      i = end
    } else {
      i++
    }
  }
  return found
}

/** Convert a parsed bulb to a structured per-kind object (missing blocks become ''). */
export function toBulbData(parsed: ParsedBulb): BulbData {
  const kinds = Object.fromEntries(
    orderedKinds.map(kind => [kind, parsed.files.get(blocks[kind].path) || ''])
  ) as Record<SubscriptKind, string>
  return { name: parsed.frontmatter.name, ...kinds }
}
