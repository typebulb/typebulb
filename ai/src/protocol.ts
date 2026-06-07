export * from './chat.js'
export * from './stream.js'

/** AI provider wire protocol identifier */
export type ProviderProtocol = 'openai' | 'anthropic' | 'openrouter' | 'gemini'

/** Extended-thinking hint, 0 (off) – 3 (max) */
export type ReasoningDepth = 0 | 1 | 2 | 3

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
