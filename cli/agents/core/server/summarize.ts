/**
 * A prose turn's local Summary tab (TB-Agent-Mirror.md): one cheap-model call over that turn's prose,
 * made only when the reader clicks. The result is a VIEW — the mirror returns it, never writes it,
 * and the transcript underneath is untouched — so an unfaithful summary costs a toggle back.
 *
 * That licence is narrower than it reads, and the prompt below is shaped by it (tuned and measured
 * in TB-Summarize-Eval.md): a summary that reads thin or confusing is self-announcing and costs the
 * toggle, but a dropped qualification or flattened verdict reads CONFIDENT — the reader has no cue
 * to toggle, so the error is invisible and permanent. The prompt therefore protects the qualified
 * verdict and material conditions first, and treats exhaustive specifics as the compressible part.
 * The turn's user message rides along as clearly-framed CONTEXT: the eval showed seeing the question
 * cuts fabricated rationales (the cheap model's hardest failure at this rung) — at the price of
 * terser summaries, which is the trade readers preferred.
 */
import { cheapAi, cheapAiReady } from './cheapAi.js'

const TIMEOUT_MS = 20000
// A guard against a pathological turn, not a working limit — a prose turn runs a few thousand chars.
const MAX_CHARS = 24000

const PROMPT = `Summarize this assistant reply for someone who wants its substance without the prose.

- Markdown. Start with the direct answer, recommendation, result, or status. If it is qualified, put the qualification in that same opening sentence; do not make the reader infer it from later bullets.
- Preserve material limits and conditions that change the answer: exceptions, tradeoffs, prerequisites, uncertainty, incomplete validation, and clauses such as but, only when, unless, or if. Cut only filler hedges (for example, "I think" or "arguably") that change nothing.
- Keep concrete specifics that support the answer: numbers, file paths, identifiers, commands, decisions. Prefer the decisive specifics over exhaustive lists.
- Keep the reply's epistemic status exact: what it did, what it recommends, what it merely observes, and what it considers possible are all different. Never promote one to another — an observation into a recommendation, a proposal into a completed action, a pending check into a confirmed result. Do not add implications not stated in the reply.
- Cut preamble, restatement of the question, and repetition.
- Never write "the assistant" or "this reply" — write the content itself.
- Bullets when there are several points; otherwise use a sentence or two.
- Under 120 words, and shorter when nothing is lost.

Reply with the summary alone.

---

`

// Abridge a user message mechanically: head + tail with the middle replaced by a marker.
// Deterministic, no model call; head+tail keeps the ask (usually at the end) intact.
const abridge = (text: string, max = 4000): string => {
  if (text.length <= max) return text
  const half = Math.floor(max / 2) - 20
  return text.slice(0, half) + '\n\n[snipped for brevity]\n\n' + text.slice(text.length - half)
}

// userPrompt is the message the reply answers, when the client has it. The framing is load-bearing
// (TB-Summarize-Eval § Arm B): user text is a new fabrication surface, so the input must say the
// context is never content. Without it the call degrades to prompt + reply, the pre-context arm.
export type SummarizeResult =
  | { ok: true; text: string }
  | { ok: false; error: string; setup?: true }

export async function summarizeProse(text: string, userPrompt = ''): Promise<SummarizeResult> {
  const source = text.trim()
  if (!source) return { ok: false, error: 'nothing to summarize' }
  // Summary is deliberately advertised even without a cheap-model key. Tell the client before it
  // starts a doomed request so its click can teach the one-step setup instead of showing a failure.
  if (!cheapAiReady()) return { ok: false, error: 'Summary needs OPENROUTER_API_KEY or OPENAI_API_KEY in this project’s .env.', setup: true }
  const input = userPrompt.trim()
    ? PROMPT +
      'CONTEXT — the user message this reply answers. It is context only: never summarize it, and never report it as the reply\'s content.\n' +
      abridge(userPrompt.trim()) +
      '\n\nREPLY TO SUMMARIZE:\n' + source.slice(0, MAX_CHARS)
    : PROMPT + source.slice(0, MAX_CHARS)
  const summary = await cheapAi(input, TIMEOUT_MS, 1)
  return summary ? { ok: true, text: summary } : { ok: false, error: 'the model call failed or timed out' }
}
