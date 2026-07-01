/**
 * The `tb` global for `server.ts` code. Unlike the browser (where `tb.ai` postMessages the parent
 * frame, which HTTP-hops to `/__ai`), server.ts runs in this same Node process — so `tb.ai` is a
 * direct in-process call to the very functions `/__ai` uses (resolve from .env → stream → project to
 * text/chunks). No bridge, no round trip. Injected onto `globalThis` before the bulb's server module
 * is imported (pipeline.ts `importServerModule`), so the module's free `tb` reference resolves to it —
 * the same mechanism the browser shim uses. Only reached under trust (server.ts imports only when
 * trusted), so it inherits the same key access as the HTTP route.
 *
 * Surface is deliberately the AI subset — `tb.ai`, `tb.ai.stream`, `tb.models`, `tb.mode`. server.ts is
 * otherwise plain Node (own `fs`, own `console.log`), so the browser-only helpers are not mirrored here.
 */

import type { AiChunk, ProviderProtocol, TbModelDto } from 'typebulb/ai'
import { consumeStreamText, streamAiChunks, normalizeUpstreamError } from 'typebulb/ai'
import { resolveLocalProvider, sendTbAi } from './localProvider.js'
import { getFilteredModels } from './modelCatalog.js'

interface TbAiOptions {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  system?: string
  effort?: 0 | 1 | 2 | 3
  provider?: string
  model?: string
  webSearch?: boolean
  signal?: AbortSignal
}

/** Resolve + send, throwing a plain Error (the resolution message, or the normalized upstream error)
 *  so bulb `try/catch` sees one Error type — the in-process analog of the HTTP route's error JSON. */
async function open(opts: TbAiOptions): Promise<{ response: Response; protocol: ProviderProtocol }> {
  const resolved = resolveLocalProvider(opts.provider, opts.model)
  if (typeof resolved === 'string') throw new Error(resolved)
  const response = await sendTbAi(resolved, opts)
  if (!response.ok) {
    const err = await normalizeUpstreamError(response, resolved.protocol)
    throw new Error(err.message)
  }
  return { response, protocol: resolved.protocol }
}

async function tbAi(opts: TbAiOptions): Promise<{ text: string }> {
  const { response, protocol } = await open(opts)
  return { text: await consumeStreamText(response, protocol) }
}

async function* tbAiStream(opts: TbAiOptions): AsyncGenerator<AiChunk> {
  const { response, protocol } = await open(opts)
  yield* streamAiChunks(response, protocol)
}

/** Install the server-side `tb` global. Idempotent — safe to call on every (re)import under watch. */
export function installServerTb(): void {
  const ai = Object.assign(tbAi, { stream: tbAiStream })
  ;(globalThis as { tb?: unknown }).tb = Object.freeze({
    ai,
    models: (): Promise<TbModelDto[]> => getFilteredModels(),
    mode: 'local' as const,
  })
}
