/**
 * Anthropic Messages API (/v1/messages) — wire types and provider implementation.
 */
import type {
  ChatMessageDto,
  ChatStreamPieceDto,
  ChatResponseDto,
  ProviderResponseDto,
  ProviderStreamEventDto
} from '../protocol.js'
import { AIProvider, type ChatRequestOpts } from '../aiProvider.js'

// ── Wire types ───────────────────────────────────────────────────────

export interface AnthropicTextContent {
  type: 'text'
  text: string
}

export interface AnthropicThinkingContent {
  type: 'thinking'
  thinking: string
}

// Anthropic non-streaming response format
export interface AnthropicNonStreamingResponseDto extends ProviderResponseDto {
  type: 'message'
  content: Array<AnthropicTextContent | AnthropicThinkingContent>
}

// Error response
export interface AnthropicErrorResponseDto {
  type: 'error'
  error: {
    type: string
    message: string
  }
}

// SSE events (Anthropic style)
export interface AnthropicContentBlockDeltaDto {
  type: 'content_block_delta'
  index: number
  delta: { type: 'text_delta'; text: string } | { type: 'thinking_delta'; thinking: string }
}

export interface AnthropicContentBlockStartDto {
  type: 'content_block_start'
  index: number
  content_block: { type: 'text'; text: string }
}

export interface AnthropicContentBlockStopDto {
  type: 'content_block_stop'
  index: number
}

export interface AnthropicMessageStartDto {
  type: 'message_start'
  message: Record<string, unknown>
}

export interface AnthropicMessageDeltaDto {
  type: 'message_delta'
  delta: Record<string, unknown>
  usage?: Record<string, unknown>
}

export interface AnthropicMessageStopDto {
  type: 'message_stop'
}

export interface AnthropicPingDto {
  type: 'ping'
}

export type AnthropicSseEventDto =
  | AnthropicContentBlockDeltaDto
  | AnthropicContentBlockStartDto
  | AnthropicContentBlockStopDto
  | AnthropicMessageStartDto
  | AnthropicMessageDeltaDto
  | AnthropicMessageStopDto
  | AnthropicPingDto
  | AnthropicErrorResponseDto

// ── Provider implementation ──────────────────────────────────────────

/** Anthropic thinking (extended reasoning) */
type AnthropicThinkingConfig =
  | { type: 'enabled'; budget_tokens: number }
  | { type: 'adaptive'; display?: 'summarized' | 'omitted' }
  | { type: 'disabled' }

/** Anthropic web search tool definition */
interface AnthropicWebSearchTool {
  type: 'web_search_20250305'
  name: 'web_search'
  max_uses?: number
}

/** Ephemeral prompt-cache breakpoint */
type CacheControl = { type: 'ephemeral' }

/** Outbound text block with an optional cache breakpoint (request-side only) */
type AnthropicTextBlock = { type: 'text'; text: string; cache_control?: CacheControl }

/** Message whose content may be a plain string or block array (block form carries cache_control) */
type AnthropicMessage = { role: ChatMessageDto['role']; content: string | AnthropicTextBlock[] }

/** Anthropic request payload */
export type AnthropicRequestPayload = {
  model: string
  messages: AnthropicMessage[]
  max_tokens: number
  stream: boolean
  system?: string | AnthropicTextBlock[]
  thinking?: AnthropicThinkingConfig
  output_config?: { effort: 'low' | 'medium' | 'high' | 'max' }
  tools?: AnthropicWebSearchTool[]
}

export class AnthropicProvider extends AIProvider {
  protected readonly providerName = 'Anthropic'
  readonly defaultBaseUrl = 'https://api.anthropic.com'
  readonly path = '/v1/messages'

  // ── Request building ─────────────────────────────────────────────

  buildHeaders(apiKey: string): Record<string, string> {
    return {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    }
  }

