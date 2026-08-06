/**
 * OpenAI Responses API (/v1/responses, not Chat Completions) — wire types and provider implementation.
 */
import type {
  ChatMessageDto,
  EffortLevel,
  ChatStreamPieceDto,
  ChatResponseDto,
  ProviderResponseDto,
  ProviderStreamEventDto,
  AiUsage
} from '../protocol.js'
import { finalizeUsage } from '../protocol.js'
import { AIProvider, ProviderStreamError, type ChatRequestOpts } from '../aiProvider.js'

// ── Wire types ───────────────────────────────────────────────────────

// OpenAI Responses API reasoning types. typebulb effort 0 maps to `none` (reasoning off) — `none` is
// supported across the GPT-5.x line, whereas `minimal` is model-gated (gpt-5.5 has it; gpt-5.4-mini
// 400s on it, and 5.6 dropped the rung family-wide), so `none` is the robust floor. Verified against
// gpt-5.6-luna 2026-08: `none` → 0 reasoning tokens (a real off, not a degrade to low), `minimal` →
// 400 `unsupported_value` naming the survivors (none/low/medium/high/xhigh/max) — which is also the
// evidence for `xhigh` at 4. low/medium/high are 1/2/3. (`max` sits above the dial, deliberately.)
export type OpenAIReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh'
export type OpenAIReasoningSummary = 'auto' | 'concise' | 'detailed'

// OpenAI Responses API tool types
export interface OpenAIWebSearchTool {
  type: 'web_search'
}

export type OpenAITool = OpenAIWebSearchTool

// OpenAI Responses API request format
export interface OpenAIResponsesApiRequestDto {
  model: string
  input: string  // Single string instead of messages array
  // The Responses API names it `max_output_tokens`; a chat-completions `max_tokens` is not
  // recognized here, which is why the cap is translated per provider rather than patched in.
  max_output_tokens?: number
  reasoning?: {
    effort: OpenAIReasoningEffort
    summary?: OpenAIReasoningSummary
  }
  tools?: OpenAITool[]
  stream?: boolean
}

// OpenAI Responses API - Output item types
export interface OpenAIResponseOutputText {
  text: string
  type: 'output_text'
}

export interface OpenAIResponseReasoningSummary {
  text: string
  type: 'summary_text'
}

export interface OpenAIResponseOutputMessage {
  type: 'message'
  content: Array<OpenAIResponseOutputText>
}

export interface OpenAIResponseReasoningItem {
  type: 'reasoning'
  summary: Array<OpenAIResponseReasoningSummary>
}

export type OpenAIResponseOutputItem = OpenAIResponseOutputMessage | OpenAIResponseReasoningItem

// Usage on the Responses API: inclusive counts (`input_tokens` contains the cached subset,
// `output_tokens` the reasoning subset), with the subsets itemized under *_details.
export interface OpenAIUsageDto {
  input_tokens?: number
  output_tokens?: number
  input_tokens_details?: { cached_tokens?: number }
  output_tokens_details?: { reasoning_tokens?: number }
}

// OpenAI Responses API response format (non-streaming)
export interface OpenAIResponsesApiResponseDto extends ProviderResponseDto {
  object: 'response'
  output_text: string  // Quick access to text output
  output: Array<OpenAIResponseOutputItem>  // Structured output including reasoning
  usage?: OpenAIUsageDto
}

// SSE events (OpenAI Responses API)
// Base event structure - all events have these
interface OpenAIResponseEventBase {
  sequence_number: number
}

// Common location fields for content/output events
interface OpenAIResponseItemLocation {
  item_id: string
  output_index: number
}

interface OpenAIResponseContentLocation extends OpenAIResponseItemLocation {
  content_index: number
}

// Event type definitions using composition — only the events we handle are typed; everything else
// (created/in_progress/output_item/content_part/done/web_search/annotation events) falls through
// the catch-all and is ignored.
export type OpenAIResponseOutputTextDeltaEvent = OpenAIResponseEventBase & OpenAIResponseContentLocation & {
  type: 'response.output_text.delta'
  delta: string
}

export type OpenAIResponseReasoningSummaryTextDeltaEvent = OpenAIResponseEventBase & OpenAIResponseItemLocation & {
  type: 'response.reasoning_summary_text.delta'
  delta: string
  summary_index: number
}

export type OpenAIResponseCompletedEvent = OpenAIResponseEventBase & {
  type: 'response.completed'
  response: OpenAIResponsesApiResponseDto
}

export type OpenAIResponseErrorEvent = OpenAIResponseEventBase & {
  type: 'error'
  error: {
    type: string
    code: string | null
    message: string
    param: string | null
  }
}

export type OpenAIResponseFailedEvent = OpenAIResponseEventBase & {
  type: 'response.failed'
}

// Union of OpenAI Responses API events (handled events typed, the rest catch-all)
export type OpenAIResponseSseEventDto =
  | OpenAIResponseOutputTextDeltaEvent
  | OpenAIResponseReasoningSummaryTextDeltaEvent
  | OpenAIResponseCompletedEvent
  | OpenAIResponseErrorEvent
  | OpenAIResponseFailedEvent
  | { type: string }

