/**
 * Structural data-format detection for the `data.txt` block. The single source of truth for "is this
 * chunk JSON / XML / YAML", shared by the data-chunk splitter (here) and typebulb.com's summarizer
 * selection (its JSON/XML/YAML summarizers' `canHandle` delegate to these).
 */

import { findTagByName } from 'xml-utils'
import * as yaml from 'yaml'

const XML_TAG_RE = /<([a-zA-Z_][\w.-]*)/

export function isJsonData(content: string): boolean {
  try { JSON.parse(content.trim()); return true } catch { return false }
}

export function isXmlData(content: string): boolean {
  const t = content.trim()
  if (!t.startsWith('<')) return false
  const m = t.match(XML_TAG_RE)
  return m ? findTagByName(t, m[1]) !== null : false
}

export function isYamlData(content: string): boolean {
  const trimmed = content.trim()
  if (!trimmed.match(/^(---|#|\w+:|-)/)) return false
  if ('[{<'.includes(trimmed[0])) return false
  try {
    const parsed = yaml.parse(trimmed)
    return parsed !== null && typeof parsed === 'object'
  } catch { return false }
}

/** True if content is a structural format (JSON/XML/YAML) — kept as a single data chunk. */
export function isStructuralData(content: string): boolean {
  return isJsonData(content) || isXmlData(content) || isYamlData(content)
}
