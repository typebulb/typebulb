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
  /** Base URL where the bulb's `assets/` folder is hosted when published (TB-Assets.md). */
  assets?: string
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

/** The `assets` base URL from a `config.json` string, normalized to a trailing slash —
 *  undefined when absent or not an http(s) URL (callers report the malformed case). */
export function assetsBase(config: string | null | undefined): string | undefined {
  const raw = parseConfig(config ?? '').assets?.trim()
  if (!raw) return undefined
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  } catch { return undefined }
  return raw.endsWith('/') ? raw : raw + '/'
}

/** Where typebulb.com-hosted bulb assets serve from (TB-Assets-Push.md Invariant 1). */
export const HOSTED_ASSETS_ORIGIN = 'https://assets.typebulb.com'

/** The hosted-assets base derived from a bulb's identity — the default when `config.json`
 *  has no `assets` key (TB-Assets-Push.md Invariant 2: derived, never stored). */
export const hostedAssetsBase = (userSlug: string, slug: string) =>
  `${HOSTED_ASSETS_ORIGIN}/u/${encodeURIComponent(userSlug)}/${encodeURIComponent(slug)}/`

/** The base a bulb's `assets/` resolves against remotely: the config key (self-host), else the
 *  hosted default when the bulb has an identity — else none (an identity-less bulb can't push). */
export const resolvedAssetsBase = (config: string | null | undefined, userSlug?: string, slug?: string) =>
  assetsBase(config) ?? (userSlug && slug ? hostedAssetsBase(userSlug, slug) : undefined)

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
