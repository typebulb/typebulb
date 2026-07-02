/**
 * Shared OpenAI Chat Completions wire format (`choices[]`) — response/stream DTOs and parsing,
 * used by every provider speaking that shape (OpenRouter, Ollama/openai-compat). Request building
 * (headers, path, payload) stays per-provider.
 */
import type {
  ChatStreamPieceDto,
  ChatResponseDto,
  ProviderResponseDto,
  ProviderStreamEventDto
} from '../protocol.js'
import { AIProvider } from '../aiProvider.js'

// ── Wire types ───────────────────────────────────────────────────────

// Non-streaming response
export interface ChatCompletionsMessageDto {
  content: string
  // Some models surface chain-of-thought separately; field name varies by provider/build.
  reasoning?: string
  reasoning_content?: string
}

export interface ChatCompletionsChoiceDto {
  message?: ChatCompletionsMessageDto
  text?: string
}

export interface ChatCompletionsResponseDto extends ProviderResponseDto {
  choices: ChatCompletionsChoiceDto[]
  reasoning?: string
}

// SSE events (streaming)
export interface ChatCompletionsDeltaDto {
  content?: string
  reasoning?: string
  reasoning_content?: string
}

export interface ChatCompletionsStreamChoiceDto {
  delta?: ChatCompletionsDeltaDto
  message?: ChatCompletionsDeltaDto
}

export interface ChatCompletionsStreamEventDto extends ProviderStreamEventDto {
  choices: ChatCompletionsStreamChoiceDto[]
}

// ── Shared parsing ───────────────────────────────────────────────────

export abstract class ChatCompletionsProvider extends AIProvider {
  parseNonStreamingResponse(json: ProviderResponseDto): ChatResponseDto {
    if (!this.hasChoices(json)) return { text: '' }

    const resp = json as ChatCompletionsResponseDto
    const choice = resp.choices[0]
    const msg = choice?.message
    const text = msg?.content ?? choice?.text ?? ''
    const reasoning = msg?.reasoning ?? msg?.reasoning_content ?? resp.reasoning
    return { text, reasoning }
  }

  protected parseProviderStreamChunk(json: ProviderStreamEventDto): ChatStreamPieceDto | null {
    if (!this.hasChoices(json)) return null

    const choice = (json as ChatCompletionsStreamEventDto).choices[0]
    if (!choice) return null

    const delta = choice.delta || choice.message
    if (!delta) return null

    const text = delta.content || undefined
    const reasoning = delta.reasoning || delta.reasoning_content || undefined

    if (!text && !reasoning) return null

    return { text, reasoning }
  }

  private hasChoices(json: unknown): boolean {
    return typeof json === 'object' && json !== null
      && 'choices' in json && Array.isArray((json as { choices?: unknown }).choices)
  }
}
