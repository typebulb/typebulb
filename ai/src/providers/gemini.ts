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

export type GeminiThinkingLevel = 'minimal' | 'low' | 'medium' | 'high'

// Thinking config — asks Gemini to run (and return) reasoning. `thinkingBudget` (2.5-era) and
// `thinkingLevel` (3.x+) are mutually exclusive on the wire: sending both is a 400.
export interface GeminiThinkingConfig {
  /** Surface thought summaries as `thought` parts in the response. */
  includeThoughts?: boolean
  /** Token budget for thinking; -1 = dynamic (model self-regulates depth). */
  thinkingBudget?: number
  /** Semantic depth dial for Gemini 3.x+; replaces numeric budgets. */
  thinkingLevel?: GeminiThinkingLevel
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

  // 4 repeats 3's `-1`: dynamic already means "think maximally", so the dial's top rung has nowhere
  // higher to go on 2.5-era models — the clamp, expressed in the table.
  private readonly budgetMap: Record<EffortLevel, number> = { 0: 0, 1: 1024, 2: 8192, 3: -1, 4: -1 }

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
    model: string,
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

    const effort = opts?.effort
    if (effort !== undefined) {
      // Generation-gated like anthropic.ts: 3.x+ takes Google's semantic `thinkingLevel`; 2.5-era
      // and unrecognized aliases stay on numeric budgets (2.5's native dial, and the safe fallback —
      // Google back-compat remaps budgets on 3.x). Low's small budget often streams blank reasoning
      // (intended); `includeThoughts` streams thought summaries as `thought` parts (parser maps
      // them to reasoning), and at effort 0 there is nothing to stream, so it's dropped.
      const version = this.geminiVersion(model)
      const dial: GeminiThinkingConfig = version !== null && version >= 3
        ? { thinkingLevel: this.thinkingLevelFor(version, effort) }
        : { thinkingBudget: this.budgetMap[effort] }
      payload.generationConfig = {
        thinkingConfig: effort === 0 ? dial : { includeThoughts: true, ...dial },
      }
    }

    // Gemini nests it under generationConfig — merged rather than assigned, so it survives
    // alongside a thinkingConfig set above (and creates the object when effort was omitted).
    if (opts?.maxOutputTokens !== undefined) {
      payload.generationConfig = { ...payload.generationConfig, maxOutputTokens: opts.maxOutputTokens }
    }

    return payload
  }

  override parseError(errorText: string, status: number): UpstreamErrorDto {
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
    this.checkAndThrowError(json)
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

  /** Major.minor from a versioned model name (`gemini-3.5-flash` → 3.5); null for aliases. */
  private geminiVersion(model: string): number | null {
    const m = model.match(/^gemini-(\d+(?:\.\d+)?)/)
    return m ? Number(m[1]) : null
  }

  /** Dial → level, clamped to the family's supported enum: `minimal` is 3.5+; earlier 3.x floors at
   *  `low`. Gemini has no rung above `high`, so the dial's 4 clamps down to it — clamping, never a
   *  400, is the rule for a missing rung. (gemini-3-pro-preview's low|high-only enum would need a
   *  wider clamp, but Google retired the model — 404 verified 2026-07-15.) */
  private thinkingLevelFor(version: number, effort: EffortLevel): GeminiThinkingLevel {
    const level = (['minimal', 'low', 'medium', 'high', 'high'] as const)[effort]
    return level === 'minimal' && version < 3.5 ? 'low' : level
  }

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
    if (this.isGeminiResponse(json) && json.promptFeedback?.blockReason) {
      const reason = json.promptFeedback.blockReason
      throw new ProviderStreamError(`Prompt blocked: ${reason}`)
    }
  }
}
