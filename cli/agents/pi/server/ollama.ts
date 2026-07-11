/**
 * The /model palette's local-Ollama assist (TB-Agent-Composer-Toolkit.md Piece 5). pi has no model
 * auto-discovery — a local model exists only if the user hand-authors `~/.pi/agent/models.json`
 * (pi's docs/models.md) — while typebulb discovers installed Ollama models with one `/api/tags`
 * probe. This bridges the two on an explicit gesture: `/model` offers a sync row when Ollama has
 * installed models the file's `ollama` block lacks (first-time setup is just the empty-block case),
 * and confirming rewrites that block to exactly what's installed — pi's documented provider shape —
 * preserving everything else in the file. The gesture-gated settings write is the Claude switcher's
 * license (TB-Agent-Mirror.md Invariant 1).
 *
 * Sync is deliberately a CLOBBER of the ollama block, not a merge: one operation for setup and
 * update alike, no add/remove bookkeeping, no remembering what typebulb wrote. The offer triggers
 * only on installed-but-unconfigured models, so a user who prunes the list by hand is never nagged
 * by pruning alone — curate instead of sync, the block is yours like the rest of the file. The one
 * hard refusal: a file we can't round-trip (pi strips JSON comments before parsing; we won't
 * rewrite what a strict parse can't preserve). These are mirror RPCs on the pi barrel (tb.server),
 * not composerRpc passthroughs — they talk to typebulb's side, not to pi.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import * as path from 'path'
import { errorMessage } from '../../core/server/context.js'
import { normalizeOllamaHost } from '../../../src/servers.js'

// Loopback answers in single-digit ms; this only bounds a firewalled/remote OLLAMA_HOST so a bad
// host can't stall the /model open it rides alongside.
const PROBE_TIMEOUT_MS = 1500

const modelsJsonPath = () => path.join(homedir(), '.pi', 'agent', 'models.json')
const ollamaHost = () => normalizeOllamaHost(process.env.OLLAMA_HOST ?? 'http://localhost:11434')

/** Installed model names off `/api/tags`; `[]` when Ollama is down/unreachable — never throws. */
async function probeOllama(): Promise<string[]> {
  try {
    const resp = await fetch(new URL('/api/tags', ollamaHost()).toString(), { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    if (!resp.ok) return []
    const data = await resp.json() as { models?: { name?: string }[] }
    return (data.models ?? []).map(m => m.name).filter((n): n is string => !!n)
  } catch { return [] }
}

// The current models.json, distinguishing "absent" (a fresh write is safe) from "unreadable"
// (hands off — the one refusal, shared by offer and write). Comments are pi-legal (it strips them
// before parsing) but not round-trippable by a strict parse, and a `providers` that isn't an
// object is not ours to fix — both land in `unreadable`, the conservative side.
function readModelsJson(file: string): { json: Record<string, unknown> | undefined; unreadable: boolean } {
  let content: string
  try { content = readFileSync(file, 'utf-8') } catch { return { json: undefined, unreadable: false } }
  try {
    const json = JSON.parse(content) as unknown
    if (json && typeof json === 'object' && !Array.isArray(json)) {
      const j = json as Record<string, unknown>
      return { json: j, unreadable: 'providers' in j && !providersOf(j) }
    }
  } catch { /* fall through */ }
  return { json: undefined, unreadable: true }
}

// `providers` as pi's schema shapes it (an object), or undefined; anything else is not ours to fix.
function providersOf(json: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const p = json?.providers
  return p && typeof p === 'object' && !Array.isArray(p) ? p as Record<string, unknown> : undefined
}

// The ids in the file's ollama block; null = no ollama provider at all (the first-time case).
// A present-but-mangled block reads as `[]` — present, so sync (which clobbers it) may repair it.
function configuredIds(json: Record<string, unknown> | undefined): string[] | null {
  const providers = providersOf(json)
  if (!providers || !('ollama' in providers)) return null
  const models = (providers.ollama as { models?: unknown } | null)?.models
  if (!Array.isArray(models)) return []
  return models.map(m => (m as { id?: unknown } | null)?.id).filter((id): id is string => typeof id === 'string')
}

/** The /model recipe's decision inputs, one round trip: what Ollama has installed, what the file's
 *  ollama block lists (`null` = no block yet). An unreadable file reports nothing installed —
 *  never offer what sync would refuse — and the file check runs first so the common no-Ollama
 *  case costs no probe. */
export async function ollamaOffer(): Promise<{ installed: string[]; configured: string[] | null }> {
  const { json, unreadable } = readModelsJson(modelsJsonPath())
  if (unreadable) return { installed: [], configured: null }
  return { installed: await probeOllama(), configured: configuredIds(json) }
}

/** The confirmed sync: rewrite the ollama block to exactly what's installed right now. Everything
 *  is re-probed and re-checked at write time — the offer was a snapshot. */
export async function ollamaSync(): Promise<{ ok: boolean; count?: number; error?: string }> {
  const names = await probeOllama()
  if (!names.length) return { ok: false, error: 'Ollama is not running (or has no models installed)' }
  return writeOllamaProvider(modelsJsonPath(), names, ollamaHost())
}

/** The file half, path-injectable for tests: set the `ollama` provider to pi's documented minimal
 *  block (docs/models.md) — replacing any existing one (sync = clobber), preserving every other
 *  provider and top-level key (data-preserving; whitespace normalizes), creating the file when
 *  absent, refusing anything that can't round-trip. */
export function writeOllamaProvider(file: string, names: string[], host: string): { ok: boolean; count?: number; error?: string } {
  const { json, unreadable } = readModelsJson(file)
  if (unreadable) return { ok: false, error: `could not parse ${file} — edit the ollama provider there yourself` }
  const next = {
    ...(json ?? {}),
    providers: {
      ...(providersOf(json) ?? {}),
      // The apiKey is a placeholder Ollama ignores — required because pi hides models whose
      // provider has no auth configured (docs/models.md).
      ollama: { baseUrl: `${host}/v1`, api: 'openai-completions', apiKey: 'ollama', models: names.map(id => ({ id })) },
    },
  }
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(next, null, 2) + '\n')
  } catch (err) {
    return { ok: false, error: `could not write ${file}: ${errorMessage(err)}` }
  }
  return { ok: true, count: names.length }
}
