/**
 * Ollama via its OpenAI-compatible endpoint (`/v1/chat/completions`, Chat Completions style
 * with choices[]) — wire types and provider implementation.
 *
 * CLI-only. Ollama runs locally and needs no API key, so `buildHeaders` sends no auth and the
 * resolver supplies an empty key (see runtime/cli/src/serve/server.ts `resolveLocalProvider`).
 * The base URL defaults to http://localhost:11434 and is overridable via OLLAMA_HOST.
 *
 * Ollama does NOT implement the OpenAI Responses API the `openai` protocol targets, which is why
 * this is its own provider rather than a reuse of OpenAIProvider. The native `/api/chat` endpoint
 * (NDJSON, first-class `message.thinking`) is the richer path for reasoning streaming and Ollama
 * options — a deliberate follow-up; see specs/TB-AI-Local-Models.md.
 */
import type {
  ChatMessageDto,
  UpstreamErrorDto,
  ChatStreamPieceDto,
  ChatResponseDto,
  ProviderResponseDto,
  ProviderStreamEventDto
} from '../protocol.js'
import { AIProvider, type ChatRequestOpts } from '../aiProvider.js'

// ── Wire types ───────────────────────────────────────────────────────

// Non-streaming response (Chat Completions style)
export interface OllamaMessageDto {
  content: string
  // Some models surface chain-of-thought separately; field name varies by build.
  reasoning?: string
  reasoning_content?: string
}

export interface OllamaChoiceDto {
  message?: OllamaMessageDto
}

export interface OllamaResponseDto extends ProviderResponseDto {
  choices: OllamaChoiceDto[]
}

// SSE events (streaming)
export interface OllamaDeltaDto {
  content?: string
  reasoning?: string
  reasoning_content?: string
}

export interface OllamaStreamChoiceDto {
  delta?: OllamaDeltaDto
  message?: OllamaDeltaDto
}

export interface OllamaStreamEventDto extends ProviderStreamEventDto {
  choices: OllamaStreamChoiceDto[]
}

// ── Provider implementation ──────────────────────────────────────────

/** Ollama OpenAI-compatible request payload */
export type OllamaRequestPayload = {
  model: string
  messages: ChatMessageDto[]
  stream: boolean
}

export class OllamaProvider extends AIProvider {
  protected readonly providerName = 'Ollama'
  readonly defaultBaseUrl = 'http://localhost:11434'
  readonly path = '/v1/chat/completions'

  // ── Request building ─────────────────────────────────────────────

  // Ollama is keyless: send no Authorization header. The `apiKey` arg (empty from the
  // resolver) is ignored.
  buildHeaders(_apiKey: string): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    }
  }

  // Web search and the reasoning-effort knob have no equivalent on the OpenAI-compat endpoint,
  // so the payload stays minimal. Ollama-specific options (num_ctx, think, …) are intentionally
  // out of scope for tb.ai — use a server.ts export for those (specs/TB-Server-Streaming.md).
  buildPayload(
    messages: ChatMessageDto[],
    model: string,
    _opts: ChatRequestOpts,
    stream: boolean
  ): OllamaRequestPayload {
    return { model, messages, stream }
  }

  parseError(errorText: string, status: number): UpstreamErrorDto {
    return this.parseJsonError(errorText, status, true)
  }

  // ── Response parsing ─────────────────────────────────────────────

  parseNonStreamingResponse(json: ProviderResponseDto): ChatResponseDto {
    if (!this.hasChoices(json)) return { text: '' }

    const choice = (json as OllamaResponseDto).choices[0]
    const msg = choice?.message
    const text = msg?.content ?? ''
    const reasoning = msg?.reasoning ?? msg?.reasoning_content
    return { text, reasoning }
  }

  protected parseProviderStreamChunk(json: ProviderStreamEventDto): ChatStreamPieceDto | null {
    if (!this.hasChoices(json)) return null

    const choice = (json as OllamaStreamEventDto).choices[0]
    if (!choice) return null

    const delta = choice.delta || choice.message
    if (!delta) return null

    const text = delta.content || undefined
    const reasoning = delta.reasoning || delta.reasoning_content || undefined

    if (!text && !reasoning) return null

    return { text, reasoning }
  }

  // ── Private helpers ──────────────────────────────────────────────

  private hasChoices(json: unknown): boolean {
    return typeof json === 'object' && json !== null
      && 'choices' in json && Array.isArray((json as { choices?: unknown }).choices)
  }
}
