import { Component, div, span, a, pre, details, summary } from 'domeleon'
import type { ServerEvent, Tool, Msg, IRoot } from './types.js'
import { renderMarkdown, userMarkdown, splitBulbSegments } from './markdown.js'
import { CopyButton } from './copyButton.js'
import { BulbEmbed } from './bulbEmbed.js'
import { supersededFlags, chainPositions } from './chains.js'
import { asStr, turnClassFor } from './util.js'

function toolSummary(input: Record<string, unknown>): string {
  if (!input || typeof input !== 'object') return ''
  return asStr(input.command) ?? asStr(input.file_path) ?? asStr(input.path) ?? asStr(input.pattern) ?? asStr(input.query) ?? asStr(input.url) ?? asStr(input.skill) ?? asStr(input.description) ?? ''
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

// One-line summary of a turn's collapsed (intermediate) bubbles: step count +
// tool tally, e.g. "5 steps · Read, Edit ×2, Bash". Pure data, no inference.
function summarizeSteps(msgs: Msg[]): string {
  const counts = new Map<string, number>()
  for (const m of msgs) for (const t of m.tools) counts.set(t.name, (counts.get(t.name) ?? 0) + 1)
  const tally = [...counts].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join(', ')
  const n = msgs.length
  return `${n} step${n === 1 ? '' : 's'}${tally ? ` · ${tally}` : ''}`
}

// Messages panel: scrolling area, bubbles, expanded-tool set, sticky-bottom.
// No optimistic render — the bulb drives nothing; turns appear only once CC
// writes them to the JSONL.
export class MessageList extends Component {
  messages: Msg[] = []
  openTools = new Set<string>()                    // tool ids whose body is expanded
  expandedTurns = new Set<number>()                // turn indices the user expanded past the collapsed summary
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

  applyUser(e: Extract<ServerEvent, { type: 'user' }>) {
    // Consecutive user sends (no assistant turn between) are one intent split
    // across messages — fold into a single bubble (segments, divided by a rule in
    // userMarkdown), not a stack of turns. An assistant message between resets it.
    const prev = this.messages[this.messages.length - 1]
    if (prev && prev.role === 'user') {
      prev.segments = [...(prev.segments ?? [prev.text]), e.text]
      prev.text = prev.segments.join('\n\n')
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

  // Recompute same-name chain state (TB-Agent-Mirror-Embed-Iterate.md): mark superseded
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
    if (this.expandedEmbeds.has(key)) this.expandedEmbeds.delete(key)
    else this.expandedEmbeds.add(key)
    this.#recomputeChains()
    this.update()
  }

  applyToolResult(e: Extract<ServerEvent, { type: 'tool_result' }>) {
    const t = this.#findTool(e.id)
    if (t) { t.result = e.content; t.isError = e.isError }
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
      const visible = msgs.filter(m => m.role === 'user' || m.text || m.body)
      const lastProse = [...visible].reverse().find(m => m.role === 'assistant' && !!m.text)
      return visible.map(m => {
        // User bubbles keep their own pill; the turn's assistant prose gets one, on its last prose bubble.
        const copy = m.role === 'user' ? m.copy : m === lastProse ? m.turnCopy : undefined
        return this.bubble(m, turnIdx, copy ?? null)
      })
    }
    const assistants = msgs.filter(m => m.role === 'assistant')
    if (isLast || assistants.length < 2) return msgs.map(m => this.bubble(m, turnIdx))

    const expanded = this.expandedTurns.has(turnIdx)
    const hidden = assistants.slice(0, -1)
    const last = assistants[assistants.length - 1]!
    const out = msgs.filter(m => m.role === 'user').map(m => this.bubble(m, turnIdx))
    out.push(this.turnSummary(hidden, turnIdx, expanded))
    if (expanded) for (const m of hidden) out.push(this.bubble(m, turnIdx))
    out.push(this.bubble(last, turnIdx))
    return out
  }

  // Collapsed-turn header: caret + data-derived step tally, click to toggle.
  // It's a .bubble so it inherits the turn stripe and keeps the color continuous.
  turnSummary(hidden: Msg[], turnIdx: number, expanded: boolean) {
    return div({ class: ['bubble', 'assistant', turnClassFor(turnIdx)], key: `summary-${turnIdx}` },
      div({
        class: 'turn-summary',
        onClick: () => {
          if (expanded) this.expandedTurns.delete(turnIdx); else this.expandedTurns.add(turnIdx)
          this.update()
        },
      },
        span({ class: 'tool-caret' }, expanded ? '▾' : '▸'),
        span({ class: 'turn-summary-text' }, summarizeSteps(hidden)),
      ),
    )
  }

  // `copy` is the pill to render (defaults to the message's own). Prose mode passes the shared
  // turn-level copy on the last prose bubble and `null` on the rest, so a turn shows a single pill.
  bubble(msg: Msg, turnIdx: number, copy: CopyButton | null | undefined = msg.copy) {
    const prose = this.parent.prose
    // Tools-only bubbles sit tighter (CSS adjacent-sibling rule) so a chain of
    // tool steps doesn't waste vertical space.
    const toolsOnly = msg.role === 'assistant' && !msg.text && !msg.thinking && msg.tools.length > 0
    return div({ class: ['bubble', msg.role, toolsOnly ? 'tools-only' : '', turnClassFor(turnIdx)], key: msg.id },
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
  // look never depends on outcome (Specs/…-Embed-Iterate.md): it's always the accent marker, so the title
  // never flips color on expand/collapse. Expanding mounts the old bulb and shows it beneath — its render,
  // or a "could not render" message, with any error in the embed's own red strip; collapsing unmounts it,
  // so re-expanding runs it fresh. Whether that version errored shows only while it's open.
  #renderEmbed(embed: BulbEmbed) {
    if (!this.#superseded.has(embed)) return [embed.view()]
    const expanded = this.expandedEmbeds.has(embed.key)
    const stub = div({ class: 'md', key: `fold-${embed.key}` },
      div({ class: 'bulb-fold', onClick: () => this.#toggleEmbed(embed.key) },
        span({ class: 'tool-caret' }, expanded ? '▾' : '▸'),
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
    const sum = filePath ?? toolSummary(t.input)
    // Hand-rolled toggle, not <details>/<summary>: Chrome swallows custom-scheme
    // (vscode://) anchor clicks inside <summary>.
    return div({ class: ['tool', t.isError ? 'err' : '', open ? 'open' : ''] },
      div({
        class: 'tool-head',
        onClick: () => {
          if (open) this.openTools.delete(t.id); else this.openTools.add(t.id)
          this.update()
        },
      },
        span({ class: 'tool-caret' }, open ? '▾' : '▸'),
        // Verb + summary wrap together so inline flow baseline-aligns them across
        // their two fonts (see .tool-label).
        div({ class: 'tool-label' },
          span({ class: 'tool-name' }, t.name),
          sum
            ? (filePath
                ? a({
                    class: 'tool-sum link',
                    title: filePath,
                    onClick: (e: MouseEvent) => {
                      e.preventDefault()
                      e.stopPropagation()                            // don't toggle row
                      tb.server.openFile(filePath)
                    },
                  }, filePath)
                : span({ class: 'tool-sum' }, sum))
            : null,
        ),
        t.result === undefined ? span({ class: 'tool-run' }, '…') : null,
      ),
      open ? this.toolBody(t) : null,
      open && t.result !== undefined ? pre({ class: 'tool-out' }, t.result.slice(0, 4000)) : null,
    )
  }

  // Diff view for editing tools; JSON for everything else.
  toolBody(t: Tool) {
    const hunks = diffHunks(t)
    if (!hunks) return pre({ class: 'tool-in' }, JSON.stringify(t.input, null, 2))
    return div({ class: 'diff' },
      ...hunks.flatMap((h, i) => [
        hunks.length > 1 ? div({ class: 'diff-step' }, `edit ${i + 1}/${hunks.length}`) : null,
        h.old ? pre({ class: 'diff-old' }, String(h.old)) : null,
        h.new ? pre({ class: 'diff-new' }, String(h.new)) : null,
      ]),
    )
  }
}
