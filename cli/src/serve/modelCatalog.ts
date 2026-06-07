/**
 * The public model catalog and its key-based filter — the single source of truth shared by the
 * server's `/__models` route (which backs `tb.models()` in a running bulb) and the `typebulb models`
 * CLI command (authoring-time discovery, Specs/TB-AI.md §"tb.models() Runtime Contexts"). Both
 * fetch the same admin-curated catalog and keep only the models whose provider has an API key in
 * the environment, so an agent's terminal list and a bulb's runtime list never diverge.
 */
import type { ProviderProtocol, TbModelDto } from 'typebulb/ai'

/** Maps provider protocols to their env var key names. */
export const PROVIDER_ENV_KEYS: Record<ProviderProtocol, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GOOGLE_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
}

const CATALOG_URL = 'https://api.typebulb.com/api/models'
const CATALOG_TTL = 24 * 60 * 60 * 1000 // 24 hours
let catalogCache: { models: TbModelDto[]; fetchedAt: number } | null = null

/** Fetch the catalog (in-memory cached, TTL) and keep only models whose provider has a key in
 *  env. Degrades gracefully: stale cache on a failed refresh, or `[]` on a cold fetch failure. */
export async function getFilteredModels(): Promise<TbModelDto[]> {
  if (!catalogCache || Date.now() - catalogCache.fetchedAt > CATALOG_TTL) {
    const resp = await fetch(CATALOG_URL)
    if (!resp.ok) {
      if (catalogCache) return filterByLocalKeys(catalogCache.models) // stale cache fallback
      return []
    }
    catalogCache = { models: await resp.json(), fetchedAt: Date.now() }
  }
  return filterByLocalKeys(catalogCache.models)
}

function filterByLocalKeys(models: TbModelDto[]): TbModelDto[] {
  // Only return models whose provider has an API key in env
  const availableProviders = new Set(
    (Object.entries(PROVIDER_ENV_KEYS) as [ProviderProtocol, string][])
      .filter(([, envKey]) => !!process.env[envKey])
      .map(([protocol]) => protocol)
  )
  return models.filter(m => availableProviders.has(m.provider as ProviderProtocol))
}

/** True if any provider's API-key env var is set. Lets a caller distinguish "no keys at all"
 *  (tell the user what to set) from "keys present but the catalog was unreachable" (empty list). */
export function hasAnyProviderKey(): boolean {
  return Object.values(PROVIDER_ENV_KEYS).some(k => !!process.env[k])
}

/** Render the filtered catalog as a terminal list: each model's exact id (what you pass as
 *  `tb.ai`'s `model`), its friendly name, and provider, id-first so a line is greppable. The
 *  configured default (TB_AI_PROVIDER / TB_AI_MODEL) is noted below when both are set. Pure (no
 *  env reads, no I/O) so it is unit-testable. */
export function formatModelsList(models: TbModelDto[], defaultProvider?: string, defaultModel?: string): string {
  const idWidth = Math.max(...models.map(m => m.name.length))
  const nameWidth = Math.max(...models.map(m => m.friendlyName.length))
  const lines = ['Models available to tb.ai (filtered by your .env keys):', '']
  for (const m of models) {
    lines.push(`  ${m.name.padEnd(idWidth)}  ${m.friendlyName.padEnd(nameWidth)}  (${m.provider})`)
  }
  lines.push('', 'Pass an id as the `model` in tb.ai({ provider, model }).')
  if (defaultProvider && defaultModel) lines.push(`Default (from .env): ${defaultProvider} / ${defaultModel}`)
  return lines.join('\n')
}
