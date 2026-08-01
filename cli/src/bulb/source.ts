/**
 * Pure bulb-source helpers — name extraction, slugging, frontmatter stripping.
 * Isomorphic (no node builtins), so both the browser `.` entry and the node
 * `./servers` entry re-export them. Every host that writes/launches/inline bulbs bulbs
 * re-derives these from the leading `---` frontmatter, so they're a capability,
 * not host code.
 */

import { slugify } from 'typebulb/format'

/** The bulb's `name:` from its leading frontmatter, or undefined if absent.
 *  Tolerant (doesn't require a valid `format:`) so a malformed bulb still names. */
export function bulbName(source: string): string | undefined {
  const fm = /^---[^\n]*\n([\s\S]*?)\n---/.exec(source)
  const nameLine = fm ? /^\s*name:\s*(.+?)\s*$/m.exec(fm[1]) : null
  return nameLine ? nameLine[1].replace(/^["']|["']$/g, '') : undefined
}

/** A filesystem-safe slug from the bulb's name; 'bulb' when unnamed or unslugifiable. */
export function slugifyBulbName(source: string): string {
  return slugify(bulbName(source) ?? 'bulb') || 'bulb'
}

/** The source with its leading `---` frontmatter block stripped (and the blank
 *  lines after it), leaving the file-section body. No-op without frontmatter. */
export function stripFrontmatter(source: string): string {
  return source.replace(/^---[^\n]*\r?\n[\s\S]*?\r?\n---[^\n]*\r?\n?/, '').replace(/^\r?\n+/, '')
}
