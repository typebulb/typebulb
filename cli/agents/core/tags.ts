// Tags and brief conventions (TB-Agent-Board.md): an orchestrator's asks, decisions and todos, written
// as bold labels in its ordinary replies and read back from the transcript, plus the two brief lines
// the board's agent rows show. Pure and harness-neutral, so the mirror's board, `typebulb status` and
// babysit all read one parse.
import type { Event } from './events.js'
import { formatDuration as mins } from './format.js'

export const TAG_KINDS = ['Ask', 'Decided', 'Todo', 'Done', 'Finding'] as const
export type TagKind = typeof TAG_KINDS[number]

/** One tag as written. `turn` counts the user turns before it, so the asks of one reply share it. */
export interface Tag {
  kind: TagKind; id: string
  text: string                         // the paragraph after the label, as markdown
  question?: string; recommend?: string // an Ask, split at `*Recommend:*`
  at?: number
  turn: number
  from?: string                        // the child that wrote it; absent for the session's own
}

/** The owner's click on an ask, kept per session by the mirror. `version` is the ask it answered. */
export type AnswerChoice = 'accept' | 'todo' | 'discuss' | 'note'
export interface Answer { version: number; choice: AnswerChoice; recommend?: string; note?: string; at: number }

export type TagState = 'open' | 'answered' | 'decided' | 'todo' | 'done' | 'finding'
/** An id's tags: its latest is its state. `version` counts its asks. */
export interface TagThread { id: string; state: TagState; latest: Tag; ask?: Tag; version: number; first?: number; answer?: Answer }

