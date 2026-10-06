import { readFileSync, statSync } from 'fs'
import type { AgentAdapter } from './adapter.js'
import type { ChildRow, ChildTranscript, Event, Thread } from '../events.js'

/** One entry's events as a view of `thread` renders them: the adapter's own, each stamped with the
 *  entry's timestamp (the child Status measures time from it), and in a child view every user turn
 *  marked authored, since nobody types into a child: its brief and follow-ups are the parent agent's
 *  markdown. Shared by the mirror's tail and a one-shot read, so both emit alike. */
export function entryEvents<E>(adapter: AgentAdapter<E>, entry: E, thread: Thread, sessionStartMs: number) {
  const r = adapter.apply(entry, sessionStartMs)
  const at = Date.parse(adapter.timestampOf(entry) ?? '')
  const events = r.events.map(e => {
    const out = thread === 'child' && e.type === 'user' ? { ...e, authored: true } : e
    if (!isNaN(at) && (out.type === 'user' || out.type === 'assistant' || out.type === 'tool_result' || out.type === 'task_done' || out.type === 'turn_end')) out.at = at
    return out
  })
  return { ...r, events }
}

export interface TranscriptIndex<E> {
  entries: Map<string, E>
  /** Index a batch of lines; the newest leaf among them, if any. */
  add(lines: string[], thread: Thread): string | undefined
}

/** One file's entries by id, built from its lines in the order written: each parsed, passed through
 *  the adapter's linker, then indexed. The linker keeps state across the file, so an index is made
 *  afresh per read. The mirror's tail and a one-shot read both build theirs here. */
export function transcriptIndex<E>(adapter: AgentAdapter<E>): TranscriptIndex<E> {
  const entries = new Map<string, E>()
  const linker = adapter.linker()
  return {
    entries,
    add(lines, thread) {
      let leaf: string | undefined
      for (const line of lines) {
        if (!line.trim()) continue
        const e = adapter.parseEntry(line)
        if (!e) continue
        linker.link(e)
        const id = adapter.idOf(e)
        if (!id) continue
        entries.set(id, e)
        // The live chain's leaf is the newest user/assistant entry ON THE VIEWED THREAD — never one
        // off it. (TB-LostMessage.md, TB-Agent-Children.md)
        if (!adapter.isSidechain(e, thread) && adapter.isLeafType(e)) leaf = id
      }
      return leaf
    },
  }
}

/** A transcript's events read once, whole: the live chain from its newest on-thread leaf to the
 *  root, as the mirror's first drain of a file emits it, minus the fork stubs and the watch. For a
 *  child judged without swapping into it (`typebulb status`, the agents menu's status link). */
export function readTranscript<E>(live: AgentAdapter<E>, file: string, thread: Thread): Event[] {
  // Never the live drain's own state: the mirror may be tailing another file with it right now.
  const adapter = live.forRead()
  let raw: string
  try { raw = readFileSync(file, 'utf8') } catch { return [] }
  const { entries, add } = transcriptIndex(adapter)
  const leaf = add(raw.split('\n'), thread)
  const chain: E[] = []
  const seen = new Set<string>()
  for (let id = leaf; id && !seen.has(id);) {
    const e = entries.get(id)
    if (!e) break
    seen.add(id)
    chain.push(e)
    id = adapter.parentOf(e)
  }
  const out: Event[] = []
  // Nothing in a finished read is live: the start is now, after every entry.
  const now = Date.now()
  for (const e of chain.reverse()) {
    if (adapter.isSidechain(e, thread)) continue
    try { out.push(...entryEvents(adapter, e, thread, now).events) } catch {}
  }
  return out
}

/** Whether a session's process is alive: the adapter's pid store where it keeps one, else a file
 *  written in the last few seconds, so an idle session without one doesn't read as working. */
export function sessionLive<E>(adapter: AgentAdapter<E>, sessionId: string, cwd: string, file: string | undefined): boolean {
  const known = adapter.sessionAlive(sessionId, cwd)
  if (known !== undefined) return known
  if (!file) return false
  try { return Date.now() - statSync(file).mtimeMs < 10_000 } catch { return false }
}

/** The adapter reads whether a child is mid-turn from the child's own file; the engine adds only
 *  what the file can't say — a child of a dead process is finished, whatever its tail shows. */
export function childState(c: ChildTranscript, live: boolean): ChildRow['state'] {
  if (c.stopped) return 'stopped'
  return c.running && live ? 'running' : 'done'
}
