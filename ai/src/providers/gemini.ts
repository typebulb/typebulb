/**
 * Native Google Gemini API (/v1beta/models/{model}:generateContent, streaming via
 * :streamGenerateContent?alt=sse) — wire types and provider implementation.
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

export type GeminiRole = 'user' | 'model' | 'system'

export interface GeminiTextPart {
  text: string
  /** When true, this part is a thought summary (reasoning), not answer text. */
  thought?: boolean
}

export interface GeminiContent {
  role: GeminiRole
  parts: GeminiTextPart[]
}

// Tool types for search grounding
export interface GeminiGoogleSearchTool {
  google_search: Record<string, never>  // Empty object enables search
}

export type GeminiTool = GeminiGoogleSearchTool

// Thinking config — asks Gemini to run (and return) reasoning.
export interface GeminiThinkingConfig {
  /** Surface thought summaries as `thought` parts in the response. */
  includeThoughts?: boolean
  /** Token budget for thinking; -1 = dynamic (model self-regulates depth). */
  thinkingBudget?: number
}

// Generation config
export interface GeminiGenerationConfig {
  temperature?: number
  topP?: number
  topK?: number
  maxOutputTokens?: number
  stopSequences?: string[]
  candidateCount?: number
  thinkingConfig?: GeminiThinkingConfig
}

// Response types
export type GeminiFinishReason =
  | 'FINISH_REASON_UNSPECIFIED'
  | 'STOP'
  | 'MAX_TOKENS'
  | 'SAFETY'
  | 'RECITATION'
  | 'LANGUAGE'
  | 'OTHER'

export interface GeminiCandidate {
  content: GeminiContent
  finishReason?: GeminiFinishReason
}

export interface GeminiPromptFeedback {
  blockReason?: string
}

// Non-streaming response
export interface GeminiResponseDto extends ProviderResponseDto {
  candidates?: GeminiCandidate[]
  promptFeedback?: GeminiPromptFeedback
}

// SSE streaming event - same structure as non-streaming, delivered incrementally
export type GeminiSseEventDto = GeminiResponseDto

// ── Provider implementation ──────────────────────────────────────────

/** Request payload for native Gemini API */
interface GeminiRequestPayload {
  contents: GeminiContent[]
  systemInstruction?: GeminiContent
  tools?: GeminiTool[]
  generationConfig?: GeminiGenerationConfig
}

export class GeminiProvider extends AIProvider {
  protected readonly providerName = 'Gemini'
  readonly defaultBaseUrl = 'https://generativelanguage.googleapis.com'
  readonly path = '/v1beta/models'

  // ── Request building ─────────────────────────────────────────────

  override getPath(model: string, stream: boolean): string {
    const method = stream ? 'streamGenerateContent' : 'generateContent'
    const queryParam = stream ? '?alt=sse' : ''
    return `/v1beta/models/${model}:${method}${queryParam}`
  }

