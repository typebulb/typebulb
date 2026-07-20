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

/** Where typebulb.com-hosted bulb assets serve from (TB-Assets-Push.md Invariant 1). */
export const HOSTED_ASSETS_ORIGIN = 'https://assets.typebulb.com'

/** The hosted-assets base derived from a bulb's identity (TB-Assets-Push.md Invariant 2:
 *  derived, never stored). An identity-less bulb has no remote base — it can't push either. */
export const hostedAssetsBase = (userSlug: string, slug: string) =>
  `${HOSTED_ASSETS_ORIGIN}/u/${encodeURIComponent(userSlug)}/${encodeURIComponent(slug)}/`

/** Lowercased final extension (`sub/née.PNG` → `.png`); undefined when there is none. */
const extOf = (p: string) => /\.[^./\\]+$/.exec(p)?.[0]?.toLowerCase()

/**
 * Content type for a served file, from its extension. `.wasm` must be `application/wasm`
 * for `WebAssembly.instantiateStreaming`; `.svg` must be `image/svg+xml` or an `<img>`
 * won't render it (no sniffing for SVG). Unknown extensions are `application/octet-stream`
 * — browsers download those, never render. Shared by the CLI's static routes (which serve
 * real `.js`: the mirror's bundled client, `--replace` dirs) and the API worker's asset PUT
 * — which derives the stored type from this table, never the upload header, and refuses
 * document/script extensions before consulting it, so the `.js`/`.css` rows are unreachable
 * on the hosted-asset path (TB-Assets-Push.md Invariant 9).
 */
export function contentTypeFor(filePath: string): string {
  switch (extOf(filePath)) {
    case '.js':
    case '.mjs': return 'text/javascript'
    case '.wasm': return 'application/wasm'
    case '.json':
    case '.map': return 'application/json'
    case '.svg': return 'image/svg+xml'
    case '.png': return 'image/png'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.gif': return 'image/gif'
    case '.webp': return 'image/webp'
    case '.avif': return 'image/avif'
    case '.ico': return 'image/x-icon'
    case '.mp3': return 'audio/mpeg'
    case '.wav': return 'audio/wav'
    case '.ogg': return 'audio/ogg'
    case '.m4a': return 'audio/mp4'
    case '.mp4': return 'video/mp4'
    case '.webm': return 'video/webm'
    case '.woff2': return 'font/woff2'
    case '.ttf': return 'font/ttf'
    case '.css': return 'text/css'
    case '.txt': return 'text/plain; charset=utf-8'
    default: return 'application/octet-stream'
  }
}

const FORBIDDEN_ASSET_EXTENSIONS = new Set(['.html', '.htm', '.xhtml', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.css'])

/** The offending extension when a path names browser code/markup — refused as an asset
 *  everywhere (the hosted PUT and the local `/assets/` route alike): a bulb's code and
 *  markup live in the bulb; assets are media and data (TB-Assets-Push.md Invariant 9).
 *  `undefined` for everything else — media, data, and unknown extensions all serve. */
export function forbiddenAssetExt(relpath: string): string | undefined {
  const ext = extOf(relpath)
  return ext !== undefined && FORBIDDEN_ASSET_EXTENSIONS.has(ext) ? ext : undefined
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
