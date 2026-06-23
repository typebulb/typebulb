/**
 * The shared chunk transport for streaming server responses (specs/Streaming.md): an
 * `AsyncIterable` tunneled to the browser as newline-delimited JSON over the existing bridge
 * `POST` response. Used by both `tb.server.<gen>()` (async-generator exports) and
 * `tb.ai.stream()`. One line per item, each an envelope so a mid-stream error is distinguishable
 * from a value and user-yielded data can't collide with control signals:
 *
 *   {"type":"chunk","value":<v>}   — one yielded value
 *   {"type":"error","error":{message,code,retryable}}  — the source threw mid-stream
 *   (stream end = the response body closing normally)
 *
 * Cancellation: if the browser disconnects (the consumer breaks its `for await`, unmounts, or
 * aborts), Hono fires `onAbort`; we `.return()` the source iterator, which aborts the upstream
 * fetch inside an async generator's `finally`. This is what makes streaming "actually save
 * compute" rather than just "look streamed".
 */
import type { Context } from 'hono'
import { stream } from 'hono/streaming'
import { ProviderStreamError } from 'typebulb/ai'

/** Response header marking an NDJSON stream so the client shim consumes it as chunks rather than
 *  awaiting a single JSON body. */
export const TB_STREAM_HEADER = 'X-TB-Stream'

interface StreamErrorEnvelope {
  message: string
  code: string
  retryable: boolean
}

function toStreamError(e: unknown): StreamErrorEnvelope {
  if (e instanceof ProviderStreamError) {
    return { message: e.message, code: e.code, retryable: e.retryable }
  }
  return { message: e instanceof Error ? e.message : 'Unknown error', code: 'unknown', retryable: false }
}

/** Stream an async iterable to the client as enveloped NDJSON. */
export function streamNdjson(c: Context, source: AsyncIterable<unknown>): Response {
  c.header('Content-Type', 'application/x-ndjson; charset=utf-8')
  c.header('Cache-Control', 'no-cache')
  c.header(TB_STREAM_HEADER, '1')

  return stream(c, async (s) => {
    const iter = source[Symbol.asyncIterator]()
    // Client disconnect → tear down the source so the upstream (Ollama, a DB cursor, …) stops.
    s.onAbort(() => { void iter.return?.() })
    try {
      while (true) {
        const { done, value } = await iter.next()
        if (done) break
        await s.writeln(JSON.stringify({ type: 'chunk', value }))
      }
    } catch (e) {
      // A throw after partial yields: surface it as a terminal error line so the client iterator
      // rejects (its `try/catch` around `for await` fires) instead of silently truncating.
      await s.writeln(JSON.stringify({ type: 'error', error: toStreamError(e) }))
    } finally {
      try { await iter.return?.() } catch { /* already done */ }
    }
  })
}
