/**
 * The mirror's one cheap-model call, shared by the composer's paste naming (paste.ts) and the
 * transcript's local Summary tab (summarize.ts) — one ladder to keep current instead of a model id
 * per feature.
 *
 * The ladder is a KEY cascade, not a quality ranking: rung 1 is the model we want, the rest exist so
 * a user whose env has a different provider key still gets the feature. Transport/model failures
 * return undefined — callers can degrade; the separate readiness check lets Summary explain the one
 * failure a reader can act on: adding a supported key.
 *
 * Every rung must be a provider the user can put a spend ceiling on. These are calls TYPEBULB makes
 * on their behalf — paste naming fires with no gesture at all — so a runaway is ours to prevent, not
 * theirs to discover on a bill. Google's own API has no easy cap, so gemini may only ride here
 * through OpenRouter, never a direct GOOGLE_API_KEY. A user holding only a Google key therefore gets
 * no paste naming, which degrades quietly; the Summary tab stays advertised and its first click
 * explains which supported key to add.
 */
import { consumeStreamText, type ResolvedAIProvider } from 'typebulb/ai'
import { resolveLocalProvider, sendTbAi } from '../../../src/servers.js'

const CHEAP_MODELS: [string, string][] = [
  ['openrouter', 'openai/gpt-5.6-luna'],
  ['openai', 'gpt-5.6-luna'],
]

// The rungs whose provider key is present, in ladder order (resolveLocalProvider returns its
// complaint as a string rather than throwing).
function available(): ResolvedAIProvider[] {
  return CHEAP_MODELS
    .map(([provider, model]) => resolveLocalProvider(provider, model))
    .filter((r): r is ResolvedAIProvider => typeof r !== 'string')
}

/** True when some rung has a key. The mirror still advertises Summary when false, but uses this
 *  readiness result to offer setup rather than making an opaque failed request. */
export function cheapAiReady(): boolean { return available().length > 0 }

/** One completion, or undefined on any failure. One deadline covers the whole ladder — a slow first
 *  rung must not multiply the caller's wait. */
export async function cheapAi(prompt: string, timeoutMs: number, effort = 0): Promise<string | undefined> {
  const deadline = AbortSignal.timeout(timeoutMs)
  for (const resolved of available()) {
    try {
      const resp = await sendTbAi(resolved, {
        messages: [{ role: 'user', content: prompt }],
        effort,
        webSearch: false,
        signal: deadline,
      })
      if (resp.ok) {
        const text = (await consumeStreamText(resp, resolved.protocol)).trim()
        if (text) return text
      }
    } catch { /* timeout / network / parse — try the next rung */ }
    if (deadline.aborted) return undefined
  }
  return undefined
}
