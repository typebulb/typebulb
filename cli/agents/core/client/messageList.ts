import { Component, div, span, a, pre, details, summary, svg, path, type HValues } from 'domeleon'
import type { ServerEvent, Tool, Msg, IRoot } from './types.js'
import { renderMarkdown, userMarkdown, splitBulbSegments } from './markdown.js'
import { CopyButton } from './copyButton.js'
import { BulbEmbed } from './bulbEmbed.js'
import { supersededFlags, chainPositions } from './chains.js'
import { asStr, turnClassFor, displayPath } from './util.js'

function toolSummary(input: Record<string, unknown>): string {
  if (!input || typeof input !== 'object') return ''
  return asStr(input.command) ?? asStr(input.file_path) ?? asStr(input.path) ?? asStr(input.pattern) ?? asStr(input.query) ?? asStr(input.url) ?? asStr(input.skill) ?? asStr(input.description) ?? ''
}

// A multi-line summary (a heredoc Bash command) must not break the one-line row: first line + '…'.
function oneLine(s: string): string {
  const nl = s.indexOf('\n')
  return nl === -1 ? s : s.slice(0, nl).trimEnd() + ' …'
}

// The one disclosure triangle every collapsible renders. SVG, not a font glyph — glyphs centre
// unpredictably (bulbsPill's icons hit the same thing); open is the same shape rotated by CSS.
const caret = (open: boolean) => svg({ class: ['caret-tri', open ? 'open' : ''], viewBox: '0 0 16 16', width: '10', height: '10' },
  path({ d: 'M4 1.5 L13 8 L4 14.5 Z', fill: 'currentColor' }))

// The abandoned-branch fork mark — an SVG ⑂ (U+2442 renders tiny from fallback fonts).
const forkIcon = () => svg({ class: 'fork-icon', viewBox: '0 0 16 16', width: '11', height: '11', fill: 'none' },
  path({ d: 'M4 2 V8 H12 V2 M8 8 V14', stroke: 'currentColor', strokeWidth: '1.8', strokeLineCap: 'square' }))

// A unified diff riding in a string input (patcher's `diff`, a pasted git patch). Content-sniffed —
// an @@ hunk header plus a +/- line — so any tool qualifies, no tool-name coupling; prose can't
// trip it (no line-anchored @@).
function looksLikeUnifiedDiff(s: string): boolean {
  return /^@@/m.test(s) && /^[+-]/m.test(s)
}

// Only the ± lines, banded like the Edit diff view — file headers, @@ markers, and context lines
// are patch protocol, not what changed. A ⋯ row separates hunks.
function udiffView(s: string) {
  const rows: ReturnType<typeof div>[] = []
  let pastFirstHunk = false
  for (const line of s.split('\n')) {
    if (line.startsWith('@@')) {
      if (pastFirstHunk) rows.push(div({ class: 'udiff-gap' }, '⋯'))
      pastFirstHunk = true
    } else if (/^[+-]/.test(line) && !line.startsWith('+++') && !line.startsWith('---')) {
      rows.push(div({ class: ['udiff-line', line.startsWith('+') ? 'udiff-add' : 'udiff-del'] }, line))
    }
  }
  return div({ class: 'udiff' }, rows)
}

// File-aware tools whose path should open in VS Code / Cursor on click.
const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep'])

// Edit tools whose diff is interesting enough to auto-expand in the live session.
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

function filePathOf(toolName: string, input: Record<string, unknown>): string | undefined {
  if (!FILE_TOOLS.has(toolName) || !input || typeof input !== 'object') return undefined
  return (asStr(input.file_path) ?? asStr(input.path)) || undefined
}

// Normalize each edit tool's input to (old → new) hunks. undefined = no diff view.
type Hunk = { old?: string; new?: string }
function diffHunks(t: Tool): Hunk[] | undefined {
  const i = t.input ?? {}
  switch (t.name) {
    case 'Edit':         return [{ old: asStr(i.old_string), new: asStr(i.new_string) }]
    case 'Write':        return [{ new: asStr(i.content) }]
    case 'NotebookEdit': return [{ new: asStr(i.new_source) }]
    case 'MultiEdit':    return Array.isArray(i.edits)
      ? i.edits.map((e: { old_string?: string; new_string?: string }) => ({ old: e?.old_string, new: e?.new_string }))
      : undefined
    default:             return undefined
  }
}

