/**
 * The public model catalog and its key-based filter — the single source of truth shared by the
 * server's `/__models` route (which backs `tb.models()` in a running bulb) and the `typebulb models`
 * CLI command (authoring-time discovery, runtime-specs/TB-AI.md §"tb.models() Runtime Contexts"). Both
 * fetch the same admin-curated catalog and keep only the models whose provider has an API key in
 * the environment, so an agent's terminal list and a bulb's runtime list never diverge.
 */
import type { ProviderProtocol, TbModelDto } from 'typebulb/ai'

/** Maps provider protocols to their env var key names. Partial: keyless providers (ollama,
 *  which runs locally) are absent, so they never appear in key-filtered catalog discovery. */
export const PROVIDER_ENV_KEYS: Partial<Record<ProviderProtocol, string>> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GOOGLE_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
}

/** Normalize an OLLAMA_HOST value into a clean origin: Ollama accepts a scheme-less
 *  `localhost:11434`, so prepend `http://` when there's no `://`, and strip any trailing slash so a
 *  caller appending a path (e.g. `/v1`) can't produce a `//`. Shared by the chat-URL resolver
 *  (`resolveLocalProvider`) and the `/api/tags` discovery probe below. */
export function normalizeOllamaHost(host: string): string {
  const withScheme = host.includes('://') ? host : `http://${host}`
  return withScheme.replace(/\/+$/, '')
}

const CATALOG_URL = 'https://api.typebulb.com/api/models'
const CATALOG_TTL = 24 * 60 * 60 * 1000 // 24 hours
const CATALOG_TIMEOUT = 5000 // bound a single fetch so a hung upstream can't stall the menu
const OLLAMA_TTL = 60 * 1000 // local models change rarely; cache so repeated menu opens don't re-probe
let catalogCache: { models: TbModelDto[]; fetchedAt: number } | null = null
let ollamaCache: { models: TbModelDto[]; fetchedAt: number } | null = null
// The last catalog-fetch failure, or null after any success — lets a caller tell an empty list from
// a failed fetch (both otherwise yield no models).
let lastCatalogError: string | null = null

/** The most recent catalog-fetch failure message, or null if the last fetch succeeded. */
export function catalogFetchError(): string | null { return lastCatalogError }

/** The key-filtered cloud catalog plus locally-discovered Ollama models. The two are independent
 *  I/O (remote catalog vs local probe), so they run concurrently. Degrades gracefully: a stale
 *  cache (or `[]`) on a failed catalog refresh; Ollama probing never throws. */
export async function getFilteredModels(): Promise<TbModelDto[]> {
  const [ollama, catalog] = await Promise.all([getOllamaModels(), getCatalogModels()])
  return markDefault([...filterByLocalKeys(catalog), ...ollama], process.env.TB_AI_PROVIDER, process.env.TB_AI_MODEL)
}

/** Flag the row matching the configured default pair — both must be set, same rule as
 *  `formatModelsList`'s footer. Copies the match: catalog rows are cached, never mutated. */
export function markDefault(models: TbModelDto[], defaultProvider?: string, defaultModel?: string): TbModelDto[] {
  if (!defaultProvider || !defaultModel) return models
  return models.map(m => m.provider === defaultProvider && m.name === defaultModel ? { ...m, default: true } : m)
}

/** One bounded catalog fetch. Returns the parsed models, or null on any failure — network, non-2xx,
 *  or a 200 whose body isn't valid JSON (a redeploy can serve an HTML error page, so guard the
 *  parse). Records the reason in `lastCatalogError`. */
async function fetchCatalogOnce(): Promise<TbModelDto[] | null> {
  let resp: Response
  try {
    resp = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(CATALOG_TIMEOUT) })
  } catch (e) { lastCatalogError = `catalog fetch failed: ${(e as Error)?.message ?? e}`; return null }
  if (!resp.ok) { lastCatalogError = `catalog fetch failed: HTTP ${resp.status}`; return null }
  try { return await resp.json() as TbModelDto[] }
  catch (e) { lastCatalogError = `catalog returned an unreadable body: ${(e as Error)?.message ?? e}`; return null }
}

/** The admin catalog, in-memory cached with a TTL. Bounded fetch + one quick retry rides out a
 *  deploy blip; on hard failure returns the stale cache (or `[]`) so a transient outage doesn't
 *  empty the list, leaving `lastCatalogError` set for the caller to surface. */
async function getCatalogModels(): Promise<TbModelDto[]> {
  if (catalogCache && Date.now() - catalogCache.fetchedAt <= CATALOG_TTL) return catalogCache.models
  const models = (await fetchCatalogOnce()) ?? (await fetchCatalogOnce())
  if (models) { catalogCache = { models, fetchedAt: Date.now() }; lastCatalogError = null; return models }
  return catalogCache?.models ?? []
}

/** Probe a local Ollama server for its installed models (CLI-only, best-effort), cached with a
 *  short TTL so the frequently-hit model list (e.g. a switcher menu reopening, which doesn't even
 *  use Ollama) doesn't re-probe every call. Returns `[]` if Ollama isn't running or the host is
 *  unreachable — never throws, never blocks discovery. The default host is probed even without
 *  OLLAMA_HOST so local setups just work; a connection-refused on loopback is fast. */
async function getOllamaModels(): Promise<TbModelDto[]> {
  if (ollamaCache && Date.now() - ollamaCache.fetchedAt <= OLLAMA_TTL) return ollamaCache.models
  const host = normalizeOllamaHost(process.env.OLLAMA_HOST ?? 'http://localhost:11434')
  let models: TbModelDto[] = []
  try {
    const resp = await fetch(new URL('/api/tags', host).toString())
    if (resp.ok) {
      const data = await resp.json() as { models?: Array<{ name?: string }> }
      models = (data.models ?? [])
        .map(m => m.name)
        .filter((name): name is string => !!name)
        .map(name => ({ provider: 'ollama', name, friendlyName: name, providerName: 'Ollama' }))
    }
  } catch { /* Ollama not running / unreachable — leave the list empty */ }
  ollamaCache = { models, fetchedAt: Date.now() }
  return models
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

/** Backs `tb.hasOwnKeys()` in the CLI: is tb.ai backed by the user's own AI? True on any provider
 *  key in the env, a configured openai-compat endpoint, or a reachable Ollama server — the keyless
 *  setups are still the user's own AI, which is what the flag asks. Only probes Ollama (cached)
 *  when nothing cheaper answers. */
export async function hasOwnKeys(): Promise<boolean> {
  if (hasAnyProviderKey() || !!process.env.TB_AI_BASE_URL) return true
  return (await getOllamaModels()).length > 0
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
