import type { ProviderProtocol, ChatMessageDto, EffortLevel, StreamErrorPayload } from './protocol.js'
import { AIProvider } from './aiProvider.js'
import { OpenAIProvider } from './providers/openAI.js'
import { OpenRouterProvider } from './providers/openRouter.js'
import { AnthropicProvider } from './providers/anthropic.js'
import { GeminiProvider } from './providers/gemini.js'
import { OllamaProvider } from './providers/ollama.js'

// One OpenAI-compatible client backs both the `ollama` zero-config preset and the generic
// `openai-compat` protocol; they differ only in how the resolver sources base URL + key.
const openAICompat = new OllamaProvider()
const providers = new Map<ProviderProtocol, AIProvider>([
  ['openai', new OpenAIProvider()],
  ['openrouter', new OpenRouterProvider()],
  ['anthropic', new AnthropicProvider()],
  ['gemini', new GeminiProvider()],
  ['ollama', openAICompat],
  ['openai-compat', openAICompat]
])

/** Get the provider implementation for a given protocol. */
export function getProvider(protocol: ProviderProtocol): AIProvider {
  const provider = providers.get(protocol)
  if (!provider) {
    throw new Error(`Unsupported protocol: ${protocol}`)
  }
  return provider
}

/** Resolved provider credentials for AI requests */
export interface ResolvedAIProvider {
  apiKey: string
  baseUrl: string
  protocol: ProviderProtocol
  model: string
  isFreeModel: boolean
}

/** Options for sending AI requests */
export interface SendAIRequestOpts {
  model: string
  messages: ChatMessageDto[]
  stream: boolean
  effort?: EffortLevel
  webSearch?: boolean
  origin?: string
  signal?: AbortSignal
  modifyPayload?: (payload: Record<string, unknown>) => void
}

/**
 * Join an operation path onto a base URL, **preserving the base's path prefix**.
 *
 * `new URL(absolutePath, base)` resolves the absolute path against the base's *origin*, so any
 * path in the base is silently dropped — a prefixed/gateway/proxy base (Azure, a corporate proxy,
 * an `openai-compat` endpoint) loses its prefix. This keeps the base intact and appends the path
 * with exactly one `/` between. The OpenAI-SDK model: `baseUrl` is the true API root, the
 * operation path (from `getPath`) is joined onto it. Trailing slashes on the base are collapsed so
 * a user-supplied `…/v1/` and `…/v1` behave identically.
 */
export function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, '') + (path.startsWith('/') ? path : `/${path}`)
}

/** Send a request to an AI provider */
export async function sendAIRequest(
  provider: ResolvedAIProvider,
  opts: SendAIRequestOpts
): Promise<Response> {
  const spec = getProvider(provider.protocol)
  const path = spec.getPath(opts.model, opts.stream)
  const url = joinUrl(provider.baseUrl, path)

  const headers = spec.buildHeaders(provider.apiKey, opts.origin)
  const payload = spec.buildPayload(
    opts.messages,
    opts.model,
    { effort: opts.effort, webSearch: opts.webSearch },
    opts.stream
  ) as Record<string, unknown>

  opts.modifyPayload?.(payload)

  return fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: opts.signal
  })
}

/** Parse an upstream error response into our standard error payload */
export async function normalizeUpstreamError(
  response: Response,
  protocol: ProviderProtocol
): Promise<Required<StreamErrorPayload>> {
  const spec = getProvider(protocol)
  const errorText = await response.text().catch(() => '')
  const { message } = spec.parseError(errorText, response.status)
  const status = response.status

  let code: StreamErrorPayload['code'] = 'unknown'
  if (status === 429) code = 'rate_limit'
  else if (status === 413) code = 'context_exceeded'

  return { code, message, retryable: status === 429 }
}
