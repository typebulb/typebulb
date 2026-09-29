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

// The two failures every summary call shares: no cheap-model key (which the client turns into setup
// help rather than an error), and a call that came back empty.
const NOT_READY = { ok: false, error: 'Summary needs OPENROUTER_API_KEY or OPENAI_API_KEY in this project’s .env.', setup: true } as const
const CALL_FAILED = { ok: false, error: 'the model call failed or timed out' } as const

export async function summarizeProse(text: string, userPrompt = ''): Promise<SummarizeResult> {
  const source = text.trim()
  if (!source) return { ok: false, error: 'nothing to summarize' }
  // Summary is deliberately advertised even without a cheap-model key. Tell the client before it
  // starts a doomed request so its click can teach the one-step setup instead of showing a failure.
  if (!cheapAiReady()) return NOT_READY
  const input = userPrompt.trim()
    ? PROMPT +
      'CONTEXT — the user message this reply answers. It is context only: never summarize it, and never report it as the reply\'s content.\n' +
      abridge(userPrompt.trim()) +
      '\n\nREPLY TO SUMMARIZE:\n' + source.slice(0, MAX_CHARS)
    : PROMPT + source.slice(0, MAX_CHARS)
  const summary = await cheapAi(input, TIMEOUT_MS, 1)
  return summary ? { ok: true, text: summary } : CALL_FAILED
}

// A child's Status (TB-Agent-Children.md). `plan` turns one message from the parent
// (the brief, or a later follow-up) into a request line and its subtasks, once per message. `status`
// judges every subtask against the work log childStatus.ts digests (numbered tool lines, prose, sends,
// never raw results) plus facts it counted, and is re-run as the child grows. Both answer JSON.
const PLAN_PROMPT = `A coordinator sent this message to a sub-agent. Return JSON only:
{"request": "one or two plain sentences: what it asks for and what must be delivered", "subtasks": ["..."]}

Subtasks: in the message's own order, following its numbering if it has one. Each named deliverable belongs to a subtask. Omit orientation (reading docs or guidance): a subtask produces or decides something. At most 8, each a short imperative under 10 words. If the message assigns no new work (a status question, a notification), return "subtasks": [].

MESSAGE:
`

export interface ChildStatusInput { subtasks: string[]; log: string; facts: string; finished: boolean }

const STATUS_PROMPT = (s: ChildStatusInput) => `You report on a sub-agent's progress to whoever delegated the work, often an orchestrating agent. They will not read the log. They are deciding whether to intervene, re-scope or wait, so they want what the sub-agent has found, where each subtask stands, and anything unusual.

SUBTASKS:
${s.subtasks.map((t, i) => `${i + 1}. ${t}`).join('\n')}

The agent has ${s.finished ? 'FINISHED' : 'NOT finished; the log ends where it is now'}.

Return JSON only:
{"now": "...", "decision": "...",
 "rows": [{"id": 1, "status": "not_started | in_progress | done | blocked", "did": "...", "note": "...", "steps": [[a, b]], "evidence": [[a, b]]}],
 "offBrief": [{"what": "short phrase", "note": "...", "steps": [[a, b]]}]}

Rules:
- "now": one line, the sub-agent's current finding or working hypothesis at the end of the log: what it has established or suspects, with the decisive specific (the cause, the file, the number). Not what it is looking at. If it has finished, its outcome.
- "decision": one line when it is stuck, about to decide something the brief did not cover, or has left a question open for the delegator or owner to settle. Its own reports and messages are where it raises these ("an owner decision", "your call", "needs a ruling"): carry any such open question here, even when a row mentions it too. Otherwise "".
- One row per subtask, same ids. "steps" lists EVERY bracketed step range that worked on it: reading, attempts, failures and fixes, not only the result. Together the rows and offBrief should cover the whole log; ranges never overlap.
- "evidence" lists the few steps that show where it stands: the result for done, the latest work for in_progress.
- "done" only when the log shows the result. If the only evidence is the agent's own report, write "reported" in "did".
- "did" says what was achieved so far: outcome and state, not tool mechanics. For a done row, one short clause. For an in_progress row, what has been found or confirmed so far, never only what was examined ("Confirmed the per-stroke check drops stretches 3 and 6-10", not "Investigated the dropped stretches"); when nothing is established yet, the hypothesis being tested. A file name only when it is the deliverable. A not_started row has "did": "".
- Make the work the subject of every sentence ("Counted 14 references", "The build passes"); never refer to the agent itself, as "the agent", "it", or otherwise.
- Unfinished is not off track: a subtask not started yet is normal while earlier ones run.
- "note" only for something that would change what the delegator does: repeated failures, a problem found outside the task, a risk to the deliverable, unexpected time spent. Use the FACTS, which are counted. Most rows have no note, and a whole table rarely has more than two. Never a note: remaining work, a failure fixed at once, an instruction followed as directed, a remark on style, or anything "did" or "decision" already says.
- "offBrief": work the brief did not ask for, done by the sub-agent itself. Something it only saw is not its work: a file changed by someone else, shown in a status or a diff. Empty array if none.

FACTS (counted from the log):
${s.facts || 'none'}

LOG (steps numbered in brackets):
${s.log}`

// The status log may run long on a big child; keep its head (what it set out to do) and its tail
// (where it is now) rather than cutting the end off. Sized to hold every child measured on disk
// whole (the largest compressed log, of 502, was 71k chars).
const MAX_LOG_CHARS = 200_000
const headTail = (s: string) => s.length <= MAX_LOG_CHARS ? s
  : s.slice(0, MAX_LOG_CHARS / 3) + '\n[… earlier steps omitted …]\n' + s.slice(-MAX_LOG_CHARS * 2 / 3)

export type ChildPartResult = { ok: true; data: unknown } | { ok: false; error: string; setup?: true }

export async function childStatusPart(kind: 'plan' | 'status', payload: unknown): Promise<ChildPartResult> {
  if (!cheapAiReady()) return NOT_READY
  let prompt: string
  if (kind === 'plan') {
    const text = String(payload ?? '').trim()
    if (!text) return { ok: false, error: 'nothing to summarize' }
    prompt = PLAN_PROMPT + text.slice(0, MAX_CHARS)
  } else {
    const s = payload as ChildStatusInput
    if (!Array.isArray(s?.subtasks) || typeof s.log !== 'string') return { ok: false, error: 'nothing to summarize' }
    prompt = STATUS_PROMPT({ ...s, log: headTail(s.log) })
  }
  const reply = await cheapAi(prompt, TIMEOUT_MS * 2, 1)
  if (!reply) return CALL_FAILED
  try { return { ok: true, data: JSON.parse(reply.replace(/^```(?:json)?\s*|\s*```$/g, '')) } }
  catch { return { ok: false, error: 'the model answered in the wrong shape' } }
}
