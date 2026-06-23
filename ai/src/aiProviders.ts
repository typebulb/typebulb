import type { ProviderProtocol, ChatMessageDto, ReasoningDepth, StreamErrorPayload } from './protocol.js'
import { AIProvider } from './aiProvider.js'
import { OpenAIProvider } from './providers/openAI.js'
import { OpenRouterProvider } from './providers/openRouter.js'
import { AnthropicProvider } from './providers/anthropic.js'
import { GeminiProvider } from './providers/gemini.js'
import { OllamaProvider } from './providers/ollama.js'

const providers = new Map<ProviderProtocol, AIProvider>([
  ['openai', new OpenAIProvider()],
  ['openrouter', new OpenRouterProvider()],
  ['anthropic', new AnthropicProvider()],
  ['gemini', new GeminiProvider()],
  ['ollama', new OllamaProvider()]
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
  reasoning?: ReasoningDepth
  webSearch?: boolean
  origin?: string
  signal?: AbortSignal
  modifyPayload?: (payload: Record<string, unknown>) => void
}

/** Send a request to an AI provider */
export async function sendAIRequest(
  provider: ResolvedAIProvider,
  opts: SendAIRequestOpts
): Promise<Response> {
  const spec = getProvider(provider.protocol)
  const path = spec.getPath(opts.model, opts.stream)
  const url = new URL(path, provider.baseUrl).toString()

  const headers = spec.buildHeaders(provider.apiKey, opts.origin)
  const payload = spec.buildPayload(
    opts.messages,
    opts.model,
    { reasoning: opts.reasoning, webSearch: opts.webSearch },
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