// mcp__linqpad-patcher__apply_patch → "Linqpad-patcher [apply_patch]". Lazy server match is CC's own
// split (a tool name containing __ survives); the bracket format is deliberately not CC's.
function toolDisplayName(name: string): string {
  const m = /^mcp__(.+?)__(.+)$/.exec(name)
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} [${m[2]}]` : name
}

// Unified-diff string inputs, if the tool carries any (patcher's patch/diff fields).
function patchesOf(t: Tool): string[] {
  return Object.values(t.input ?? {}).filter((v): v is string => typeof v === 'string' && looksLikeUnifiedDiff(v))
}

// TodoWrite's checklist input, or undefined for every other tool.
type TodoItem = { content?: string; status?: string; activeForm?: string }
function todosOf(t: Tool): TodoItem[] | undefined {
  return t.name === 'TodoWrite' && Array.isArray(t.input?.todos) ? t.input.todos as TodoItem[] : undefined
}

// "3/8 done · ◼ Verifying already-fixed findings" — counts plus the in-progress item's activeForm,
// replacing the boilerplate "Todos have been modified successfully…" result digest.
function todoDigest(todos: TodoItem[]): string {
  const done = todos.filter(td => td.status === 'completed').length
  const active = todos.find(td => td.status === 'in_progress')
  return `${done}/${todos.length} done${active ? ` · ◼ ${active.activeForm ?? active.content ?? ''}` : ''}`
}

// One-line summary of a turn's collapsed (intermediate) bubbles: step count +
// tool tally, e.g. "5 steps · Read, Edit ×2, Bash". Pure data, no inference.
function summarizeSteps(msgs: Msg[]): string {
  const counts = new Map<string, number>()
  for (const m of msgs) for (const t of m.tools) counts.set(toolDisplayName(t.name), (counts.get(toolDisplayName(t.name)) ?? 0) + 1)
  const tally = [...counts].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join(', ')
  const n = msgs.length
  return `${n} step${n === 1 ? '' : 's'}${tally ? ` · ${tally}` : ''}`
}

// Flip membership of a key in an expand/open Set. The mirror's collapsibles (tools, turns, embeds,
// forks) all toggle this way; callers add their own follow-up (update / recomputeChains).
function toggleInSet<T>(set: Set<T>, key: T): void {
  if (set.has(key)) set.delete(key); else set.add(key)
}

// Messages panel: scrolling area, bubbles, expanded-tool set, sticky-bottom.
// No optimistic render — the bulb drives nothing; turns appear only once CC
// writes them to the JSONL.
export class MessageList extends Component {
  messages: Msg[] = []
  openTools = new Set<string>()                    // tool ids whose body is expanded
  expandedTurns = new Set<number>()                // turn indices the user expanded past the collapsed summary
  expandedForks = new Set<number>()                // fork-stub msg ids whose abandoned branch the user expanded
  expandedEmbeds = new Set<string>()               // embed keys whose folded (superseded) version the user re-expanded
  copyButtons: CopyButton[] = []                   // public so domeleon discovers these child components
  bulbEmbeds: BulbEmbed[] = []                      // ditto — one per ````bulb```` embed across the transcript
  scrollEl?: HTMLElement

  #idSeq = 0
  #embedSeq = 0
  #superseded = new Set<BulbEmbed>()               // recomputed per chain pass; drives fold-vs-live in #renderBody
  #stuckToBottom = true

  get parent() { return this.ctx.parent as unknown as IRoot }

  // ===== Public mutators called by Root =====

  clear() {
    for (const e of this.bulbEmbeds) e.dispose()
    this.messages = []
    this.expandedTurns.clear()
    this.expandedForks.clear()
    this.expandedEmbeds.clear()
    this.#superseded = new Set()
    this.copyButtons = []
    this.bulbEmbeds = []
  }

  // A copy button registered in copyButtons so domeleon discovers/manages it.
  #makeCopy(text: string): CopyButton {
    const copy = new CopyButton(text)
    this.copyButtons.push(copy)
    return copy
  }

  // Build a Msg with its own copy button (when there's text to copy).
  #addMessage(m: Omit<Msg, 'copy'>): Msg {
    const msg: Msg = { ...m, copy: m.text ? this.#makeCopy(m.text) : undefined }
    this.messages.push(msg)
    return msg
  }

  // The current turn's assistant prose, joined: walk back from the newest message to the last user
  // message, collecting assistant text. Feeds the shared turn-level copy in prose mode.
  #turnProseText(): string {
    const out: string[] = []
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i]!
      if (m.role === 'user') break
      if (m.text) out.unshift(m.text)
    }
    return out.join('\n\n')
  }

  // Set right before navigating to a new chat (session-switch) so the
  // next render lands at the bottom of the new transcript rather than carrying
  // over the previous scroll position.
  stickToBottomNextRender() {
    this.#stuckToBottom = true
  }

  // ===== apply() dispatch =====

  // Consecutive user sends (no assistant turn between) are one intent split across messages — fold into a
  // single bubble (segments, divided by a rule in userMarkdown), not a stack of turns. Shared by applyUser
  // and the orphan-branch builder so both fold the same way.
  #mergeUserText(prev: Msg, text: string) {
    prev.segments = [...(prev.segments ?? [prev.text]), text]
    prev.text = prev.segments.join('\n\n')
  }

  applyUser(e: Extract<ServerEvent, { type: 'user' }>) {
    const prev = this.messages[this.messages.length - 1]
    if (prev && prev.role === 'user') {                       // an assistant message between resets the run
      this.#mergeUserText(prev, e.text)
      if (prev.copy) prev.copy.setText(prev.text)
      else if (prev.text) prev.copy = this.#makeCopy(prev.text)
      return
    }
    this.#addMessage({ id: ++this.#idSeq, role: 'user', text: e.text, thinking: '', tools: [] })
  }

  applyAssistant(e: Extract<ServerEvent, { type: 'assistant' }>) {
    const msg = this.#addMessage({
      id: ++this.#idSeq,
      role: 'assistant',
      text: e.text,
      thinking: e.thinking,
      tools: e.tools.map(t => ({ ...t, isError: false })),
    })
    // Prose mode shows one copy per turn over the joined assistant prose — the per-message split is
    // tool-call timing, not authorship. Share one CopyButton across the turn's consecutive assistant
    // messages (reuse the previous one's when same-turn, else start fresh) and keep its text current
    // as the turn grows; bubble() renders it on the turn's last prose bubble.
    const prev = this.messages[this.messages.length - 2]
    msg.turnCopy = (prev?.role === 'assistant' && prev.turnCopy) || this.#makeCopy('')
    msg.turnCopy.setText(this.#turnProseText())
    this.#attachEmbeds(msg, e.text)
    this.#recomputeChains()
    // Auto-expand live edits; leave historical (replayed) ones collapsed.
    if (e.live) {
      for (const t of e.tools) {
        if (EDIT_TOOLS.has(t.name)) this.openTools.add(t.id)
      }
    }
  }

  // Live ````bulb```` embeds: split the text into markdown chunks + bulb sources, turning each
  // source into a BulbEmbed registered in bulbEmbeds (so domeleon manages it) and stored on
  // msg.body for #renderBody. Only messages with a bulb fence get a body; the rest stay plain.
  #attachEmbeds(msg: Msg, text: string) {
    const segs = splitBulbSegments(text)
    if (!segs.some(s => s.kind === 'bulb')) return
    msg.body = segs.map(s => {
      if (s.kind === 'md') return s.text
      const embed = new BulbEmbed(s.source, `embed-${this.#embedSeq++}`)
      this.bulbEmbeds.push(embed)
      return embed
    })
  }

  // Recompute same-name chain state (TB-Agent-Mirror-Embed.md, Iteration): mark superseded
  // embeds and set each embed's mount state — only a run's live tail (or one the user re-expanded) stays
  // mounted; the rest unmount so they stop taking height and processing. Runs when embeds are added or an
  // expansion toggles, never during render (setMounted has side effects).
  #recomputeChains() {
    const names = this.bulbEmbeds.map(e => e.name)
    const flags = supersededFlags(names)
    const pos = chainPositions(names)
    this.#superseded = new Set(this.bulbEmbeds.filter((_, i) => flags[i]))
    // Position before mount: the status forward tags lines `v<N>`, so an embed must know its position
    // before anything it logs (setMounted can kick off the compile). Mount the live tail, plus any
    // folded version the user has expanded (so its render/error shows).
    this.bulbEmbeds.forEach((e, i) => {
      e.setChainPosition(pos[i]!)
      e.setMounted(!flags[i] || this.expandedEmbeds.has(e.key))
    })
  }

  #toggleEmbed(key: string) {
    toggleInSet(this.expandedEmbeds, key)
    this.#recomputeChains()
    this.update()
  }

  applyToolResult(e: Extract<ServerEvent, { type: 'tool_result' }>) {
    const t = this.#findTool(e.id)
    if (t) { t.result = e.content; t.isError = e.isError; t.digest = e.digest }
  }

  // An abandoned branch the server surfaced at this point in the stream (TB-LostMessage.md). It rides in
  // as a `fork`-role pseudo-message whose position in `messages` IS the fork parent's slot (the event
  // arrives right after the parent's own events). Its orphan content is pre-built into `sub` Msgs now,
  // rendered read-only only when the stub is expanded — no live embeds, no copy pills.
  applyFork(e: Extract<ServerEvent, { type: 'fork' }>) {
    const sub = this.#buildSubMessages(e.events)
    this.#addMessage({ id: ++this.#idSeq, role: 'fork', text: '', thinking: '', tools: [], fork: { count: e.count, sub } })
  }

  // Turn an orphan branch's server events into renderable Msgs — a trimmed twin of applyUser/
  // applyAssistant/applyToolResult (no embeds, no copy buttons, no chain bookkeeping): orphan content
  // is historical and read-only, so it needs only text, thinking, and tool rows.
  #buildSubMessages(events: ServerEvent[]): Msg[] {
    const out: Msg[] = []
    for (const ev of events) {
      if (ev.type === 'user') {
        const prev = out[out.length - 1]
        if (prev && prev.role === 'user') this.#mergeUserText(prev, ev.text)
        else out.push({ id: ++this.#idSeq, role: 'user', text: ev.text, thinking: '', tools: [] })
      } else if (ev.type === 'assistant') {
        out.push({ id: ++this.#idSeq, role: 'assistant', text: ev.text, thinking: ev.thinking, tools: ev.tools.map(t => ({ ...t, isError: false })) })
      } else if (ev.type === 'tool_result') {
        const t = out.flatMap(m => m.tools).find(t => t.id === ev.id)
        if (t) { t.result = ev.content; t.isError = ev.isError; t.digest = ev.digest }
      }
    }
    return out
  }

  #findTool(id: string): Tool | undefined {
    return this.messages.flatMap(m => m.tools).find(t => t.id === id)
  }

  // ===== Scroll behavior =====

  scrollSoon() {
    requestAnimationFrame(() => {
      if (this.scrollEl && this.#stuckToBottom) this.scrollEl.scrollTop = this.scrollEl.scrollHeight
    })
  }

  // Sticky-bottom: a scroll-up past 50px from the bottom disengages autoscroll
  // until the user scrolls back within it. Programmatic scrolls land at
  // scrollHeight, so they keep stuck=true.
  onScroll() {
    const el = this.scrollEl
    if (!el) return
    this.#stuckToBottom = el.scrollHeight - (el.scrollTop + el.clientHeight) < 50
  }

  // ===== Views =====

  view() {
    return div({
      class: 'messages',
      onScroll: () => this.onScroll(),
      // onMounted only to capture the element — scrollSoon() needs the real node to drive scrollTop.
      onMounted: (el: Element) => { this.scrollEl = el as HTMLElement },
    },
      this.parent.ready ? this.renderMessages() : div({ class: 'note' }, 'Connecting…'),
    )
  }

  // Group the flat list into turns (a user message + the assistant bubbles that
  // follow it), then render each. The turn index cycles a palette CSS class for
  // the left-edge stripe.
  renderMessages() {
    const groups: { idx: number; msgs: Msg[] }[] = []
    let turn = -1
    for (const msg of this.messages) {
      if (msg.role === 'user' || groups.length === 0) {
        if (msg.role === 'user') turn++
        groups.push({ idx: Math.max(0, turn), msgs: [msg] })   // clamp orphan-assistant to slot 0
      } else {
        groups[groups.length - 1]!.msgs.push(msg)
      }
    }
    return groups.flatMap((g, gi) => this.renderTurn(g.msgs, g.idx, gi === groups.length - 1))
  }

  // A completed turn collapses its intermediate assistant bubbles (everything
  // but the final answer) under a one-line summary; the user prompt and the last
  // assistant message stay expanded. The in-flight (last) turn never collapses —
  // you're watching it stream — and a turn the user clicked open expands fully.
  // Rationale: the agent's final message already IS its own summary of the turn,
  // so surfacing it (free, exact) beats any generated paraphrase. See the spec.
  renderTurn(msgs: Msg[], turnIdx: number, isLast: boolean) {
    // Prose mode: only what the agent said. Tool-only bubbles drop with no summary stub,
    // and turn-collapse is moot — its tally counts exactly the steps the mode hides. One copy per
    // turn (the per-message split is tool timing, not authorship): the shared turnCopy renders on the
    // last assistant prose bubble; user bubbles keep their own (a deliberate merged-send is one copy too).
    if (this.parent.prose) {
      // Fork stubs are said content too — keep them visible in prose mode.
      const visible = msgs.filter(m => m.role === 'user' || m.role === 'fork' || m.text || m.body)
      const lastProse = [...visible].reverse().find(m => m.role === 'assistant' && !!m.text)
      return visible.map(m => {
        if (m.role === 'fork') return this.forkStub(m, turnIdx)
        // User bubbles keep their own pill; the turn's assistant prose gets one, on its last prose bubble.
        const copy = m.role === 'user' ? m.copy : m === lastProse ? m.turnCopy : undefined
        return this.bubble(m, turnIdx, copy ?? null)
      })
    }
    const assistants = msgs.filter(m => m.role === 'assistant')
    if (isLast || assistants.length < 2) return msgs.map(m => m.role === 'fork' ? this.forkStub(m, turnIdx) : this.bubble(m, turnIdx))

    // Collapsed turn: user prompt(s) and any fork stub(s) stay shown (a fork is its own collapsed
    // marker); only the intermediate assistant bubbles fold under the summary.
    const expanded = this.expandedTurns.has(turnIdx)
    const hidden = assistants.slice(0, -1)
    const last = assistants[assistants.length - 1]!
    const out = msgs.filter(m => m.role === 'user').map(m => this.bubble(m, turnIdx))
    for (const m of msgs) if (m.role === 'fork') out.push(this.forkStub(m, turnIdx))
    out.push(this.turnSummary(hidden, turnIdx))
    if (expanded) for (const m of hidden) out.push(this.bubble(m, turnIdx))
    out.push(this.bubble(last, turnIdx))
    return out
  }

  // Shared shell for the mirror's two collapsed-row stubs — the turn-collapse summary and the
  // abandoned-branch fork. Both are a .bubble carrying the turn stripe (color continuous with the turn)
  // and a clickable .turn-summary header (caret + label) that toggles `set`/`key`; the fork additionally
  // shows `body` beneath when open. They differ only in those four inputs.
  #collapsibleRow(key: string, turnIdx: number, set: Set<number>, id: number, label: HValues, body?: ReturnType<typeof div>) {
    const expanded = set.has(id)
    return div({ class: ['bubble', 'assistant', turnClassFor(turnIdx)], key },
      div({ class: 'turn-summary', onClick: () => { toggleInSet(set, id); this.update() } },
        caret(expanded),
        span({ class: 'turn-summary-text' }, label),
      ),
      body ?? null,
    )
  }

  // Collapsed stub for an abandoned branch (TB-LostMessage.md): a count label, expanding to the orphan's
  // read-only messages beneath. Additive, never replacing the live transcript.
  forkStub(msg: Msg, turnIdx: number) {
    const f = msg.fork!
    const body = this.expandedForks.has(msg.id)
      ? div({ class: 'fork-body' }, f.sub.map(sub => this.bubble(sub, turnIdx, undefined, false)))
      : undefined
    const label = [forkIcon(), ` ${f.count} message${f.count === 1 ? '' : 's'} on an abandoned branch`]
    return this.#collapsibleRow(`fork-${msg.id}`, turnIdx, this.expandedForks, msg.id, label, body)
  }

  // Collapsed-turn header: caret + data-derived step tally, click to toggle.
  turnSummary(hidden: Msg[], turnIdx: number) {
    return this.#collapsibleRow(`summary-${turnIdx}`, turnIdx, this.expandedTurns, turnIdx, summarizeSteps(hidden))
  }

  // `copy` is the pill to render (defaults to the message's own). Prose mode passes the shared
  // turn-level copy on the last prose bubble and `null` on the rest, so a turn shows a single pill.
  // `stripe` is the left turn-color bar; orphan-branch sub-bubbles pass false — they're already grouped
  // by .fork-body's own rule, so repeating the parent turn's stripe inside it reads as recursive nesting.
  bubble(msg: Msg, turnIdx: number, copy: CopyButton | null | undefined = msg.copy, stripe = true) {
    const prose = this.parent.prose
    // Tools-only bubbles sit tighter (CSS adjacent-sibling rule) so a chain of
    // tool steps doesn't waste vertical space.
    const toolsOnly = msg.role === 'assistant' && !msg.text && !msg.thinking && msg.tools.length > 0
    return div({ class: ['bubble', msg.role, toolsOnly ? 'tools-only' : '', stripe ? turnClassFor(turnIdx) : ''], key: msg.id },
      !prose && msg.thinking ? details({ class: 'thinking' }, summary('thinking'), pre(msg.thinking)) : null,
      this.#renderBody(msg),
      prose ? null : msg.tools.map(t => this.tool(t)),
      copy ? copy.view() : null,
    )
  }

  // The message body. With live ````bulb```` embeds it's an ordered run of markdown chunks and
  // BulbEmbed components (msg.body); otherwise the single markdown div — user prompts through
  // userMarkdown (clickable @mentions, merged sends), assistant text through renderMarkdown.
  #renderBody(msg: Msg) {
    if (msg.body) {
      return msg.body.flatMap((seg, i) =>
        typeof seg === 'string'
          ? (seg.trim() ? [this.#mdDiv(`md-${msg.id}-${i}`, renderMarkdown(seg))] : [])
          : this.#renderEmbed(seg))
    }
    if (!msg.text) return null
    return this.#mdDiv(`md-${msg.id}`, msg.role === 'user' ? userMarkdown(msg) : renderMarkdown(msg.text))
  }

  // A live or lone embed renders its app. A superseded one folds to a "<Name> — Version N" stub whose
  // look never depends on outcome (TB-Agent-Mirror-Embed.md, Iteration): it's always the accent marker, so the title
  // never flips color on expand/collapse. Expanding mounts the old bulb and shows it beneath — its render,
  // or a "could not render" message, with any error in the embed's own red strip; collapsing unmounts it,
  // so re-expanding runs it fresh. Whether that version errored shows only while it's open.
  #renderEmbed(embed: BulbEmbed) {
    if (!this.#superseded.has(embed)) return [embed.view()]
    const expanded = this.expandedEmbeds.has(embed.key)
    const stub = div({ class: 'md', key: `fold-${embed.key}` },
      div({ class: 'bulb-fold', onClick: () => this.#toggleEmbed(embed.key) },
        caret(expanded),
        span({ class: 'bulb-fold-text' }, `${embed.name ?? 'bulb'} — Version ${embed.chainPosition}`),
        span({ class: 'bulb-fold-app' }, '💡')))
    return expanded ? [stub, embed.view()] : [stub]
  }

  #mdDiv(key: string, mount: (el: Element) => void) {
    return div({ class: 'md', key, onMounted: mount })
  }

  tool(t: Tool) {
    const open = this.openTools.has(t.id)
    const filePath = filePathOf(t.name, t.input)
    const todos = todosOf(t)
    // File paths display project-relative (full path in the title + the click); the rest one-lined.
    const sum = filePath ? displayPath(filePath, this.parent.cwd) : oneLine(toolSummary(t.input))
    // The head is inert prose (only the file-path link reacts); the digest row below is the toggle.
    return div({ class: ['tool', t.isError ? 'err' : ''] },
      div({ class: 'tool-head' },
        // Verb + summary wrap together so inline flow baseline-aligns them across
        // their two fonts (see .tool-label).
        div({ class: 'tool-label' },
          span({ class: 'tool-name', ...(t.name.startsWith('mcp__') ? { title: t.name } : {}) }, toolDisplayName(t.name)),
          sum
            ? (filePath
                ? a({
                    class: 'tool-sum link',
                    title: filePath,
                    onClick: (e: MouseEvent) => {
                      e.preventDefault()
                      tb.server.openFile(filePath)
                    },
                  }, sum)
                : span({ class: 'tool-sum' }, sum))
            : null,
        ),
        t.result === undefined ? span({ class: 'tool-run' }, '…') : null,
      ),
      // The OUT digest row, doubling as the toggle; '(no output)' keeps an empty result expandable.
      t.result !== undefined
        ? div({ class: 'tool-digest', onClick: () => { toggleInSet(this.openTools, t.id); this.update() } },
            caret(open),
            (todos ? todoDigest(todos) : t.digest) || '(no output)')
        : null,
      // open with no result = a live auto-expanded edit; its diff shows while the tool runs.
      // Checklist/patch results are protocol boilerplate the digest already restates — show them
      // only on error, where the result is the diagnostic.
      open ? div({ class: 'tool-card' },
          this.toolBody(t),
          t.result !== undefined && (!(todos || patchesOf(t).length) || t.isError)
            ? pre({ class: 'tool-out' }, t.result.slice(0, 4000)) : null,
        ) : null,
    )
  }

  // Diff view for editing tools; labelled key/value fields for everything else (a raw JSON dump
  // reads badly — quoted, escaped, brace-wrapped).
  toolBody(t: Tool) {
    // CC's checklist treatment: tick / filled square / hollow square, per status.
    const todos = todosOf(t)
    if (todos) return div({ class: 'todo-list' },
      todos.map(td => div({ class: ['todo', td.status ?? ''] },
        span({ class: 'todo-icon' }, td.status === 'completed' ? '✔' : td.status === 'in_progress' ? '◼' : '◻'),
        span({ class: 'todo-text' }, td.content ?? ''),
      )))
    // A diff-carrying input (patcher tools) owns the card: its sibling fields (filePath, options)
    // are addressing the digest row already shows.
    const patches = patchesOf(t)
    if (patches.length) return div({ class: 'tool-in' }, patches.map(udiffView))
    const hunks = diffHunks(t)
    if (!hunks) {
      const fields = Object.entries(t.input ?? {})
      if (!fields.length) return null
      return div({ class: 'tool-in' },
        // The ':' is a real text node (not CSS ::after) so a copy drag yields "key: value".
        fields.map(([k, v]) => div({ class: 'tool-field' },
          span({ class: 'tool-key' }, `${k}:`),
          typeof v === 'string' && looksLikeUnifiedDiff(v)
            ? udiffView(v)
            : pre({ class: 'tool-val' }, typeof v === 'string' ? v : JSON.stringify(v, null, 2)),
        )))
    }
    return div({ class: 'diff' },
      ...hunks.flatMap((h, i) => [
        hunks.length > 1 ? div({ class: 'diff-step' }, `edit ${i + 1}/${hunks.length}`) : null,
        h.old ? pre({ class: 'diff-old' }, String(h.old)) : null,
        h.new ? pre({ class: 'diff-new' }, String(h.new)) : null,
      ]),
    )
  }
}
