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

/** Reasoning effort hint: 0 (minimal) – 3 (high). 0 minimizes reasoning, mapped to each provider's
 *  least rung — OpenAI/OpenRouter `none` (`minimal` is model-gated, so `none` is the robust floor),
 *  Gemini `thinkingBudget: 0`, Anthropic no-thinking on Opus (or `low` where thinking can't be
 *  disabled). Higher levels are `low`/`medium`/`high`. Omit entirely for the model's own default. Note
 *  0 is a floor, not a guaranteed "off": always-thinking models degrade it to the lowest available
 *  thinking, and on adaptive models `low` already self-skips. */
export type EffortLevel = 0 | 1 | 2 | 3

/** A streamed delta from `tb.ai.stream()`. Discriminated union — exactly one kind per chunk, so
 *  `switch (chunk.kind)` is exhaustive and no `{}`/both-fields state is representable. The public
 *  shape; the internal wire piece (`ChatStreamPieceDto { text?, reasoning? }`) stays loose. */
export type AiChunk =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }

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
