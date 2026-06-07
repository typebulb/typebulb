/**
 * Shared types for SSE streaming across chat and inference endpoints.
 * Both features use the same error format.
 */

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
