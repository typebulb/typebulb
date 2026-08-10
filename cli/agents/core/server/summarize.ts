/**
 * The content view's summarize pill (TB-Agent-Mirror.md): one cheap-model call over a turn's prose,
 * made only when the reader clicks. The result is a VIEW — the mirror returns it, never writes it,
 * and the transcript underneath is untouched — so an unfaithful summary costs a toggle back, which
 * is what lets the prompt compress hard.
 */
import { cheapAi } from './cheapAi.js'

const TIMEOUT_MS = 20000
// A guard against a pathological turn, not a working limit — a prose turn runs a few thousand chars.
const MAX_CHARS = 24000

const PROMPT = `Summarize this assistant reply for someone who wants its substance without the prose.

- Markdown. Lead with the answer or the outcome, never a description of the reply.
- Keep every concrete specific verbatim: numbers, file paths, identifiers, commands, decisions.
- Cut preamble, restatement of the question, hedging, and anything explained twice.
- Never write "the assistant" or "this reply" — write the content itself.
- Bullets when the original made several points; a sentence or two when it made one.
- Under 120 words, and shorter when nothing is lost.

Reply with the summary alone.

---

`

export async function summarizeProse(text: string): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const source = text.trim()
  if (!source) return { ok: false, error: 'nothing to summarize' }
  const summary = await cheapAi(PROMPT + source.slice(0, MAX_CHARS), TIMEOUT_MS, 1)
  return summary ? { ok: true, text: summary } : { ok: false, error: 'the model call failed or timed out' }
}
