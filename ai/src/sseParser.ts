/**
 * Generic utilities for parsing Server-Sent Events (SSE) streams.
 * Shared between client, CLI, and any other consumer of provider SSE streams.
 */

import type { ProviderProtocol } from './protocol.js'
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
  const decoder = new TextDecoder()
  let buffer = ''
  let receivedAnyData = false

  // reader.read() can block for seconds after cancel; race against abort for immediate exit
  const abortPromise: Promise<never> | null = signal
    ? new Promise<never>((_, reject) => {
        if (signal.aborted) reject(new Error('Aborted'))
        signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true })
      })
    : null

  while (true) {
    const readResult = abortPromise
      ? await Promise.race([reader.read(), abortPromise])
      : await reader.read()
    const { done, value } = readResult
    if (done) {
      // Process any remaining buffer content
      if (buffer.trim()) {
        const parsed = parseSseBlock<T>(buffer)
        if (parsed !== null && parsed !== 'done') {
          onChunk(parsed)
        }
      }
      break
    }

    receivedAnyData = true
    buffer += decoder.decode(value, { stream: true })

    let { pos: sep, len: sepLen } = findSeparator(buffer)
    while (sep !== -1) {
      const block = buffer.slice(0, sep)
      buffer = buffer.slice(sep + sepLen)

      const parsed = parseSseBlock<T>(block)
      if (parsed === 'done') {
        buffer = ''
        break
      }
      if (parsed !== null) {
        onChunk(parsed)
      }

      ;({ pos: sep, len: sepLen } = findSeparator(buffer))
    }
  }

  return { receivedAnyData }
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
  const p = protocol
    // Header set by server on success. Missing = server-generated error SSE;
    // any provider parser handles it via checkAndThrowError's unified format.
    ?? (response.headers.get('X-Provider-Protocol') || 'openai') as ProviderProtocol
  const spec = getProvider(p)
  if (!response.body) throw new Error('Response body is missing')
  const reader = response.body.getReader()
  let fullText = ''

  await consumeSseStream(reader, (json: any) => {
    const piece = spec.parseStreamChunk(json)
    if (piece?.text) fullText += piece.text
  })

  return fullText
}