// ── Provider implementation ──────────────────────────────────────────

export class OpenAIProvider extends AIProvider {
  protected readonly providerName = 'OpenAI'
  readonly defaultBaseUrl = 'https://api.openai.com'
  readonly path = '/v1/responses'

  private readonly effortMap: Record<EffortLevel, OpenAIReasoningEffort> = {
    0: 'none',
    1: 'low',
    2: 'medium',
    3: 'high',
    4: 'xhigh'
  }

  // ── Request building ─────────────────────────────────────────────

  buildHeaders(apiKey: string): Record<string, string> {
    return {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    }
  }

  buildPayload(
    messages: ChatMessageDto[],
    model: string,
    opts: ChatRequestOpts,
    stream: boolean
  ): OpenAIResponsesApiRequestDto {
    // Responses API uses 'input' (string) instead of 'messages' (array)
    const input = this.convertMessagesToInput(messages)
    const payload: OpenAIResponsesApiRequestDto = {
      model,
      input,
      stream
    }

    if (opts?.webSearch === true) {
      payload.tools = [{ type: 'web_search' }]
    }

    if (opts?.effort !== undefined) {
      const effort = this.effortMap[opts.effort]
      // `summary: 'auto'` requests a reasoning summary; at `none` there's no reasoning to summarize.
      payload.reasoning = effort === 'none' ? { effort } : { effort, summary: 'auto' }
    }

    if (opts?.maxOutputTokens !== undefined) {
      payload.max_output_tokens = opts.maxOutputTokens
    }

    return payload
  }

  // ── Response parsing ─────────────────────────────────────────────

  parseNonStreamingResponse(json: ProviderResponseDto): ChatResponseDto {
    if (!this.isResponsesApiResponse(json)) {
      return { text: '' }
    }

    let text = json.output_text || ''
    let reasoning: string | undefined

    if (json.output && Array.isArray(json.output)) {
      for (const item of json.output) {
        if (item.type === 'reasoning' && item.summary) {
          reasoning = item.summary.map((s: any) => s.text).join('\n')
        }
        // Fallback: extract text from output array when output_text is missing
        if (!text && item.type === 'message' && item.content) {
          text = (item.content as any[])
            .filter((c: any) => c.type === 'output_text')
            .map((c: any) => c.text)
            .join('')
        }
      }
    }

    return { text, reasoning, usage: this.mapUsage(json.usage) }
  }

  protected parseProviderStreamChunk(json: ProviderStreamEventDto): ChatStreamPieceDto | null {
    if (!this.isResponsesApiEvent(json)) return null

    switch (json.type) {
      case 'response.failed': {
        const resp = (json as any).response
        const errObj = resp?.error
        const errorMsg = errObj?.message || 'Response failed'
        const isQuotaOrRateLimit = errObj?.code === 'insufficient_quota' || errObj?.code === 'rate_limit_exceeded'
        throw new ProviderStreamError(errorMsg, isQuotaOrRateLimit ? 'rate_limit' : 'unknown', isQuotaOrRateLimit)
      }

      case 'response.output_text.delta':
        return { text: (json as OpenAIResponseOutputTextDeltaEvent).delta }

      case 'response.reasoning_summary_text.delta':
        return { reasoning: (json as OpenAIResponseReasoningSummaryTextDeltaEvent).delta }

      // The final event carries the complete response, usage included — the one place the
      // Responses API reports token counts on a stream.
      case 'response.completed': {
        const usage = this.mapUsage((json as OpenAIResponseCompletedEvent).response?.usage)
        return usage ? { usage } : null
      }

      default:
        return null
    }
  }

  // ── Private helpers ──────────────────────────────────────────────

  private mapUsage(u: OpenAIUsageDto | undefined): AiUsage | undefined {
    if (!u) return undefined
    return finalizeUsage({
      input: u.input_tokens,
      output: u.output_tokens,
      reasoning: u.output_tokens_details?.reasoning_tokens,
      cacheRead: u.input_tokens_details?.cached_tokens,
    })
  }

  private convertMessagesToInput(messages: ChatMessageDto[]): string {
    return messages.map(m => {
      if (m.role === 'system') return `System: ${m.content}`
      if (m.role === 'user') return `User: ${m.content}`
      if (m.role === 'assistant') return `Assistant: ${m.content}`
      return m.content
    }).join('\n\n')
  }

  private isResponsesApiEvent(json: unknown): json is OpenAIResponseSseEventDto {
    return typeof json === 'object' && json !== null
      && 'type' in json && typeof (json as { type?: unknown }).type === 'string'
  }

  private isResponsesApiResponse(json: unknown): json is OpenAIResponsesApiResponseDto {
    return typeof json === 'object' && json !== null
      && (json as OpenAIResponsesApiResponseDto).object === 'response'
  }
}
