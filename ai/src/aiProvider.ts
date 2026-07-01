import type {
  ChatMessageDto,
  UpstreamErrorDto,
  EffortLevel,
  ChatStreamPieceDto,
  ChatResponseDto,
  ProviderResponseDto,
  ProviderStreamEventDto,
  StreamErrorCode
} from './protocol.js'

/** Options for building chat request payloads */
export type ChatRequestOpts = { effort?: EffortLevel; webSearch?: boolean } | undefined

/**
 * Error thrown by provider stream parsing when the provider or server reports an error.
 * Carries structured error info (code, retryable) so callers can handle appropriately.
 */
export class ProviderStreamError extends Error {
  constructor(
    message: string,
    public readonly code: StreamErrorCode = 'unknown',
    public readonly retryable: boolean = false
  ) {
    super(message)
  }
}

/**
 * Unified base class for all AI providers.
 * Handles both request building (outbound) and response parsing (inbound).
 */
export abstract class AIProvider {
  protected abstract readonly providerName: string
  abstract readonly defaultBaseUrl: string
  abstract readonly path: string

  // ── Request building (outbound) ──────────────────────────────────

  /**
   * Get the request path. Override for providers that need dynamic paths (e.g., model in URL).
   */
  getPath(_model: string, _stream: boolean): string {
    return this.path
  }

  abstract buildHeaders(apiKey: string, origin?: string): Record<string, string>

  abstract buildPayload(
    messages: ChatMessageDto[],
    model: string,
    opts: ChatRequestOpts,
    stream: boolean
  ): unknown

  abstract parseError(errorText: string, status: number): UpstreamErrorDto

  // ── Response parsing (inbound) ───────────────────────────────────

  abstract parseNonStreamingResponse(json: ProviderResponseDto): ChatResponseDto

  /**
   * Parse a streaming chunk. Handles server errors (rate limit, etc.) before
   * delegating to provider-specific parsing.
   */
  parseStreamChunk(json: ProviderStreamEventDto): ChatStreamPieceDto | null {
    this.checkAndThrowError(json)
    return this.parseProviderStreamChunk(json)
  }

  protected abstract parseProviderStreamChunk(json: ProviderStreamEventDto): ChatStreamPieceDto | null

  // ── Shared helpers ───────────────────────────────────────────────

  protected isReasoningEnabled(opts: { effort?: EffortLevel } | undefined): boolean {
    return opts?.effort !== undefined
  }

  /** Split system messages from conversation messages. */
  protected extractSystemMessages(messages: ChatMessageDto[], separator = '\n\n'): {
    system: string | undefined
    conversationMessages: ChatMessageDto[]
  } {
    const systemParts = messages.filter(m => m.role === 'system').map(m => m.content)
    return {
      system: systemParts.length ? systemParts.join(separator) : undefined,
      conversationMessages: messages.filter(m => m.role !== 'system')
    }
  }

  /**
   * Parse JSON error response with nested error object (common OpenAI/Anthropic format)
   */
  protected parseJsonError(errorText: string, status: number, includeCode = false): UpstreamErrorDto {
    if (!errorText) {
      return { message: `HTTP ${status}` }
    }

    try {
      const parsed = JSON.parse(errorText)
      if (parsed.error && typeof parsed.error === 'object') {
        const result: UpstreamErrorDto = {
          message: parsed.error.message || `HTTP ${status}`,
          type: parsed.error.type
        }
        if (includeCode) {
          result.code = parsed.error.code
        }
        return result
      }
      if (parsed.message) {
        return { message: parsed.message }
      }
      return { message: errorText }
    } catch {
      return { message: errorText }
    }
  }

  /**
   * Check if the JSON contains an error and throw if so.
   * Handles two formats:
   * - Unified format: { type: 'error', code, message, retryable }
   * - Provider format: { error: "message" } or { error: { message: "..." } }
   */
  private checkAndThrowError(json: unknown): void {
    if (typeof json !== 'object' || json === null) return
    const obj = json as Record<string, unknown>
    // Unified error format (used by both chat and infer endpoints)
    if (obj.type === 'error' && 'message' in obj) {
      const code = (obj.code as StreamErrorCode) || 'unknown'
      throw new ProviderStreamError(obj.message as string, code, !!obj.retryable)
    }
    // Provider error format (OpenAI/Anthropic style)
    if (obj.error) {
      throw new ProviderStreamError(this.extractErrorMessage(obj.error))
    }
  }

  private extractErrorMessage(error: unknown): string {
    if (typeof error === 'string') {
      try {
        const parsed = JSON.parse(error)
        return parsed.error?.message || parsed.message || error
      } catch {
        return error
      }
    }
    if (typeof error === 'object' && error !== null) {
      const err = error as Record<string, unknown>
      return (err.message as string) || JSON.stringify(error)
    }
    return `${this.providerName} returned an error`
  }
}
