/**
 * Generic utilities for parsing Server-Sent Events (SSE) streams.
 * Shared between client, CLI, and any other consumer of provider SSE streams.
 */

import type { ProviderProtocol, AiChunk, ChatStreamPieceDto } from './protocol.js'
import { getProvider } from './aiProviders.js'

/** Find next SSE block separator (\n\n or \r\n\r\n), returning position and length */
function findSeparator(buffer: string): { pos: number; len: number } {
  const rnrn = buffer.indexOf('\r\n\r\n')
  const nn = buffer.indexOf('\n\n')
  if (rnrn !== -1 && (nn === -1 || rnrn < nn)) return { pos: rnrn, len: 4 }
  if (nn !== -1) return { pos: nn, len: 2 }
  return { pos: -1, len: 0 }
}

/**
 * Parses an SSE block (text between \n\n delimiters) into a data payload.
 * Handles multiple data: lines and the [DONE] sentinel.
 */
export function parseSseBlock<T = any>(block: string): T | 'done' | null {
  const lines = block.split(/\r?\n/)
  const dataLines = lines.filter(l => l.startsWith('data:'))

  if (!dataLines.length) return null

  const payloadStr = dataLines
    .map(l => l.replace(/^data:\s?/, ''))
    .join('\n')
    .trim()

  if (!payloadStr) return null
  if (payloadStr === '[DONE]') return 'done'

  try {
    return JSON.parse(payloadStr) as T
  } catch {
    return null
  }
}

/**
 * Reads an SSE stream and emits parsed chunks via callback.
 * Handles buffering, block splitting, and error recovery.
 *
 * @param reader - ReadableStream reader to consume
 * @param onChunk - Callback invoked for each parsed non-null chunk
 * @param signal - Optional abort signal for cancellation
 * @returns Object with whether any data was received
 */
export async function consumeSseStream<T = any>(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onChunk: (chunk: T) => void,
  signal?: AbortSignal
): Promise<{ receivedAnyData: boolean }> {
  // "Any bytes read", not "any chunk parsed" — callers use it to tell a dead connection
  // (failed) from a stream that died mid-flight (interrupted).
  let receivedAnyData = false
  for await (const chunk of consumeSseStreamGen<T>(reader, signal, () => { receivedAnyData = true })) {
    onChunk(chunk)
  }
  return { receivedAnyData }
}

/**
 * Pull-based twin of {@link consumeSseStream}: yields each parsed SSE block as it arrives so a
 * caller can `for await` the stream (and tear it down by breaking the loop). Same framing and
 * `[DONE]` handling; single-sources the SSE parsing. Cancels the reader on early exit; throws
 * on abort so callers' error paths fire.
 */
export async function* consumeSseStreamGen<T = any>(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
  onBytes?: () => void
): AsyncGenerator<T> {
  const decoder = new TextDecoder()
  let buffer = ''

  // reader.read() can block for seconds after cancel; race against abort for immediate exit
  const abortPromise: Promise<never> | null = signal
    ? new Promise<never>((_, reject) => {
        if (signal.aborted) reject(new Error('Aborted'))
        signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true })
      })
    : null

  try {
    while (true) {
      const { done, value } = abortPromise
        ? await Promise.race([reader.read(), abortPromise])
        : await reader.read()
      if (done) {
        // Process any remaining buffer content
        if (buffer.trim()) {
          const parsed = parseSseBlock<T>(buffer)
          if (parsed !== null && parsed !== 'done') yield parsed
        }
        return
      }
      onBytes?.()
      buffer += decoder.decode(value, { stream: true })
      let { pos: sep, len: sepLen } = findSeparator(buffer)
      while (sep !== -1) {
        const block = buffer.slice(0, sep)
        buffer = buffer.slice(sep + sepLen)
        const parsed = parseSseBlock<T>(block)
        if (parsed === 'done') return
        if (parsed !== null) yield parsed
        ;({ pos: sep, len: sepLen } = findSeparator(buffer))
      }
    }
  } finally {
    try { await reader.cancel() } catch { /* already closed */ }
  }
}

/**
 * Consume a provider SSE stream into a single text string.
 * Handles protocol detection, chunk parsing, and reasoning token filtering.
 *
 * @param response - Fetch Response with SSE body (from server or provider directly)
 * @param protocol - Provider protocol. If omitted, read from X-Provider-Protocol header.
 * @returns Accumulated text content (reasoning tokens discarded)
 */
export async function consumeStreamText(
  response: Response,
  protocol?: ProviderProtocol
): Promise<string> {
  if (!response.body) throw new Error('Response body is missing')
  // The text projection of streamAiChunks: accumulate `text` deltas, drop reasoning. Protocol
  // resolution, SSE framing, and error-event handling all live there, single-sourced.
  let fullText = ''
  for await (const chunk of streamAiChunks(response, protocol)) {
    if (chunk.kind === 'text') fullText += chunk.text
  }
  return fullText
}

/**
 * Adapt a provider's SSE Response into a pull stream of public {@link AiChunk}s — the shared
 * SSE→AiChunk conversion behind `tb.ai.stream()`, used by both the CLI bridge and the web sandbox
 * bridge (each then wraps it in its own transport: NDJSON over HTTP / postMessage frames). Pure and
 * browser-safe: only a `Response` reader plus the already-shared parsing. Each internal
 * `{ text?, reasoning? }` piece becomes one or two discriminated chunks (reasoning before text).
 * A provider error event throws `ProviderStreamError` out of `parseStreamChunk`, which the caller's
 * transport turns into a terminal error so the client iterator rejects.
 */
export async function* streamAiChunks(
  response: Response,
  protocol?: ProviderProtocol
): AsyncGenerator<AiChunk> {
  // Like consumeStreamText: if no protocol is passed, read it from the server-set header (the web
  // bridge doesn't track the resolved protocol; the CLI passes it explicitly).
  const p = protocol
    ?? (response.headers.get('X-Provider-Protocol') || 'openai') as ProviderProtocol
  const spec = getProvider(p)
  if (!response.body) return
  const reader = response.body.getReader()
  for await (const json of consumeSseStreamGen(reader)) {
    const piece = spec.parseStreamChunk(json) as ChatStreamPieceDto | null
    if (piece?.reasoning) yield { kind: 'reasoning', text: piece.reasoning }
    if (piece?.text) yield { kind: 'text', text: piece.text }
  }
}
