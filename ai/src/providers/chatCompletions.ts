/**
 * Shared OpenAI Chat Completions wire format (`choices[]`) — response/stream DTOs and parsing,
 * used by every provider speaking that shape (OpenRouter, Ollama/openai-compat). Request building
 * (headers, path, payload) stays per-provider.
 */
import type {
  ChatStreamPieceDto,
  ChatResponseDto,
  ProviderResponseDto,
  ProviderStreamEventDto,
  AiUsage
} from '../protocol.js'
import { finalizeUsage } from '../protocol.js'
import { AIProvider } from '../aiProvider.js'

// ── Wire types ───────────────────────────────────────────────────────

// Usage in the Chat Completions shape: inclusive counts with itemized subsets. On a stream it
// arrives only when the request opted in via `stream_options.include_usage`, as a final chunk
// whose `choices` is EMPTY — so usage extraction must not sit behind a choices[0] check.
export interface ChatCompletionsUsageDto {
  prompt_tokens?: number
  completion_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
  completion_tokens_details?: { reasoning_tokens?: number }
}

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
  usage?: ChatCompletionsUsageDto
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
  usage?: ChatCompletionsUsageDto
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
    return { text, reasoning, usage: this.mapUsage(resp.usage) }
  }

  protected parseProviderStreamChunk(json: ProviderStreamEventDto): ChatStreamPieceDto | undefined {
    if (!this.hasChoices(json)) return undefined

    const event = json as ChatCompletionsStreamEventDto
    const usage = this.mapUsage(event.usage)
    const delta = event.choices[0]?.delta || event.choices[0]?.message
    const text = delta?.content || undefined
    const reasoning = delta?.reasoning || delta?.reasoning_content || undefined

    if (!text && !reasoning && !usage) return undefined

    return { text, reasoning, usage }
  }

  private hasChoices(json: unknown): boolean {
    return typeof json === 'object' && json !== null
      && 'choices' in json && Array.isArray((json as { choices?: unknown }).choices)
  }

  private mapUsage(u: ChatCompletionsUsageDto | undefined): AiUsage | undefined {
    if (!u) return undefined
    return finalizeUsage({
      input: u.prompt_tokens,
      output: u.completion_tokens,
      reasoning: u.completion_tokens_details?.reasoning_tokens,
      cacheRead: u.prompt_tokens_details?.cached_tokens,
    })
  }
}
