// ── Chat types (shared across all providers) ─────────────────────────

export type ChatRole = 'user' | 'assistant' | 'system'

export interface ChatMessageDto {
  role: ChatRole
  content: string
}

export interface ChatResponseDto {
  text: string
  reasoning?: string
  status?: 'complete' | 'interrupted' | 'failed' | 'cancelled'
  error?: string
  usage?: AiUsage
}

// Generic upstream error
export interface UpstreamErrorDto {
  message: string
  type?: string
  code?: string
}

// Stream piece emitted to UI/callers
export interface ChatStreamPieceDto {
  text?: string
  reasoning?: string
  /** Partial by design: providers deliver usage across events (Anthropic: input at message_start,
   *  output at message_delta), so each piece carries what its event knew. `streamAiChunks` merges
   *  field-wise (later wins — counts are cumulative) into the one final `usage` chunk. */
  usage?: Partial<AiUsage>
}

/** A provider's raw JSON response body. Each AIProvider narrows it to its own DTO — the interfaces that extend this (see providers/*). */
export interface ProviderResponseDto { [key: string]: unknown }

/** One raw JSON SSE event from a provider stream. Each AIProvider casts it to its own *SseEventDto (see providers/*). */
export interface ProviderStreamEventDto { [key: string]: unknown }

// ── SSE streaming types (chat and inference endpoints share the same error format) ──

/** Error codes for streaming API failures */
export type StreamErrorCode = 'rate_limit' | 'context_exceeded' | 'parse_error' | 'network' | 'unknown'

/** Base error payload (shared between SSE responses and postMessage) */
export interface StreamErrorPayload {
  code?: StreamErrorCode
  message: string
  retryable?: boolean
}

/**
 * SSE error event format (adds type discriminator).
 * Used by both /api/chat/stream and /api/infer endpoints.
 */
export interface StreamErrorDto extends Required<StreamErrorPayload> {
  type: 'error'
}

/** AI provider wire protocol identifier. `ollama` and `openai-compat` are CLI-only: both talk to an
 *  OpenAI-compatible endpoint (local, self-hosted, or remote) and are never reachable from the web
 *  runtime. `ollama` is the zero-config preset; `openai-compat` is the generic form. See
 *  runtime-specs/TB-Custom-Providers.md. */
export type ProviderProtocol = 'openai' | 'anthropic' | 'openrouter' | 'gemini' | 'ollama' | 'openai-compat'

/** Reasoning effort hint: 0 (minimal) – 4 (xhigh). 0 minimizes reasoning, mapped to each provider's
 *  least rung — OpenAI/OpenRouter `none` (`minimal` is model-gated, so `none` is the robust floor),
 *  Gemini `thinkingBudget: 0`, Anthropic no-thinking on Opus (or `low` where thinking can't be
 *  disabled). Higher levels are `low`/`medium`/`high`, then 4 = the rung above high where the vendor
 *  has one (OpenAI/OpenRouter `xhigh`, Anthropic `max`) and `high` where it doesn't (Gemini) — a
 *  missing rung clamps, never errors. Omitting is the model's own *default*, not
 *  "off" — a native-default reasoner (GPT-5.6: medium) then thinks and bills invisibly. 0 floors to
 *  the lowest available thinking only on always-thinking models. */
export type EffortLevel = 0 | 1 | 2 | 3 | 4

/** Narrow an untrusted number to the dial, or `undefined` if it isn't one. 0 is a valid level, so a
 *  falsy check would silently coerce minimal to "omit" — which buys the provider default, not off. */
export const asEffort = (v: number | undefined | null): EffortLevel | undefined =>
  v != null && v >= 0 && v <= 4 ? v as EffortLevel : undefined

/** Pull a stored number onto the dial. Unlike `asEffort`, an out-of-range value is capped rather than
 *  dropped — for persisted settings, where the nearest level beats falling back to a provider default.
 *  The upper bound must track the dial's top if a level is ever added. */
export const clampEffort = (v: number): EffortLevel =>
  Math.max(0, Math.min(v, 4)) as EffortLevel

/** Provider-reported token counts for one call (TB-AI.md invariant 20). Normalized: `input` is
 *  the full prompt (cache reads included), `output` is total billed output (reasoning included),
 *  `reasoning`/`cacheRead` are the itemized subsets where the provider splits them (Anthropic
 *  doesn't split reasoning). Absent entirely when the provider reported nothing. */
export interface AiUsage {
  input: number
  output: number
  reasoning?: number
  cacheRead?: number
}

/** Fold one wire-piece usage fragment into an accumulation. Field-wise, later wins — providers
 *  report cumulative counts, so the last sighting of each field is the total. */
export const mergeUsage = (
  acc: Partial<AiUsage> | undefined,
  piece: Partial<AiUsage>
): Partial<AiUsage> => {
  const out: Partial<AiUsage> = { ...acc }
  for (const k of ['input', 'output', 'reasoning', 'cacheRead'] as const) {
    if (piece[k] !== undefined) out[k] = piece[k]
  }
  return out
}

/** Settle a partial usage accumulation into the public shape — or nothing, when no event ever
 *  reported a count (the whole-object absence bulbs test for). Missing halves settle to 0. */
export const finalizeUsage = (u: Partial<AiUsage> | undefined): AiUsage | undefined =>
  u === undefined || (u.input === undefined && u.output === undefined)
    ? undefined
    : { input: u.input ?? 0, output: u.output ?? 0, reasoning: u.reasoning, cacheRead: u.cacheRead }

/** A streamed delta from `tb.ai.stream()`. Discriminated union — exactly one kind per chunk, so
 *  `switch (chunk.kind)` is exhaustive and no `{}`/both-fields state is representable. The public
 *  shape; the internal wire piece (`ChatStreamPieceDto { text?, reasoning? }`) stays loose. */
export type AiChunk =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'usage'; usage: AiUsage }

/** What backs `tb.ai` for the current user: their own keys (`own`), the quota-limited courtesy
 *  model (`courtesy`), or nothing at all (`none` — the CLI without keys, an embedded bulb). Which
 *  hosts can answer which value is the host's business, not a bulb's; see runtime-specs/TB-AI.md. */
export type AiAccess = 'own' | 'courtesy' | 'none'

/** tb.models() response — model available to the current user */
export interface TbModelDto {
  /** Provider protocol: "anthropic", "openai", "gemini", "openrouter" */
  provider: string
  /** Model identifier, e.g. "claude-sonnet-4-6" */
  name: string
  /** Human-readable display name, e.g. "Sonnet 4.6" */
  friendlyName: string
  /** Provider display name, e.g. "Anthropic" */
  providerName: string
  /** True on the environment's configured default model (TB_AI_PROVIDER + TB_AI_MODEL); absent otherwise */
  default?: boolean
}
