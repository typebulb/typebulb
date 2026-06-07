/**
 * Common chat types shared across all providers
 */

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
