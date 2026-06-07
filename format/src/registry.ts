/**
 * The canonical bulb block registry — the single source of truth for what blocks a bulb has,
 * their filenames, and their languages. Both the typebulb CLI and the typebulb.com editor derive
 * their block handling from this; the editor extends each entry with its own presentation fields.
 *
 * `server.ts` is intentionally not here: it is a CLI-only block (local Node code), owned by the CLI.
 */

export type SubscriptKind = 'code' | 'css' | 'html' | 'config' | 'notes' | 'data' | 'infer' | 'insight'

export type SubscriptPath =
  | 'code.tsx' | 'index.html' | 'styles.css' | 'config.json'
  | 'notes.md' | 'data.txt' | 'infer.md' | 'insight.json'

export interface BlockSpec {
  path: SubscriptPath
  language: string
}

export const blocks: Record<SubscriptKind, BlockSpec> = {
  code: { path: 'code.tsx', language: 'typescript' },
  css: { path: 'styles.css', language: 'css' },
  html: { path: 'index.html', language: 'html' },
  config: { path: 'config.json', language: 'json' },
  notes: { path: 'notes.md', language: 'markdown' },
  data: { path: 'data.txt', language: 'text' },
  infer: { path: 'infer.md', language: 'markdown' },
  insight: { path: 'insight.json', language: 'json' },
}

/** Block order as serialized in a `.bulb.md` file. */
export const orderedKinds: SubscriptKind[] = ['code', 'css', 'html', 'data', 'infer', 'insight', 'config', 'notes']

/** Look up the kind that owns a given filename (e.g. `code.tsx` → `code`). */
export function kindFromPath(path: string): SubscriptKind | undefined {
  return orderedKinds.find(kind => blocks[kind].path === path)
}

/** Bulb file format identifier (YAML frontmatter `format:`) and file extension. */
export const BULB_FORMAT = 'typebulb/v1'
export const BULB_EXT = '.bulb.md'

/** A bulb's frontmatter `format:` value is recognised iff it starts with `typebulb`. */
export function isBulbFormat(format: string | undefined): boolean {
  return !!format?.startsWith('typebulb')
}
