/** The `config.json` block shape — dependencies, description, and inference-modal settings. */

export interface InferenceConfig {
  title?: string
  dataTitle?: string  // Comma-delimited for multiple chunks
  submitTitle?: string
}

export interface BulbConfig {
  dependencies?: Record<string, string>
  description?: string
  inference?: InferenceConfig
  ts?: { jsxImportSource?: string }
}

/** Parse the `config.json` block, returning {} for empty or malformed JSON. */
export function parseConfig(config: string): BulbConfig {
  if (!config.trim()) return {}
  try {
    return JSON.parse(config)
  } catch {
    return {}
  }
}

const DEFAULT_DESCRIPTION = 'A Typebulb bulb.'

/** Strip inline markdown (links, emphasis, code, headings) for plain-text contexts like meta descriptions. */
export function stripMarkdown(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
}

/** Plain-text description from a `config.json` string: markdown stripped, single line, ≤200 chars.
 * Logic duplicated in client/_worker.js (edge runtime, no build step). */
export function extractDescription(config: string | undefined): string {
  const desc = parseConfig(config ?? '').description?.trim()
  if (!desc) return DEFAULT_DESCRIPTION
  const stripped = stripMarkdown(desc)
  const truncated = stripped.length > 200 ? stripped.slice(0, 197) + '...' : stripped
  return truncated.replace(/\n/g, ' ')
}