  buildHeaders(apiKey: string): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey
    }
  }

  buildPayload(
    messages: ChatMessageDto[],
    _model: string,
    opts: ChatRequestOpts,
    _stream: boolean
  ): GeminiRequestPayload {
    const { system, conversationMessages } = this.extractSystemMessages(messages, '\n')

    const contents: GeminiContent[] = conversationMessages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    }))

    const payload: GeminiRequestPayload = { contents }

    // Enable search grounding by default, can be disabled via opts.webSearch = false
    if (opts?.webSearch !== false) {
      payload.tools = [{ google_search: {} }]
    }

    if (system) {
      payload.systemInstruction = {
        role: 'system',
        parts: [{ text: system }]
      }
    }

    // Map the 1-3 reasoning dial to a thinking budget so the effort selector actually controls depth
    // — mirroring how the OpenRouter path honors `effort` per level (native previously hardcoded
    // `thinkingBudget: -1`, always thinking maximally and ignoring the dial, which made native Gemini
    // look like it "always reasons" while OpenRouter respected the dial). `low` gets a small budget
    // (often below the summary threshold → blank, matching OpenRouter's `effort:'low'`); `high` uses
    // `-1` (dynamic, always in-range, no per-model max risk). `includeThoughts` streams thought
    // summaries as `thought` parts, which the parser maps to AiChunk `{ kind: "reasoning" }`.
    if (this.isReasoningEnabled(opts)) {
      const budgetMap: Record<EffortLevel, number> = { 1: 1024, 2: 8192, 3: -1 }
      payload.generationConfig = {
        thinkingConfig: { includeThoughts: true, thinkingBudget: budgetMap[opts!.effort!] }
      }
    }

    return payload
  }

  parseError(errorText: string, status: number): UpstreamErrorDto {
    if (!errorText) {
      return { message: `HTTP ${status}` }
    }

    try {
      const parsed = JSON.parse(errorText)

      // Native Gemini error format: { error: { code, message, status } }
      // Or array wrapped: [{ error: {...} }]
      const errorObj = Array.isArray(parsed)
        ? parsed[0]?.error
        : parsed?.error

      if (errorObj && typeof errorObj === 'object') {
        return {
          message: (errorObj.message || `HTTP ${status}`).split('\n')[0],
          type: errorObj.status,
          code: errorObj.code?.toString()
        }
      }

      if (parsed.message) {
        return { message: parsed.message }
      }

      return { message: errorText }
    } catch {
      return { message: errorText }
    }
  }

  // ── Response parsing ─────────────────────────────────────────────

  parseNonStreamingResponse(json: ProviderResponseDto): ChatResponseDto {
    this.checkGeminiError(json)

    if (!this.isGeminiResponse(json)) {
      return { text: '', status: 'failed', error: 'Invalid response format' }
    }

    const text = this.extractParts(json).text || ''
    const finishReason = json.candidates?.[0]?.finishReason

    let status: ChatResponseDto['status'] = 'complete'
    if (finishReason === 'MAX_TOKENS') {
      status = 'interrupted'
    } else if (finishReason === 'SAFETY' || finishReason === 'RECITATION') {
      status = 'failed'
    }

    return { text, status }
  }

  protected parseProviderStreamChunk(json: ProviderStreamEventDto): ChatStreamPieceDto | null {
    this.checkGeminiError(json)

    if (!this.isGeminiResponse(json)) return null

    const piece = this.extractParts(json)
    return (piece.text || piece.reasoning) ? piece : null
  }

  // ── Private helpers ──────────────────────────────────────────────

  private isGeminiResponse(json: unknown): json is GeminiResponseDto {
    return (
      typeof json === 'object' &&
      json !== null &&
      'candidates' in json &&
      Array.isArray((json as GeminiResponseDto).candidates)
    )
  }

  /** Split a candidate's parts into answer text and thought (reasoning) summaries — Gemini marks
   *  thought parts with `thought: true`. Returns the `{ text?, reasoning? }` stream-piece shape. */
  private extractParts(response: GeminiResponseDto): ChatStreamPieceDto {
    const parts = response.candidates?.[0]?.content?.parts
    if (!parts) return {}
    let text = '', reasoning = ''
    for (const part of parts) {
      if (!part.text) continue
      if (part.thought) reasoning += part.text
      else text += part.text
    }
    return { text: text || undefined, reasoning: reasoning || undefined }
  }

  private checkGeminiError(json: unknown): void {
    if (typeof json === 'object' && json !== null && 'error' in json) {
      const errorObj = (json as { error: unknown }).error

      let message: string
      if (typeof errorObj === 'string') {
        message = errorObj
      } else if (typeof errorObj === 'object' && errorObj !== null) {
        const err = errorObj as { message?: string; status?: string }
        message = err.message || err.status || 'Gemini returned an error'
      } else {
        message = 'Gemini returned an error'
      }

      throw new ProviderStreamError(message)
    }

    if (this.isGeminiResponse(json) && json.promptFeedback?.blockReason) {
      const reason = json.promptFeedback.blockReason
      throw new ProviderStreamError(`Prompt blocked: ${reason}`)
    }
  }
}
