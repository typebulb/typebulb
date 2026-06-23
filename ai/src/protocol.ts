export * from './chat.js'
export * from './stream.js'

/** AI provider wire protocol identifier.
 *  `ollama` is CLI-only (talks to a local server over its OpenAI-compatible endpoint); it
 *  resolves with no API key and is never reachable from the web runtime. See
 *  specs/TB-AI-Local-Models.md. */
export type ProviderProtocol = 'openai' | 'anthropic' | 'openrouter' | 'gemini' | 'ollama'

/** Extended-thinking hint, 0 (off) – 3 (max) */
export type ReasoningDepth = 0 | 1 | 2 | 3

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
}
