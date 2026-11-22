import { closeSync, openSync, readSync, statSync } from 'fs'
import type { AgentAdapter } from './adapter.js'
import { entryEvents } from './transcript.js'
import { tagsIn, type Tag } from '../tags.js'
import { ganttFences } from '../plan.js'
import type { Event } from '../events.js'

// A session's own tags (TB-Agent-Board.md), read incrementally: an orchestrator's transcript runs to
// 60 MB, so each refresh reads only what was appended, and each entry keeps just what the walk needs.
// The walk crosses compaction boundaries, where the mirror's own stops, since an ask made before one
// is still open after it.
// The same read keeps the session's own background calls still running, which babysit reads.
// And the schedule's facts (TB-Agent-Schedule.md): the plans on the chain, the context after each
// response, and the session's own shell calls, cut to what a run needs.

// `starts`: the turn an entry begins, the plan's (an agent's report, a background call ending) or talk
// (a message typed to the session), so the schedule measures what the plan alone costs.
interface Node { parent?: string; logical?: string; user: boolean; tags: Omit<Tag, 'turn' | 'from'>[]; at?: number; plans: string[]; tokens?: number; starts?: 'plan' | 'talk' }
export interface PlanFacts { plans: { at: number; text: string }[]; points: { at: number; tokens: number; plan: boolean }[]; calls: Event[] }
const CHUNK = 8 << 20
// Babysit's own call runs for as long as babysit does, so it is never work the session waits on.
const BABYSIT = /\btypebulb\S*\s+babysit\b/

class TagIndex<E> {
  #adapter: AgentAdapter<E>
  #linker
  #offset = 0
  #partial = Buffer.alloc(0)
  #nodes = new Map<string, Node>()
  #leaf?: string
  #memo?: Tag[]
  #chainMemo?: Node[]
  #factsMemo?: Omit<PlanFacts, 'calls'>
  // Open background calls by call id, with when each went to the background; tasks name their call.
  #background = new Map<string, number | undefined>()
  #tasks = new Map<string, string>()
  #babysits = new Set<string>()
  // The session's shell calls and their results, off the chain too, as Status reads a child's.
  #calls: Event[] = []
  #callIds = new Set<string>()

  constructor(adapter: AgentAdapter<E>, readonly file: string) {
    this.#adapter = adapter.forRead()
    this.#linker = this.#adapter.linker()
  }

  // Leaf to root, then forward.
  #chain(): Node[] {
    const grew = this.#read()
    if (this.#chainMemo && !grew) return this.#chainMemo
    const chain: Node[] = []
    const seen = new Set<string>()
    for (let id = this.#leaf; id && !seen.has(id);) {
      const n = this.#nodes.get(id)
      if (!n) break
      seen.add(id)
      chain.push(n)
      id = n.parent ?? n.logical
    }
    this.#memo = this.#factsMemo = undefined
    return this.#chainMemo = chain.reverse()
  }