// A label opening a paragraph or a list item. The colon may sit inside the bold or after it.
const LABEL = new RegExp(`^(?:[-*+]\\s+|\\d+[.)]\\s+)?\\*\\*(${TAG_KINDS.join('|')}) \\[([a-z0-9][a-z0-9-]*)\\]:?\\*\\*:?[ \\t]*`)
const RECOMMEND = /\*{1,2}Recommend:\*{1,2}\s*/
const FENCE = /^\s*(`{3,}|~{3,})/
const ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/

type ReplyTag = Omit<Tag, 'turn' | 'at' | 'from'>

/** The tags in one reply's text, outside fenced blocks. A tag's paragraph runs to a blank line, the
 *  next list item, or the next tag. */
export const tagsIn = (text: string): ReplyTag[] => scan(text).map(s => s.tag)

/** A reply's text cut after each Ask's paragraph, so its answer row can sit under the words that asked. */
export function splitAtAsks(text: string): { md: string; ask?: { id: string; text: string } }[] {
  const lines = text.split('\n')
  const out: { md: string; ask?: { id: string; text: string } }[] = []
  let from = 0
  for (const { tag, end } of scan(text)) {
    if (tag.kind !== 'Ask') continue
    out.push({ md: lines.slice(from, end).join('\n'), ask: { id: tag.id, text: tag.text } })
    from = end
  }
  out.push({ md: lines.slice(from).join('\n') })
  return out
}

// Each tag with `end`, the index of the line its paragraph stops before.
function scan(text: string): { tag: ReplyTag; end: number }[] {
  const out: { tag: ReplyTag; end: number }[] = []
  let fence = ''
  let cur: { kind: TagKind; id: string; lines: string[] } | undefined
  const flush = (end: number) => {
    if (!cur) return
    const body = cur.lines.join('\n').trim()
    const tag: ReplyTag = { kind: cur.kind, id: cur.id, text: body }
    if (cur.kind === 'Ask') {
      const [q, r] = body.split(RECOMMEND)
      tag.question = q!.trim()
      if (r?.trim()) tag.recommend = r.trim()
    }
    out.push({ tag, end })
    cur = undefined
  }
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const f = FENCE.exec(line)?.[1]
    if (fence) { if (f && f[0] === fence[0] && f.length >= fence.length) fence = ''; continue }
    if (f) { flush(i); fence = f; continue }
    const m = LABEL.exec(line.trimStart())
    if (m) { flush(i); cur = { kind: m[1] as TagKind, id: m[2]!, lines: [line.trimStart().slice(m[0].length)] }; continue }
    if (!cur) continue
    if (!line.trim() || ITEM.test(line)) { flush(i); continue }
    cur.lines.push(line.trim())
  }
  flush(lines.length)
  return out
}

/** Every tag in a transcript's events, in order: assistant text only, never a harness error notice. */
export function tagsOf(events: Event[], from?: string): Tag[] {
  const out: Tag[] = []
  let turn = 0
  for (const e of events) {
    if (e.type === 'cleared') { out.length = 0; turn = 0 }
    else if (e.type === 'user') turn++
    else if (e.type === 'assistant' && !e.error && e.text) out.push(...tagsIn(e.text).map(t => ({ ...t, turn, at: e.at, from })))
  }
  return out
}

/** Tags folded by id, the latest deciding each one's state, oldest first by first sighting. An ask
 *  written again word for word is the same ask (a compaction can carry a reply forward), so it does
 *  not bump the version an answer names. A closed thread keeps the answer its ask got. */
export function threadsOf(tags: Tag[], answers: Record<string, Answer> = {}): TagThread[] {
  const byId = new Map<string, TagThread>()
  for (const t of tags) {
    const th = byId.get(t.id) ?? { id: t.id, state: 'open' as TagState, latest: t, version: 0, first: t.at }
    if (t.kind === 'Ask' && th.ask?.text !== t.text) th.version++
    if (t.kind === 'Ask') th.ask = t
    th.latest = t
    byId.set(t.id, th)
  }
  for (const th of byId.values()) {
    const a = answers[th.id]
    th.answer = th.ask && a && a.version === th.version ? a : undefined
    if (th.latest.kind === 'Ask') th.state = th.answer ? 'answered' : 'open'
    else th.state = th.latest.kind.toLowerCase() as TagState
  }
  return [...byId.values()]
}

/** What the owner answered, as the wake line carries it. */
export function answerText(a: Answer): string {
  const head = a.choice === 'accept' ? `accept: ${a.recommend ?? ''}` : a.choice === 'todo' ? 'leave as todo' : a.choice === 'discuss' ? 'discuss' : ''
  return [head, a.note ? `note: "${a.note}"` : ''].filter(Boolean).join(' · ')
}
/** `[answer <id> v<N>] …`, a contract token: an orchestrator's `wait --match "[answer "` keys on it. */
export const answerLine = (id: string, a: Answer) => `[answer ${id} v${a.version}] ${answerText(a)}`

/** The session's asks as `typebulb status` prints them: how many wait on the owner, then each answer
 *  no closing tag has acknowledged yet. `answered, not acknowledged` is a contract phrase. */
export function asksLines(threads: TagThread[], now: number): string[] {
  const open = threads.filter(t => t.state === 'open')
  const answered = threads.filter(t => t.state === 'answered')
  if (!open.length && !answered.length) return []
  const oldest = Math.min(...open.map(t => t.ask?.at ?? now))
  return [
    open.length ? `Asks: ${open.length} waiting on the owner, the oldest for ${mins(now - oldest)}.` : 'Asks: none waiting on the owner.',
    ...answered.map(t => `  ${answerLine(t.id, t.answer!)}  (answered, not acknowledged)`),
  ]
}

/** A brief's first line, what the owner will see when the work is done, and its time box when a line
 *  of its own reads `**Time box:** 20m`. */
export interface Brief { line: string; boxMs?: number }
const BOX = /^\s*\*\*Time box:\*\*\s*(\S+)\s*$/m
export function briefOf(text: string): Brief {
  const first = text.split('\n').find(l => l.trim())?.trim() ?? ''
  const box = BOX.exec(text)?.[1]
  return { line: first.length > 200 ? first.slice(0, 200) + '…' : first, boxMs: box ? durationMs(box) : undefined }
}

/** `90s`, `8m`, `1.5h`; a bare number is minutes: `--slow`'s syntax (src/args.ts), which core can't import. */
export function durationMs(v: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)([smh]?)$/.exec(v)
  const ms = m ? Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000, '': 60_000 }[m[2] as 's' | 'm' | 'h' | ''] : 0
  return ms > 0 ? ms : undefined
}