  buildPayload(
    messages: ChatMessageDto[],
    model: string,
    opts: ChatRequestOpts,
    stream: boolean
  ): AnthropicRequestPayload {
    const { system, conversationMessages } = this.extractSystemMessages(messages)

    const payload: AnthropicRequestPayload = {
      model,
      // A cap never raises the model's own ceiling, so the smaller of the two wins.
      max_tokens: Math.min(this.getMaxTokens(model), opts?.maxOutputTokens ?? Infinity),
      // Breakpoints on the final two messages cache the conversation prefix (extends each turn)
      messages: this.withTailMessagesCached(conversationMessages),
      stream
    }

    if (opts?.webSearch === true) {
      payload.tools = [{ type: 'web_search_20250305', name: 'web_search' }]
    }

    if (system) {
      // Breakpoint on the (stable) system block caches tools + system across turns
      payload.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
    }

    const depth = opts?.effort
    if (depth !== undefined) {
      if (this.isModernModel(model)) {
        // Opus 4.6+: adaptive thinking + effort parameter.
        // 0 = minimal: thinking off, via the explicit `thinking.disabled` switch. Omitting `thinking`
        // is NOT off — 4.6/4.7/4.8 default to no-thinking, but the 5 family thinks by default, so
        // silence bought thinking there anyway, and hid it (`display` defaults to 'omitted').
        // `disabled` is rejected above effort `high`. The dial now reaches `max` (4), but only ever
        // pairs `disabled` with effort `low` below, so the two can't collide.
        if (depth === 0) {
          if (!this.alwaysThinks(model)) payload.thinking = { type: 'disabled' }
          payload.output_config = { effort: 'low' }
        } else {
          const effortMap: Record<1 | 2 | 3 | 4, 'low' | 'medium' | 'high' | 'max'> = {
            1: 'low',
            2: 'medium',
            3: 'high',
            4: 'max'
          }
          // display defaults to 'omitted' on Fable 5 / Mythos 5 / Opus 4.7+ / Sonnet 5 (a silent change from
          // Opus 4.6 / Sonnet 4.6, which defaulted to 'summarized') — thinking still happens and is billed,
          // but streams with empty text unless requested explicitly.
          payload.thinking = { type: 'adaptive', display: 'summarized' }
          payload.output_config = { effort: effortMap[depth] }
        }
      } else if (depth !== 0) {
        // Older models: manual thinking with budget_tokens. 0 = minimal → omit `thinking` entirely (off);
        // budget_tokens: 0 is rejected, so there's no "tiny budget" rung below the smallest here.
        const budgetMap: Record<1 | 2 | 3 | 4, number> = {
          1: 2048,
          2: 4096,
          3: 8192,
          4: 16384
        }
        payload.thinking = {
          type: 'enabled',
          budget_tokens: budgetMap[depth]
        }
      }
    }

    return payload
  }

  // ── Response parsing ─────────────────────────────────────────────

  parseNonStreamingResponse(json: ProviderResponseDto): ChatResponseDto {
    if (!this.isAnthropicResponse(json)) {
      return { text: '' }
    }

    const text = json.content
      .filter((block): block is AnthropicTextContent => block.type === 'text')
      .map(block => block.text)
      .join('')

    const reasoning = json.content
      .filter((block): block is AnthropicThinkingContent => block.type === 'thinking')
      .map(block => block.thinking)
      .join('\n\n')

    return { text, reasoning: reasoning || undefined }
  }

  protected parseProviderStreamChunk(json: ProviderStreamEventDto): ChatStreamPieceDto | null {
    if (!this.isAnthropicEvent(json)) return null

    switch (json.type) {
      case 'content_block_delta':
        if (json.delta.type === 'text_delta') {
          return { text: json.delta.text || '' }
        }
        if (json.delta.type === 'thinking_delta') {
          return { reasoning: json.delta.thinking || '' }
        }
        return null

      default:
        return null
    }
  }

  // ── Private helpers ──────────────────────────────────────────────

  /**
   * Cache breakpoints on the final two messages. The last extends conversations whose tail is the
   * new user turn (tb.ai bulbs, chat/raw modes); the second-to-last covers code-mode chat payloads,
   * whose tail is an ephemeral script-context message rebuilt every turn — there the durable
   * conversation prefix ends one message earlier, so a last-only breakpoint would never be hit.
   */
  private withTailMessagesCached(messages: ChatMessageDto[]): AnthropicMessage[] {
    const firstCached = Math.max(0, messages.length - 2)
    return messages.map((m, i) =>
      i >= firstCached
        ? { role: m.role, content: [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }] }
        : m
    )
  }

  private isAnthropicResponse(json: unknown): json is AnthropicNonStreamingResponseDto {
    return typeof json === 'object' && json !== null
      && (json as AnthropicNonStreamingResponseDto).type === 'message'
      && Array.isArray((json as AnthropicNonStreamingResponseDto).content)
  }

  private isAnthropicEvent(json: unknown): json is AnthropicSseEventDto {
    return typeof json === 'object' && json !== null && 'type' in json
  }

  /**
   * Claude 4.6+ (including the entire 5 family): adaptive thinking + `output_config.effort`,
   * higher output limit. Older models use legacy `thinking.type: 'enabled'` + `budget_tokens`.
   *
   * Version IDs come in two shapes and the minor is OPTIONAL:
   *   - `claude-opus-4-8`, `claude-haiku-4-5-20251001` — major-minor
   *   - `claude-sonnet-5`, `claude-fable-5`            — the 5 family dropped the minor
   * A two-group regex misses the single-number ids, misreading Sonnet 5 as pre-4.6 and sending it
   * down the legacy `thinking.type: 'enabled'` path — which the 5 family rejects outright
   * ("use thinking.type.adaptive and output_config.effort"). `[a-z]+` (not `\w+`) also avoids
   * matching the number-first legacy names (`claude-3-5-sonnet`), which stay non-modern.
   */
  private isModernModel(model: string): boolean {
    const m = model.match(/^claude-[a-z]+-(\d+)(?:-(\d+))?/i)
    if (!m) return false
    const major = +m[1]
    const minor = m[2] ? +m[2] : 0
    return major > 4 || (major === 4 && minor >= 6)
  }

  /** Fable / Mythos think unconditionally: `thinking.disabled` is a 400 on them, not a no-op, so
   *  minimal floors to low-effort thinking instead of off. */
  private alwaysThinks(model: string): boolean {
    return /^claude-(fable|mythos)\b/i.test(model)
  }

  private getMaxTokens(model: string): number {
    return this.isModernModel(model) ? 64000 : 32000
  }

}
