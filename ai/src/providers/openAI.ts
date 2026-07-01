/**
 * OpenAI Responses API (/v1/responses, not Chat Completions) — wire types and provider implementation.
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
import { AIProvider, ProviderStreamError, type ChatRequestOpts } from '../aiProvider.js'

// ── Wire types ───────────────────────────────────────────────────────

// OpenAI Responses API reasoning types. typebulb effort 0 maps to `none` (reasoning off) — `none` is
// supported across the GPT-5.x line, whereas `minimal` is model-gated (gpt-5.5 has it; gpt-5.4-mini
// 400s on it), so `none` is the robust floor. low/medium/high are 1/2/3. (`xhigh` is outside the dial.)
export type OpenAIReasoningEffort = 'none' | 'low' | 'medium' | 'high'
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

// OpenAI Responses API response format (non-streaming)
export interface OpenAIResponsesApiResponseDto extends ProviderResponseDto {
  object: 'response'
  output_text: string  // Quick access to text output
  output: Array<OpenAIResponseOutputItem>  // Structured output including reasoning
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

// Event type definitions using composition
export type OpenAIResponseCreatedEvent = OpenAIResponseEventBase & {
  type: 'response.created'
  response: {
    id: string
    object: 'response'
    created_at: number
    model: string
  }
}

export type OpenAIResponseInProgressEvent = OpenAIResponseEventBase & {
  type: 'response.in_progress'
}

export type OpenAIResponseOutputItemAddedEvent = OpenAIResponseEventBase & {
  type: 'response.output_item.added'
  output_index: number
  item: OpenAIResponseOutputItem
}

export type OpenAIResponseOutputItemDoneEvent = OpenAIResponseEventBase & {
  type: 'response.output_item.done'
  output_index: number
  item: OpenAIResponseOutputItem
}

export type OpenAIResponseContentPartAddedEvent = OpenAIResponseEventBase & OpenAIResponseContentLocation & {
  type: 'response.content_part.added'
  part: OpenAIResponseOutputText
}

export type OpenAIResponseContentPartDoneEvent = OpenAIResponseEventBase & OpenAIResponseContentLocation & {
  type: 'response.content_part.done'
  part: OpenAIResponseOutputText
}

export type OpenAIResponseOutputTextDeltaEvent = OpenAIResponseEventBase & OpenAIResponseContentLocation & {
  type: 'response.output_text.delta'
  delta: string
}

export type OpenAIResponseOutputTextDoneEvent = OpenAIResponseEventBase & OpenAIResponseContentLocation & {
  type: 'response.output_text.done'
  text: string
}

export type OpenAIResponseReasoningSummaryTextDeltaEvent = OpenAIResponseEventBase & OpenAIResponseItemLocation & {
  type: 'response.reasoning_summary_text.delta'
  delta: string
  summary_index: number
}

export type OpenAIResponseReasoningSummaryTextDoneEvent = OpenAIResponseEventBase & OpenAIResponseItemLocation & {
  type: 'response.reasoning_summary_text.done'
  text: string
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

// Web search events
export type OpenAIResponseWebSearchInProgressEvent = OpenAIResponseEventBase & {
  type: 'response.web_search_call.in_progress'
}

export type OpenAIResponseWebSearchSearchingEvent = OpenAIResponseEventBase & {
  type: 'response.web_search_call.searching'
}

export type OpenAIResponseWebSearchCompletedEvent = OpenAIResponseEventBase & {
  type: 'response.web_search_call.completed'
}

// Annotation events
export type OpenAIResponseAnnotationAddedEvent = OpenAIResponseEventBase & OpenAIResponseContentLocation & {
  type: 'response.output_text.annotation.added'
}

// Union of all OpenAI Responses API events
export type OpenAIResponseSseEventDto =
  | OpenAIResponseCreatedEvent
  | OpenAIResponseInProgressEvent
  | OpenAIResponseOutputItemAddedEvent
  | OpenAIResponseOutputItemDoneEvent
  | OpenAIResponseContentPartAddedEvent
  | OpenAIResponseContentPartDoneEvent
  | OpenAIResponseOutputTextDeltaEvent
  | OpenAIResponseOutputTextDoneEvent
  | OpenAIResponseAnnotationAddedEvent
  | OpenAIResponseReasoningSummaryTextDeltaEvent
  | OpenAIResponseReasoningSummaryTextDoneEvent
  | OpenAIResponseWebSearchInProgressEvent
  | OpenAIResponseWebSearchSearchingEvent
  | OpenAIResponseWebSearchCompletedEvent
  | OpenAIResponseCompletedEvent
  | OpenAIResponseErrorEvent
  | OpenAIResponseFailedEvent

// ── Provider implementation ──────────────────────────────────────────

export class OpenAIProvider extends AIProvider {
  protected readonly providerName = 'OpenAI'
  readonly defaultBaseUrl = 'https://api.openai.com'
  readonly path = '/v1/responses'

  private readonly effortMap: Record<EffortLevel, OpenAIReasoningEffort> = {
    0: 'none',
    1: 'low',
    2: 'medium',
    3: 'high'
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

    // Enable web search by default, can be disabled via opts.webSearch = false
    if (opts?.webSearch !== false) {
      payload.tools = [{ type: 'web_search' }]
    }

    if (this.isReasoningEnabled(opts)) {
      const effort = this.effortMap[opts!.effort!]
      // `summary: 'auto'` requests a reasoning summary; at `none` there's no reasoning to summarize.
      payload.reasoning = effort === 'none' ? { effort } : { effort, summary: 'auto' }
    }

    return payload
  }

  parseError(errorText: string, status: number): UpstreamErrorDto {
    return this.parseJsonError(errorText, status, true)
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

    return { text, reasoning }
  }

  protected parseProviderStreamChunk(json: ProviderStreamEventDto): ChatStreamPieceDto | null {
    if (!this.isResponsesApiEvent(json)) return null

    const eventType = json.type
    switch (eventType) {
      case 'error':
        return null

      case 'response.failed': {
        const resp = (json as any).response
        const errObj = resp?.error
        const errorMsg = errObj?.message || 'Response failed'
        const isQuotaOrRateLimit = errObj?.code === 'insufficient_quota' || errObj?.code === 'rate_limit_exceeded'
        throw new ProviderStreamError(errorMsg, isQuotaOrRateLimit ? 'rate_limit' : 'unknown', isQuotaOrRateLimit)
      }

      case 'response.output_text.delta':
        return { text: json.delta }

      case 'response.reasoning_summary_text.delta':
        return { reasoning: json.delta }

      case 'response.created':
      case 'response.in_progress':
      case 'response.output_item.added':
      case 'response.output_item.done':
      case 'response.content_part.added':
      case 'response.content_part.done':
      case 'response.output_text.done':
      case 'response.output_text.annotation.added':
      case 'response.reasoning_summary_text.done':
      case 'response.completed':
      case 'response.web_search_call.in_progress':
      case 'response.web_search_call.searching':
      case 'response.web_search_call.completed':
        return null

      default:
        return null
    }
  }

  // ── Private helpers ──────────────────────────────────────────────

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