  tags(): Tag[] {
    const chain = this.#chain()
    if (this.#memo) return this.#memo
    // A user turn counts toward the replies after it.
    const out: Tag[] = []
    let turn = 0
    for (const n of chain) {
      if (n.user) turn++
      for (const t of n.tags) out.push({ ...t, turn })
    }
    return this.#memo = out
  }

  planFacts(): PlanFacts {
    const chain = this.#chain()
    if (!this.#factsMemo) {
      let turn: 'plan' | 'talk' | undefined
      const points: PlanFacts['points'] = []
      for (const n of chain) {
        turn = n.starts ?? turn
        if (n.at !== undefined && n.tokens) points.push({ at: n.at, tokens: n.tokens, plan: turn === 'plan' })
      }
      this.#factsMemo = { plans: chain.flatMap(n => n.at === undefined ? [] : n.plans.map(text => ({ at: n.at!, text }))), points }
    }
    return { ...this.#factsMemo, calls: this.#calls }
  }

  background(): (number | undefined)[] {
    this.#read()
    return [...this.#background.values()]
  }

  // Appended bytes, indexed a chunk at a time. A file that shrank was rewritten, so it is read again
  // from the start.
  #read(): boolean {
    let size = 0
    try { size = statSync(this.file).size } catch { return false }
    if (size < this.#offset) {
      this.#offset = 0; this.#partial = Buffer.alloc(0); this.#nodes.clear(); this.#leaf = undefined; this.#linker = this.#adapter.linker()
      this.#background.clear(); this.#tasks.clear(); this.#babysits.clear(); this.#calls = []; this.#callIds.clear()
    }
    if (size === this.#offset) return false
    let fd: number
    try { fd = openSync(this.file, 'r') } catch { return false }
    try {
      const buf = Buffer.alloc(Math.min(CHUNK, size - this.#offset))
      while (this.#offset < size) {
        const n = readSync(fd, buf, 0, Math.min(buf.length, size - this.#offset), this.#offset)
        if (!n) break
        this.#offset += n
        // A chunk can end mid-character as well as mid-line; the bytes after the last newline wait.
        const text = Buffer.concat([this.#partial, buf.subarray(0, n)])
        const cut = text.lastIndexOf(0x0a)
        this.#partial = Buffer.from(text.subarray(cut + 1))
        if (cut >= 0) this.#index(text.subarray(0, cut).toString('utf8'))
      }
    } finally { closeSync(fd) }
    return true
  }

  #index(text: string) {
    const a = this.#adapter
    const now = Date.now()
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      const e = a.parseEntry(line)
      if (!e) continue
      this.#linker.link(e)
      const id = a.idOf(e)
      if (!id) continue
      let events: ReturnType<typeof entryEvents>['events'] = []
      let usage: ReturnType<typeof entryEvents>['usage']
      try { ({ events, usage } = entryEvents(a, e, 'main', now)) } catch {}
      const tags = events.flatMap(ev => ev.type === 'assistant' && !ev.error && ev.text ? tagsIn(ev.text).map(t => ({ ...t, at: ev.at })) : [])
      const said = events.filter(ev => ev.type === 'assistant' && !ev.error) as Extract<Event, { type: 'assistant' }>[]
      const stamp = Date.parse(a.timestampOf(e) ?? '')
      this.#nodes.set(id, { parent: a.parentOf(e), logical: a.logicalParentOf?.(e), user: events.some(ev => ev.type === 'user'), tags,
        at: said[0]?.at ?? (Number.isFinite(stamp) ? stamp : undefined), plans: said.flatMap(ev => ev.text ? ganttFences(ev.text) : []),
        tokens: usage ? usage.in + usage.out + usage.cached + usage.cacheCreate : undefined,
        starts: events.some(ev => ev.type === 'user' && !ev.agent) ? 'talk' : events.some(ev => ev.type === 'task_done' || ev.type === 'user' && ev.agent) ? 'plan' : undefined })
      if (!a.isSidechain(e, 'main') && a.isLeafType(e)) this.#leaf = id
      // Off the chain too: a background call runs on whatever branch started it. A Code Mode script
      // counts with the shell calls: its own shell calls run inside it, so the script is the long run.
      for (const ev of events) {
        if (ev.type === 'assistant') {
          for (const t of ev.tools) if (BABYSIT.test(String(t.input?.command ?? ''))) this.#babysits.add(t.id)
          const runs = ev.tools.filter(t => t.input?.command !== undefined || t.input?.cmd !== undefined || typeof t.input?.code === 'string')
          if (runs.length) {
            for (const t of runs) this.#callIds.add(t.id)
            this.#calls.push({ type: 'assistant', text: '', thinking: '', live: false, at: ev.at,
              tools: runs.map(t => ({ id: t.id, name: t.name, input: { command: t.input.command ?? t.input.cmd, code: typeof t.input.code === 'string' ? t.input.code.slice(0, 200) : undefined, description: t.input.description } })) })
          }
        } else if (ev.type === 'tool_result' && this.#callIds.has(ev.id)) {
          this.#calls.push({ ...ev, content: ev.content.slice(-600), digest: undefined })
        }
        if (ev.type === 'tool_result' && ev.background && !this.#babysits.has(ev.id)) {
          this.#background.set(ev.id, ev.at)
          if (ev.task) this.#tasks.set(ev.task, ev.id)
        } else if (ev.type === 'task_done') {
          this.#calls.push(ev)
          this.#background.delete(ev.id ?? this.#tasks.get(ev.task ?? '') ?? '')
        }
      }
    }
  }
}

// A few files' indexes, the newest used kept: the mirror's session, a babysit's, a status call's.
const KEEP = 4
const indexes = new Map<string, TagIndex<unknown>>()

function indexOf<E>(adapter: AgentAdapter<E>, file: string): TagIndex<E> {
  let ix = indexes.get(file) as TagIndex<E> | undefined
  indexes.delete(file)
  ix ??= new TagIndex(adapter, file)
  indexes.set(file, ix as TagIndex<unknown>)
  for (const k of [...indexes.keys()].slice(0, Math.max(0, indexes.size - KEEP))) indexes.delete(k)
  return ix
}

/** The tags on a session transcript's live chain, read from where the last call left off. */
export function sessionTags<E>(adapter: AgentAdapter<E>, file: string | undefined): Tag[] {
  return file ? indexOf(adapter, file).tags() : []
}

/** The schedule's facts from a session transcript, read from where the last call left off. */
export function sessionPlanFacts<E>(adapter: AgentAdapter<E>, file: string | undefined): PlanFacts {
  return file ? indexOf(adapter, file).planFacts() : { plans: [], points: [], calls: [] }
}

/** When each of the session's own background calls still running went to the background, babysit's
 *  own left out. A call from an earlier process stays here, since no notice ever closes it. */
export function sessionBackground<E>(adapter: AgentAdapter<E>, file: string | undefined): (number | undefined)[] {
  return file ? indexOf(adapter, file).background() : []
}
