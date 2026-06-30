import { parseBulb, serializeBulb, kindFromPath, type BulbSource } from 'typebulb/format'
import { bareImportRoots } from 'typebulb/lint'

/**
 * Return `source` with every bare client import in `code.tsx` guaranteed a `config.json`
 * `dependencies` entry, deriving the missing ones. The version written is `"latest"` — exactly what the
 * import-driven resolver already CDN-resolves an *undeclared* import to (TB-Resolver.md), so this only
 * makes the existing resolution explicit; nothing about how the bulb runs changes.
 *
 * Used by `breakout` (agents/.../launcher.ts) so a promoted embed is a *correct, runnable* `.bulb.md`
 * even when the model that authored the embed omitted `config.json` (the GLM case). The embed render
 * path stays deliberately forgiving (render.ts runs the client lint *without* `dependencies`, so
 * UNDECLARED_IMPORT is dormant there), and the authored-config contract is satisfied here instead — at
 * the one moment a throwaway becomes a real file the local run / `check` will enforce against.
 *
 * Idempotent: a fully-declared bulb, or a non-bulb / code-less / import-less one, is returned
 * byte-for-byte unchanged (only an actual injection re-serializes).
 */
export function ensureDeclaredDependencies(source: string): string {
  const parsed = parseBulb(source)
  if (!parsed) return source
  const code = parsed.files.get('code.tsx')
  if (!code) return source
  const roots = bareImportRoots(code)
  if (!roots.length) return source

  const configRaw = parsed.files.get('config.json')
  let config: Record<string, unknown> = {}
  if (configRaw) {
    try { const p = JSON.parse(configRaw); if (p && typeof p === 'object') config = p } catch { /* malformed → rebuild clean */ }
  }
  const deps: Record<string, string> =
    config.dependencies && typeof config.dependencies === 'object'
      ? { ...(config.dependencies as Record<string, string>) }
      : {}

  const undeclared = roots.filter(root => !(root in deps))
  if (!undeclared.length) return source           // already fully declared — leave the bytes intact
  for (const root of undeclared) deps[root] = 'latest'
  config.dependencies = deps

  // Rebuild from the parsed blocks with the augmented config. Embeds are client-only, so there's no
  // server.ts to preserve — serializeBulb covers every format kind.
  const bulb: BulbSource = { name: parsed.frontmatter.name }
  for (const [filename, content] of parsed.files) {
    const kind = kindFromPath(filename)
    if (kind) (bulb as Record<string, string>)[kind] = content
  }
  bulb.config = JSON.stringify(config, null, 2)
  return serializeBulb(bulb)
}
