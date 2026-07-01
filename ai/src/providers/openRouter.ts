/**
 * OpenRouter API (Chat Completions style with choices[]) — wire types and provider implementation.
 */
import type {
  ChatMessageDto,
  UpstreamErrorDto,
  EffortLevel,
  ChatStreamPieceDto,
  ChatResponseDto,
  ProviderResponseDto,
  ProviderStreamEventDto
} from '../protocol.js'
import { AIProvider, type ChatRequestOpts } from '../aiProvider.js'

// ── Wire types ───────────────────────────────────────────────────────

// Non-streaming response (Chat Completions style)
export interface OpenRouterMessageDto {
  content: string
  reasoning?: string
}

export interface OpenRouterChoiceDto {
  message?: OpenRouterMessageDto
  text?: string
}

export interface OpenRouterResponseDto extends ProviderResponseDto {
  choices: OpenRouterChoiceDto[]
  reasoning?: string
}

// SSE events (streaming)
export interface OpenRouterDeltaDto {
  content?: string
  reasoning?: string
}

export interface OpenRouterStreamChoiceDto {
  delta?: OpenRouterDeltaDto
  message?: OpenRouterDeltaDto
}

export interface OpenRouterStreamEventDto extends ProviderStreamEventDto {
  choices: OpenRouterStreamChoiceDto[]
}

// Error response (OpenAI-compatible format)
export interface OpenRouterErrorResponseDto {
  error: {
    message: string
    type?: string
    code?: string
  }
}

// Union of streaming events and errors
export type OpenRouterSseEventDto =
  | OpenRouterStreamEventDto
  | OpenRouterErrorResponseDto

// ── Provider implementation ──────────────────────────────────────────

/** OpenRouter web search plugin */
interface OpenRouterWebPlugin {
  id: 'web'
  max_results?: number
}

/** OpenRouter request payload */
export type OpenRouterRequestPayload = {
  model: string
  messages: ChatMessageDto[]
  stream: boolean
  reasoning?: { effort: 'none' | 'low' | 'medium' | 'high' }
  plugins?: OpenRouterWebPlugin[]
}

export class OpenRouterProvider extends AIProvider {
  protected readonly providerName = 'OpenRouter'
  // First-party convention (like anthropic/openai/gemini): the base is the bare origin and the
  // full versioned mount lives in `path`. OpenRouter mounts its OpenAI-compatible API at `/api/v1`
  // (not `/v1`), so the path carries `/api/v1/…` — the vendor's real mount, the way gemini's path
  // carries `/v1beta`. Keeping `/api` in the path (not the base) also matches the web-side stored
  // `apiUrl` of `https://openrouter.ai`, so the prefix-preserving join yields the identical URL on
  // both web and CLI. (Do NOT put `/api` in the base too — the join would then double it to `/api/api`.)
  readonly defaultBaseUrl = 'https://openrouter.ai'
  readonly path: string = '/api/v1/chat/completions'

  // 0 → `none` (reasoning off): OpenRouter normalizes this across providers, and it's the robust floor
  // (its `minimal` isn't supported by every underlying model, e.g. gpt-5.4-mini).
  private readonly effortMap: Record<EffortLevel, 'none' | 'low' | 'medium' | 'high'> = {
    0: 'none',
    1: 'low',
    2: 'medium',
    3: 'high'
  }

  // ── Request building ─────────────────────────────────────────────

  buildHeaders(apiKey: string, origin?: string): Record<string, string> {
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${apiKey}`,
      'x-api-key': apiKey,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-Title': 'Typebulb'
    }

    if (origin) {
      headers['HTTP-Referer'] = origin
      headers['Referer'] = origin
      headers['Origin'] = origin
    }

    return headers
  }

  buildPayload(
    messages: ChatMessageDto[],
    model: string,
    opts: ChatRequestOpts,
    stream: boolean
  ): OpenRouterRequestPayload {
    const payload: OpenRouterRequestPayload = {
      model,
      messages,
      stream
    }

    // Web search disabled for OpenRouter - $0.02/request via Exa.ai is expensive
    if (opts?.webSearch === true) {
      payload.plugins = [{ id: 'web' }]
    }

    if (this.isReasoningEnabled(opts)) {
      payload.reasoning = {
        effort: this.effortMap[opts!.effort!]
      }
    }

    return payload
  }

  parseError(errorText: string, status: number): UpstreamErrorDto {
    return this.parseJsonError(errorText, status, true)
  }

  // ── Response parsing ─────────────────────────────────────────────

  parseNonStreamingResponse(json: ProviderResponseDto): ChatResponseDto {
    if (!this.hasChoices(json)) {
      return { text: '' }
    }

    const resp = json as OpenRouterResponseDto
    const choice = resp.choices[0]
    const text = choice?.message?.content ?? choice?.text ?? ''
    const reasoning = choice?.message?.reasoning ?? resp.reasoning

    return { text, reasoning }
  }

  protected parseProviderStreamChunk(json: ProviderStreamEventDto): ChatStreamPieceDto | null {
    if (!this.hasChoices(json)) return null

    const choice = (json as OpenRouterStreamEventDto).choices[0]
    if (!choice) return null

    const delta = choice.delta || choice.message
    if (!delta) return null

    const text = delta.content || undefined
    const reasoning = delta.reasoning || undefined

    if (!text && !reasoning) return null

    return { text, reasoning }
  }

  // ── Private helpers ──────────────────────────────────────────────

  private hasChoices(json: unknown): boolean {
    return typeof json === 'object' && json !== null && 'choices' in json && Array.isArray((json as any).choices)
  }
}
