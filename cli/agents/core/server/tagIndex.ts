import { closeSync, openSync, readSync, statSync } from 'fs'
import type { AgentAdapter } from './adapter.js'
import { entryEvents } from './transcript.js'
import { tagsIn, type Tag } from '../tags.js'

// A session's own tags (TB-Agent-Board.md), read incrementally: an orchestrator's transcript runs to
// 60 MB, so each refresh reads only what was appended, and each entry keeps just what the walk needs.
// The walk crosses compaction boundaries, where the mirror's own stops, since an ask made before one
// is still open after it.

interface Node { parent?: string; logical?: string; user: boolean; tags: Omit<Tag, 'turn' | 'from'>[] }
const CHUNK = 8 << 20

class TagIndex<E> {
  #adapter: AgentAdapter<E>
  #linker
  #offset = 0
  #partial = Buffer.alloc(0)
  #nodes = new Map<string, Node>()
  #leaf?: string
  #memo?: Tag[]

  constructor(adapter: AgentAdapter<E>, readonly file: string) {
    this.#adapter = adapter.forRead()
    this.#linker = this.#adapter.linker()
  }

  tags(): Tag[] {
    const grew = this.#read()
    if (this.#memo && !grew) return this.#memo
    // Leaf to root, then forward: a user turn counts toward the replies after it.
    const chain: Node[] = []
    const seen = new Set<string>()
    for (let id = this.#leaf; id && !seen.has(id);) {
      const n = this.#nodes.get(id)
      if (!n) break
      seen.add(id)
      chain.push(n)
      id = n.parent ?? n.logical
    }
    const out: Tag[] = []
    let turn = 0
    for (const n of chain.reverse()) {
      if (n.user) turn++
      for (const t of n.tags) out.push({ ...t, turn })
    }
    return this.#memo = out
  }

  // Appended bytes, indexed a chunk at a time. A file that shrank was rewritten, so it is read again
  // from the start.
  #read(): boolean {
    let size = 0
    try { size = statSync(this.file).size } catch { return false }
    if (size < this.#offset) { this.#offset = 0; this.#partial = Buffer.alloc(0); this.#nodes.clear(); this.#leaf = undefined; this.#linker = this.#adapter.linker() }
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
      try { events = entryEvents(a, e, 'main', now).events } catch {}
      const tags = events.flatMap(ev => ev.type === 'assistant' && !ev.error && ev.text ? tagsIn(ev.text).map(t => ({ ...t, at: ev.at })) : [])
      this.#nodes.set(id, { parent: a.parentOf(e), logical: a.logicalParentOf?.(e), user: events.some(ev => ev.type === 'user'), tags })
      if (!a.isSidechain(e, 'main') && a.isLeafType(e)) this.#leaf = id
    }
  }
}

// A few files' indexes, the newest used kept: the mirror's session, a babysit's, a status call's.
const KEEP = 4
const indexes = new Map<string, TagIndex<unknown>>()

/** The tags on a session transcript's live chain, read from where the last call left off. */
export function sessionTags<E>(adapter: AgentAdapter<E>, file: string | undefined): Tag[] {
  if (!file) return []
  let ix = indexes.get(file) as TagIndex<E> | undefined
  indexes.delete(file)
  ix ??= new TagIndex(adapter, file)
  indexes.set(file, ix as TagIndex<unknown>)
  for (const k of [...indexes.keys()].slice(0, Math.max(0, indexes.size - KEEP))) indexes.delete(k)
  return ix.tags()
}
