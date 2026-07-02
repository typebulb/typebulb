/**
 * Local provider resolution + request assembly for `tb.ai` in the CLI. Shared by the `/__ai` HTTP
 * route (the browser bridge) and the in-process `tb.ai` injected into `server.ts` (serverTb.ts) — both
 * resolve a provider from the .env cascade and send the same streamed request, so a bulb's client and
 * server code hit AI identically. Provider payload logic stays in `typebulb/ai`; this is only the
 * env-based resolution + system-prepend + effort normalization around it.
 */

import type { ChatMessageDto, EffortLevel, ProviderProtocol, ResolvedAIProvider } from 'typebulb/ai'
import { sendAIRequest, getProvider } from 'typebulb/ai'
import { PROVIDER_ENV_KEYS, normalizeOllamaHost } from './modelCatalog.js'

/**
 * Resolve provider and model for a `tb.ai()` call from the .env cascade.
 *
 * Both provider and model must be specified — either via env vars (TB_AI_PROVIDER, TB_AI_MODEL)
 * or per-call overrides. Returns a string message (not a throw) on any resolution failure so both
 * the HTTP route and the in-process caller can surface it their own way.
 */
export function resolveLocalProvider(reqProvider?: string, reqModel?: string): ResolvedAIProvider | string {
  const protocol = reqProvider as ProviderProtocol | undefined
    ?? process.env.TB_AI_PROVIDER as ProviderProtocol | undefined
  const model = reqModel ?? process.env.TB_AI_MODEL

  if (!protocol) return 'No provider specified. Set TB_AI_PROVIDER in your .env file or pass provider in the tb.ai() call.'
  if (!model) return 'No model specified. Set TB_AI_MODEL in your .env file or pass model in the tb.ai() call.'

  let spec
  try { spec = getProvider(protocol) } catch { return `Unknown provider '${protocol}'.` }

  // OpenAI-compatible local / self-hosted endpoints. Both append `/chat/completions` onto a base
  // that ends in `/v1` (see OllamaProvider). `ollama` is the zero-config preset: keyless, origin
  // from OLLAMA_HOST (Ollama's own env var, scheme optional) defaulting to localhost:11434; the
  // `/v1` is supplied here so the provider path stays the bare operation.
  if (protocol === 'ollama') {
    const baseUrl = `${normalizeOllamaHost(process.env.OLLAMA_HOST ?? spec.defaultBaseUrl)}/v1`
    return { apiKey: '', baseUrl, protocol, model, isFreeModel: false }
  }
  // `openai-compat` is the generic form for any OpenAI-compatible endpoint (LM Studio, vLLM, a
  // self-hosted box, a keyed proxy): TB_AI_BASE_URL is the OpenAI-style base ending in `/v1`
  // (paste-compatible with what these vendors document), used verbatim; the key is optional.
  if (protocol === 'openai-compat') {
    const baseUrl = process.env.TB_AI_BASE_URL
    if (!baseUrl) return 'No base URL for openai-compat. Set TB_AI_BASE_URL (the OpenAI-style base ending in /v1, e.g. http://localhost:1234/v1) in your .env file.'
    return { apiKey: process.env.TB_AI_API_KEY ?? '', baseUrl, protocol, model, isFreeModel: false }
  }

  const envKey = PROVIDER_ENV_KEYS[protocol]
  if (!envKey) return `Unknown provider '${protocol}'.`
  const apiKey = process.env[envKey]
  if (!apiKey) return `No API key for '${protocol}'. Set ${envKey} in your .env file.`

  return { apiKey, baseUrl: spec.defaultBaseUrl, protocol, model, isFreeModel: false }
}

/** A `tb.ai`/`tb.ai.stream` request as the CLI sees it — the bulb's message list plus the shared knobs. */
export interface TbAiRequest {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  system?: string
  effort?: number
  webSearch?: boolean
  signal?: AbortSignal
}

/**
 * Send a resolved `tb.ai` request and return the raw streamed provider Response. Always streams under
 * the hood (SSE keeps long responses alive past httpClient's 20s timeout); the caller projects it to
 * text (`consumeStreamText`) or chunks (`streamAiChunks`). Centralizes the system-prepend, the
 * effort normalization (only 0–3 pass through; anything else omits the hint → provider default), and
 * the webSearch default (on). Note 0 (minimal) is a valid level, so it must NOT be dropped like a
 * falsy value — the old `> 0` check silently coerced it to omit.
 */
export function sendTbAi(resolved: ResolvedAIProvider, req: TbAiRequest): Promise<Response> {
  const chatMessages: ChatMessageDto[] = [
    ...(req.system ? [{ role: 'system' as const, content: req.system }] : []),
    ...req.messages.map(m => ({ role: m.role, content: m.content })),
  ]
  const e = req.effort
  return sendAIRequest(resolved, {
    messages: chatMessages,
    stream: true,
    effort: (e != null && e >= 0 && e <= 3 ? e : undefined) as EffortLevel | undefined,
    webSearch: req.webSearch ?? true,
    signal: req.signal,
  })
}
