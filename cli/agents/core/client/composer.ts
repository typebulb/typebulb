import { Component, div, span, button, inputText, inputTextArea, type HValues } from 'domeleon'
import { icon } from './icons.js'
import type { ComposerDialogRequest, ComposerPoll, ComposerQueue, ComposerRecipe, ComposerStatus, DialogResponse, IRoot, RecipeCtx } from './types.js'

// Ranked substring filter shared by the '/' palette, @-picker, and select dialog: keep items whose
// rank ≥ 0, ascending; lower rank sorts first, -1 = no match.
function rankFilter<T>(items: T[], rank: (item: T) => number, limit?: number): T[] {
  const ranked = items.map(item => ({ item, rank: rank(item) })).filter(x => x.rank >= 0)
  ranked.sort((a, b) => a.rank - b.rank)
  return (limit ? ranked.slice(0, limit) : ranked).map(x => x.item)
}

// The mirror's prompt panel (TB-Agent-Composer.md + -Toolkit.md). Neutral chrome, rendered only when
// the harness's adapter implements createDriver (pi's client passes one, Claude's passes none).
// Enter sends — a fresh prompt when idle, a steer mid-turn (the server routes) — Shift+Enter
// newlines; with a popup open, Enter/Tab pick instead. `@` opens the file picker, `/` the palette
// (recipe table + get_commands rows), `!` routes to the bash RPC. The panel only ever *causes* turns
// (Invariant C1): the transcript renders via the tail; its own state is the poll's composer slice
// plus local input/picker state.
export class Composer extends Component {
  enabled = false                 // info().composer — the adapter implements createDriver
  streaming = false               // the driver is mid-turn (from poll; set optimistically on send)
  driverError?: string            // fatal driver error off the poll (pi died / not found)
  sendError?: string              // last send rejection (foreign turn, pi refused) — cleared on typing
  input = ''
  status: ComposerStatus | null = null            // ambient line off the poll (Toolkit Piece 2)
  localNotice: { text: string; until: number } | null = null   // a recipe's transient result
  // The open modal: a server (extension) dialog or a local (recipe) one — same component, two
  // sources (Toolkit Piece 3). `resolve` answers it: composerUiRespond for server, the recipe's
  // awaited promise for local.
  dlg: { req: ComposerDialogRequest; local: boolean; resolve: (r: DialogResponse) => void } | null = null
  dlgInput = ''                   // the input/editor dialog's bound text
  dlgFilter = ''                  // the select dialog's type-to-filter query
  dlgIndex = 0                    // the select dialog's active row (arrows / Enter)
  queue: ComposerQueue | null = null   // pending steer/follow-up texts off the poll (parity #2)
  recipes: ComposerRecipe[]       // the harness's built-in command table (Toolkit Piece 5)
  harnessCommands: { name: string; description: string }[] = []  // get_commands pass-through rows
  slashQuery: string | null = null   // text after a leading '/' up to the caret; null = palette closed
  slashIndex = 0                  // selected palette row
  // Explicit textarea height in px, driven by the top-edge splitter (grows upward, so the resize
  // direction matches the visual change; replaces the native handle). Default ≈ rows="3".
  composerHeight = 90
  files: string[] = []            // project files for the @-picker (mtime-sorted, from git ls-files)
  atQuery: string | null = null   // text after '@' in the input; null = popup closed
  atIndex = 0                     // selected popup row
  atStart = 0                     // input offset where the '@' lives
  #sending = false                // one send in flight; Enter is idempotent meanwhile
  #localDialogSeq = 0
  #dlgFilterSeen = ''             // last committed filter — resets the active row on query change
  #answeredServerId: string | null = null   // guards re-showing a just-answered server dialog before the next poll

  constructor(recipes: ComposerRecipe[] = []) {
    super()
    this.recipes = recipes
  }

  get parent() { return this.ctx.parent as unknown as IRoot }

  override onAttached() {
    // A composer instance exists only on a drivable harness, so the fetch never fires for Claude.
    void this.#loadFiles()
  }

  async #loadFiles() {
    try {
      const fs = await tb.server.composerFiles()
      if (Array.isArray(fs)) { this.files = fs; this.update() }
    } catch { /* non-git project / no mirror — the popup shows "No matches" */ }
  }

  /** Root feeds each poll's composer slice; returns whether anything visible changed. */
  syncFromPoll(c: ComposerPoll): boolean {
    let changed = c.streaming !== this.streaming || c.error !== this.driverError
    this.streaming = c.streaming
    this.driverError = c.error
    // draft/stats live on IRoot (MessageList and the token pill read them there), but their
    // field-wise change detection belongs here with the rest of the slice.
    const p = this.parent
    const draft = c.draft ?? null
    if (draft?.text !== p.draft?.text || draft?.thinking !== p.draft?.thinking) { p.draft = draft; changed = true }
    const stats = c.stats ?? null
    if (stats?.cost !== p.stats?.cost || stats?.contextTokens !== p.stats?.contextTokens
      || stats?.contextPercent !== p.stats?.contextPercent) { p.stats = stats; changed = true }
    const model = c.model ?? null
    if (model !== p.driverModel) { p.driverModel = model; changed = true }
    // The status line — the poll doubles as the local notice's expiry clock.
    if (this.localNotice && Date.now() >= this.localNotice.until) { this.localNotice = null; changed = true }
    if ((c.status?.text ?? null) !== (this.status?.text ?? null) || c.status?.kind !== this.status?.kind) {
      this.status = c.status ?? null
      changed = true
    }
    // The pending-queue strip (parity #2): queued steer/follow-up texts off queue_update.
    const q = c.queue ?? null
    if (this.#queueKey(q) !== this.#queueKey(this.queue)) { this.queue = q; changed = true }
    // Server-originated dialogs: show the driver's queue head unless a local (recipe) dialog is up.
    const d = c.dialog ?? null
    if (this.dlg && !this.dlg.local && (!d || d.id !== this.dlg.req.id)) { this.dlg = null; changed = true }   // expired / resolved elsewhere
    if (d && !this.dlg && d.id !== this.#answeredServerId) { this.#openServerDialog(d); changed = true }
    return changed
  }

  #queueKey(q: ComposerQueue | null) { return q ? JSON.stringify(q) : '' }

  // A foreign process (a terminal pi) owns the in-flight turn: `working` covers both, so it's
  // foreign exactly when it isn't ours. Watch only — driving now would fork its turn.
  #foreignTurn(): boolean { return this.parent.working && !this.streaming }

  async send(followUp = false) {
    const text = this.input.trim()
    if (!text || this.#sending || this.#foreignTurn()) return
    if (text.startsWith('!')) return this.runBash(text.slice(1).trim())
    this.atQuery = null
    await this.#withSending('send failed — mirror unreachable', async () => {
      const r = await tb.server.composerSend(text, { followUp })
      if (r?.ok) {
        this.input = ''
        this.streaming = true          // optimistic — the next poll confirms; keeps Stop from lagging 600ms
      } else {
        this.sendError = r?.error ?? 'send failed'
      }
    })
  }

  // The shared send scaffold: busy flag, error surface, refocus. `fn` sets sendError itself for a
  // server-side rejection; a thrown error (mirror unreachable) becomes `failMsg`.
  async #withSending(failMsg: string, fn: () => Promise<void>) {
    this.#sending = true
    this.sendError = undefined
    this.update()
    try { await fn() }
    catch { this.sendError = failMsg }
    finally {
      this.#sending = false
      this.update()
      this.#placeCaret()
    }
  }

  // Stop also restores any queued steer/follow-up text to the editor (the TUI's Escape-restore:
  // the abort discards pi's queue, so the text would otherwise be silently lost).
  async stopTurn() {
    const q = this.queue
    const queued = q ? [...q.steering, ...q.followUp] : []
    try { await tb.server.composerStop() } catch { /* poll surfaces the state either way */ }
    if (queued.length) {
      this.input = queued.join('\n') + (this.input ? '\n' + this.input : '')
      this.queue = null
      this.update()
      this.#placeCaret()
    }
  }

  // `!cmd` — pi's bash injection (Toolkit Piece 5): runs now, output joins context on the next
  // prompt (pi's own semantics); the transcript row (a bashExecution entry) arrives via the tail.
  async runBash(cmd: string) {
    if (!cmd) return
    await this.#withSending('bash failed — mirror unreachable', async () => {
      const r = await tb.server.composerRpc({ type: 'bash', command: cmd }, { spawn: true })
      if (r?.ok) { this.input = ''; this.#notice('ran — output joins context on the next message') }
      else this.sendError = r?.error ?? 'bash failed'
    })
  }

  // ── clipboard capture (Toolkit Piece 6): clipboard → .typebulb/paste/<file> → @-mention ──

  // Ctrl+V with an image on the clipboard captures it; text pastes pass through untouched (an
  // ordinary paste must stay ordinary — explicit text capture is the clip button / Ctrl+;).
  onPaste(e: ClipboardEvent) {
    const item = [...(e.clipboardData?.items ?? [])].find(i => i.type.startsWith('image/'))
    if (!item) return
    e.preventDefault()
    const file = item.getAsFile()
    if (!file) return
    this.#captureBlob(file, file.type, (e.target as HTMLTextAreaElement).selectionStart)
  }

  // The clip button / Ctrl+;: deliberate clipboard capture — an image if one is there, else the
  // text (a long log becomes a named file the agent greps, not 500 lines burned into context).
  async captureClipboard() {
    const el = this.#editor()
    const at = el ? el.selectionStart : this.input.length
    try {
      for (const item of await navigator.clipboard.read()) {
        const imgType = item.types.find(t => t.startsWith('image/'))
        if (imgType) { this.#captureBlob(await item.getType(imgType), imgType, at); return }
      }
    } catch { /* read() denied or unsupported — the text path below still works */ }
    try {
      const text = (await navigator.clipboard.readText()).trim()
      if (!text) { this.#notice('clipboard is empty'); this.update(); return }
      void this.#capture({ kind: 'text', data: text }, at)
    } catch { this.sendError = 'clipboard unavailable'; this.update() }
  }

  #captureBlob(blob: Blob, mime: string, at: number) {
    const reader = new FileReader()
    reader.onload = () => {
      const url = String(reader.result ?? '')
      void this.#capture({ kind: 'image', data: url.slice(url.indexOf(',') + 1), mime }, at)
    }
    reader.readAsDataURL(blob)
  }

  // Ship the payload to the server, then insert the file's @-mention at `at` (the caret offset at
  // gesture time — the naming call can take a few seconds, so clamp against edits since).
  async #capture(req: { kind: 'image' | 'text'; data: string; mime?: string }, at: number) {
    const fail = (msg: string) => { this.sendError = msg; this.localNotice = null; this.update() }
    this.#notice(req.kind === 'image' ? 'saving image…' : 'saving text…')
    this.update()
    try {
      const r = await tb.server.composerPaste(req)
      if (!r?.ok) return fail(r?.error ?? 'paste failed')
      const insert = `@${r.path} `
      const pos = Math.min(at, this.input.length)
      this.input = this.input.slice(0, pos) + insert + this.input.slice(pos)
      this.localNotice = null
      this.update()
      this.#placeCaret(pos + insert.length)
    } catch {
      fail('paste failed — mirror unreachable')
    }
  }

  // ── the dialog modal (Toolkit Piece 3): one component, two sources ──

  #openServerDialog(d: ComposerDialogRequest) {
    this.dlgInput = d.prefill ?? ''
    this.#resetDlgList(d)
    this.dlg = {
      req: d, local: false,
      resolve: resp => { this.#answeredServerId = d.id; void tb.server.composerUiRespond(d.id, resp) },
    }
  }

  /** The recipe primitives' modal: resolves with the user's answer. */
  #ask(req: Omit<ComposerDialogRequest, 'id'>): Promise<DialogResponse> {
    return new Promise(res => {
      this.dlgInput = req.prefill ?? ''
      this.#resetDlgList(req)
      this.dlg = { req: { id: `local-${++this.#localDialogSeq}`, ...req }, local: true, resolve: res }
      this.update()
    })
  }

  // A select opens on its `selected` row (the current value), not row 0; a typed filter still
  // re-ranks and resets the active row to the top match.
  #resetDlgList(req: Pick<ComposerDialogRequest, 'options' | 'selected'>) {
    this.dlgFilter = ''
    this.#dlgFilterSeen = ''
    this.dlgIndex = req.selected ? Math.max(0, (req.options ?? []).indexOf(req.selected)) : 0
  }

  // Focus a dialog field when it enters the DOM. onMounted (the trustModal pattern) — a bare
  // setTimeout races domeleon's rAF patch and loses, leaving focus in the composer textarea.
  #focusOnMount = (el: Element) => (el as HTMLElement).focus()

  answerDialog(resp: DialogResponse) {
    const dlg = this.dlg
    if (!dlg) return
    this.dlg = null
    dlg.resolve(resp)
    this.update()
    this.#placeCaret()
  }

  // ── the recipe interpreter (Toolkit Piece 5) ──

  #notice(text: string) { this.localNotice = { text, until: Date.now() + 6000 } }

  #recipeCtx(): RecipeCtx {
    return {
      rpc: cmd => tb.server.composerRpc(cmd, { spawn: true }),
      select: async (title, options, selected) => {
        const r = await this.#ask({ method: 'select', title, options, selected })
        return r.cancelled ? null : (r.value ?? null)
      },
      input: async (title, placeholder, prefill) => {
        const r = await this.#ask({ method: 'input', title, placeholder, prefill })
        return r.cancelled ? null : (r.value ?? '')
      },
      confirm: async (title, message) => {
        const r = await this.#ask({ method: 'confirm', title, message })
        return !!r.confirmed
      },
      setInput: text => { this.input = text; this.update(); this.#placeCaret() },
    }
  }

  async runRecipe(rec: ComposerRecipe) {
    this.slashQuery = null
    this.sendError = undefined
    this.update()
    try {
      const out = await rec.run(this.#recipeCtx())
      if (typeof out === 'string' && out) this.#notice(out)
    } catch (err) {
      this.sendError = err instanceof Error ? err.message : String(err)
    }
    this.dlg = null            // a throw mid-dialog must not strand the modal
    this.update()
  }

  // ── the '/' palette (Toolkit Piece 5): recipe rows + get_commands pass-through rows ──

  // Listing never spawns pi (spawn:false — Toolkit gotcha): before the first turn the palette shows
  // the built-ins only, and grows the pass-through rows once a driver exists.
  async #loadCommands() {
    try {
      const r = await tb.server.composerRpc({ type: 'get_commands' }, { spawn: false })
      const cmds = r?.ok ? (r.data as { commands?: { name: string; description?: string }[] })?.commands : null
      if (Array.isArray(cmds)) {
        this.harnessCommands = cmds.map(c => ({ name: String(c.name), description: c.description ?? '' }))
        this.update()
      }
    } catch { /* no driver yet — built-ins only */ }
  }

  filteredCommands(): { name: string; description: string; recipe?: ComposerRecipe }[] {
    if (this.slashQuery === null) return []
    const q = this.slashQuery.toLowerCase()
    const rows = [
      ...this.recipes.filter(r => !r.hidden).map(r => ({ name: r.name, description: r.description, recipe: r as ComposerRecipe | undefined })),
      ...this.harnessCommands
        // The shadow check runs over ALL recipes, hidden included: a hidden /fork must not resurface
        // as a pass-through row (which would send "/fork" as prompt text — the rpc.md footgun).
        .filter(c => !this.recipes.some(r => r.name === c.name))
        .map(c => ({ name: c.name, description: c.description, recipe: undefined })),
    ]
    if (!q) return rows.slice(0, 12)
    return rankFilter(rows, r => { const i = r.name.toLowerCase().indexOf(q); return i === 0 ? 0 : i > 0 ? 100 + i : -1 }, 12)
  }

  // Pick a palette row: a recipe runs now (the typed /token was only the query); a pass-through
  // command is inserted for the user to add args and Enter — it sends as an ordinary message
  // (extension/skill/template commands execute through `prompt`, rpc.md).
  applySlashSelection(): boolean {
    const rows = this.filteredCommands()
    if (this.slashQuery === null || rows.length === 0) return false
    const row = rows[this.slashIndex]
    if (!row) return false
    this.slashQuery = null
    const rest = this.input.replace(/^\/\S*\s?/, '')
    if (row.recipe) {
      this.input = rest
      void this.runRecipe(row.recipe)
      return true
    }
    const insert = '/' + row.name + ' '
    this.input = insert + rest
    this.update()
    this.#placeCaret(insert.length)
    return true
  }

  // Blank the view and drop the idle driver; the next send starts a fresh pi session
  // (TB-Agent-Composer.md — the one case the mirror "creates" a session). Refused mid-turn.
  async newConversation() {
    if (this.#sending) return
    await this.#withSending('could not start a new conversation — mirror unreachable', async () => {
      const r = await tb.server.composerNew()
      if (!r?.ok) { this.sendError = r?.error ?? 'could not start a new conversation'; return }
      void this.#loadFiles()             // fresh mtime order for the @-picker
    })
  }

  // ── the @-file-mention picker ──

  // Substring match on the path, case-insensitive; rank basename matches first.
  // Empty query (just '@' typed) shows the most recently touched files.
  filteredFiles(): string[] {
    if (this.atQuery === null) return []
    const q = this.atQuery.toLowerCase()
    if (!q) return this.files.slice(0, 10)
    return rankFilter(this.files, f => {
      const pathIdx = f.toLowerCase().indexOf(q)
      if (pathIdx === -1) return -1
      const baseIdx = f.slice(f.lastIndexOf('/') + 1).toLowerCase().indexOf(q)
      return baseIdx === -1 ? 1000 + pathIdx : baseIdx
    }, 10)
  }

  // Called on keyup/click (after the value/caret commit — onInput belongs to domeleon's binding).
  // Detects BOTH popup contexts: the caret inside an @-token (the file picker) and a leading '/'
  // with the caret still inside the first token (the palette) — mutually exclusive by construction.
  // No-op when neither context changed: arrow keys fire keyup too, and unconditionally writing
  // state would reset the active index right after #onKey incremented it (visible bob-and-snap).
  onComposerInput(el: HTMLTextAreaElement) {
    const pos = el.selectionStart
    const val = el.value
    let newQuery: string | null = null
    let newStart = 0
    for (let i = pos - 1; i >= 0; i--) {
      const c = val[i]!
      if (c === '@') {
        const prev = i > 0 ? val[i - 1]! : ''
        if (!prev || /[\s([{]/.test(prev)) {
          newQuery = val.slice(i + 1, pos)
          newStart = i
        }
        break
      }
      if (/\s/.test(c)) break
    }
    let slashQ: string | null = null
    if (val.startsWith('/') && pos >= 1) {
      const head = val.slice(1, pos)
      if (!/\s/.test(head)) slashQ = head
    }
    if (slashQ !== null) newQuery = null            // the palette owns the input head
    const atChanged = !(newQuery === this.atQuery && (newQuery === null || newStart === this.atStart))
    const slashChanged = slashQ !== this.slashQuery
    if (!atChanged && !slashChanged) return
    const openingAt = newQuery !== null && this.atQuery === null
    const openingSlash = slashQ !== null && this.slashQuery === null
    this.atQuery = newQuery
    if (newQuery !== null) {
      this.atStart = newStart
      this.atIndex = 0
    }
    this.slashQuery = slashQ
    if (slashQ !== null && slashChanged) this.slashIndex = 0   // same reset-on-query-change as atIndex
    if (openingAt) void this.#loadFiles()      // refresh the mtime order each time the popup opens
    if (openingSlash) void this.#loadCommands()
    this.update()
  }

  // Replace the @-token with the chosen path; restore caret after it.
  applyAtSelection(): boolean {
    const el = this.#editor()
    const matches = this.filteredFiles()
    if (!el || this.atQuery === null || matches.length === 0) return false
    const file = matches[this.atIndex]
    if (!file) return false
    const before = this.input.slice(0, this.atStart)
    const after = this.input.slice(el.selectionStart)
    const insert = '@' + file + ' '
    this.input = before + insert + after
    this.atQuery = null
    this.update()
    this.#placeCaret(before.length + insert.length)
    return true
  }

  #editor() { return document.querySelector('.composer-input') as HTMLTextAreaElement | null }

  // Focus the editor once the pending render commits; caret at `pos` (default: end of text).
  #placeCaret(pos?: number) {
    setTimeout(() => {
      const el = this.#editor()
      if (!el) return
      el.focus()
      el.selectionStart = el.selectionEnd = pos ?? el.value.length
    }, 0)
  }

  // Pointer-driven height adjustment. Listens on document so the drag survives the cursor leaving
  // the 4px hit zone; body cursor + user-select overrides keep the OS feedback consistent.
  beginSplitterDrag(e: MouseEvent) {
    e.preventDefault()
    const startY = e.clientY
    const startH = this.composerHeight
    const prevCursor = document.body.style.cursor
    const prevSelect = document.body.style.userSelect
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
    const move = (ev: MouseEvent) => {
      // Dragging UP (clientY decreases) grows the composer; the editor edge tracks the cursor.
      // Clamp: 40px floor (a usable single-line target), 60% of viewport ceiling.
      const next = startH - (ev.clientY - startY)
      const max = Math.max(120, window.innerHeight * 0.6)
      this.composerHeight = Math.max(40, Math.min(max, next))
      this.update()
    }
    const up = () => {
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', up)
      document.body.style.cursor = prevCursor
      document.body.style.userSelect = prevSelect
    }
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
  }

  #onKey(e: KeyboardEvent) {
    // Typing away a stale rejection reads better than it lingering under a fixed message. (Done here,
    // not attrs.onInput — inputTextArea's value binding spreads after attrs and owns onInput.)
    if (this.sendError && e.key !== 'Enter') { this.sendError = undefined; this.update() }
    // Ctrl+; — capture the clipboard to a paste file (the clip button's keyboard form).
    if (e.key === ';' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      void this.captureClipboard()
      return
    }
          // Popup keyboard handling takes priority while one is open (they're mutually exclusive).
          if (this.slashQuery !== null && this.#popupNav(e, this.filteredCommands().length, this.slashIndex,
              i => this.slashIndex = i, () => this.slashQuery = null, () => this.applySlashSelection())) return
          if (this.atQuery !== null && this.#popupNav(e, this.filteredFiles().length, this.atIndex,
              i => this.atIndex = i, () => this.atQuery = null, () => this.applyAtSelection())) return
          // Alt+Enter mid-turn queues a follow-up ("after you're done, also…" — parity #2); plain
          // Enter steers. Idle, both send a fresh prompt (the driver routes).
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            void this.send(e.altKey)
          }
  }

  // Arrows move, Escape closes, Enter/Tab picks — the navigation scheme both popups share.
  // False = not consumed (e.g. Enter over an empty popup falls through to send).
  #popupNav(e: KeyboardEvent, count: number, idx: number, setIdx: (i: number) => void, close: () => void, pick: () => void): boolean {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setIdx(Math.max(0, Math.min(idx + (e.key === 'ArrowDown' ? 1 : -1), count - 1)))
      this.update()
      return true
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
      this.update()
      return true
    }
    if ((e.key === 'Enter' || e.key === 'Tab') && count > 0) {
      e.preventDefault()
      pick()
      return true
    }
    return false
  }

  view() {
    const foreign = this.#foreignTurn()
    const disabled = foreign || this.#sending ? { disabled: true } : {}
    const err = this.sendError ?? this.driverError
    const stat = this.localNotice && Date.now() < this.localNotice.until
      ? { text: this.localNotice.text, kind: 'info' as const }
      : this.status
    const placeholder = foreign
      ? 'the agent is working in a terminal — watch only'
      : this.streaming
        ? 'Steer — Enter queues for after this step, Alt+Enter for after the turn'
        : 'Message the agent… (Enter to send, Shift+Enter for newline, @ files, / commands, ! bash)'
    return div({ class: 'composer' },
      this.dlg ? this.dialogView() : null,
      this.atQuery !== null ? this.atPopup() : null,
      this.slashQuery !== null ? this.slashPopup() : null,
      // The resize splitter straddles the composer's top border — the drag zone IS the separator
      // line. Empty-string child + stable key: some renderers skip event binding on childless
      // factories, and the key stops re-renders reattaching the handler.
      div({ class: 'splitter', key: 'splitter', onMouseDown: (e: MouseEvent) => this.beginSplitterDrag(e) }, ''),
      err ? div({ class: 'composer-err' }, err) : null,
      !err && stat ? div({ class: ['composer-status', stat.kind], key: 'composer-status' }, stat.text) : null,
      this.queueStrip(),
      // input-wrap anchors the buttons overlaid at the textarea's bottom-right; a stable key so the
      // conditional popup/error siblings can't make positional diffing remount the textarea.
      div({ class: 'input-wrap', key: 'composer-row' },
        inputTextArea({
          target: this,
          prop: () => this.input,
          attrs: {
            class: 'composer-input',
            placeholder,
            ariaLabel: 'Message the agent',
            // Height is splitter-driven, not native-resize. Style MUST be an object — domeleon's
            // isStyleObject check silently ignores string style values.
            style: { height: `${this.composerHeight}px` },
            onKeyDown: (e: KeyboardEvent) => this.#onKey(e),
            // keyup + click fire after the value/caret are committed — the @-context detector's
            // moment; onInput is consumed by domeleon's two-way binding.
            onKeyUp: (e: KeyboardEvent) => this.onComposerInput(e.target as HTMLTextAreaElement),
            onClick: (e: MouseEvent) => this.onComposerInput(e.target as HTMLTextAreaElement),
            onPaste: (e: ClipboardEvent) => this.onPaste(e),
            ...disabled,
          },
        }),
        // The overlay row at the textarea's bottom-right: clipboard capture, + (new conversation),
        // then send/stop as the primary CTA.
        button({ class: 'composer-clip', type: 'button', title: 'Capture clipboard to a file (Ctrl+;)', ariaLabel: 'Capture clipboard',
          ...disabled,
          onClick: () => void this.captureClipboard() }, icon('attach')),
        button({ class: 'composer-new', type: 'button', title: 'New conversation', ariaLabel: 'New conversation',
          ...(this.streaming || this.#sending ? { disabled: true } : {}),
          onClick: () => void this.newConversation() }, icon('addCircle')),
        this.streaming
          ? button({ class: 'composer-act stop', type: 'button', title: 'Stop the current turn', ariaLabel: 'Stop',
              onClick: () => void this.stopTurn() }, icon('stopCircle'))
          : button({ class: 'composer-act send', type: 'button', title: 'Send (Enter)', ariaLabel: 'Send',
              ...disabled,
              onClick: () => void this.send() }, icon('playCircle')),
      ),
    )
  }

  // Pending queued messages (parity #2): each steer/follow-up awaiting delivery, off queue_update.
  // Visibility is the point — a queued steer was previously a leap of faith.
  queueStrip() {
    const q = this.queue
    const rows = q ? [...q.steering.map(t => ({ tag: 'steer', t })), ...q.followUp.map(t => ({ tag: 'follow-up', t }))] : []
    if (!rows.length) return null
    return div({ class: 'composer-queue', key: 'composer-queue' },
      rows.map(r => div({ class: 'queue-row' }, span({ class: 'queue-tag' }, r.tag), r.t)))
  }

  atPopup() {
    return this.#popup('at-popup', this.filteredFiles(), 'No matches', this.atIndex,
      i => { this.atIndex = i; this.applyAtSelection() },
      f => f)
  }

  slashPopup() {
    return this.#popup('slash-popup', this.filteredCommands(), 'No commands', this.slashIndex,
      i => { this.slashIndex = i; this.applySlashSelection() },
      r => [span({ class: 'slash-name' }, '/' + r.name), r.description ? span({ class: 'slash-desc' }, r.description) : null])
  }

  // The popup shell both share. Stable key so the child diff can't shuffle the textarea when it
  // conditionally appears; mouseDown (not click) so a pick fires before the textarea blurs.
  #popup<T>(key: string, rows: T[], empty: string, activeIdx: number, pick: (i: number) => void, row: (r: T) => HValues) {
    return div({ class: 'at-popup', key }, this.#rowList(rows, empty, activeIdx, pick, row))
  }

  // The rows-or-empty list body the popups and the select dialog share.
  #rowList<T>(rows: T[], empty: string, activeIdx: number, pick: (i: number) => void, row: (r: T) => HValues) {
    return rows.length === 0
      ? div({ class: 'at-empty' }, empty)
      : rows.map((r, i) => div({
          class: ['at-row', i === activeIdx ? 'active' : ''],
          onMouseDown: (e: MouseEvent) => { e.preventDefault(); pick(i) },
        }, row(r)))
  }

  // The modal for a blocking dialog — trust-modal chrome, four methods (Toolkit Piece 3). Buttons
  // answer; the input/editor fields also take Enter (input only) and Escape.
  dialogView() {
    const { req } = this.dlg!
    const fallbackTitle = req.method === 'confirm' ? 'Confirm' : req.method === 'select' ? 'Choose' : 'Input'
    return div({ class: 'trust-back', key: 'composer-dlg' },
      div({ class: 'trust-modal composer-dlg' },
        div({ class: 'trust-modal-h' }, req.title ?? fallbackTitle),
        req.message ? div({ class: 'trust-modal-b' }, req.message) : null,
        req.method === 'select' ? this.selectBody() : null,
        req.method === 'input'
          ? inputText({
              target: this, prop: () => this.dlgInput,
              attrs: { class: 'dlg-input', placeholder: req.placeholder ?? '', onMounted: this.#focusOnMount, onKeyDown: (e: KeyboardEvent) => this.#dlgKey(e) },
            })
          : null,
        req.method === 'editor'
          ? inputTextArea({
              target: this, prop: () => this.dlgInput,
              attrs: { class: 'dlg-editor', onMounted: this.#focusOnMount, onKeyDown: (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); this.answerDialog({ cancelled: true }) } } },
            })
          : null,
        div({ class: 'trust-modal-acts' },
          button({ class: 'trust-no', type: 'button',
            onClick: () => this.answerDialog(req.method === 'confirm' ? { confirmed: false } : { cancelled: true }) },
            req.method === 'confirm' ? 'No' : 'Cancel'),
          req.method === 'confirm'
            ? button({ class: 'trust-yes', type: 'button', onClick: () => this.answerDialog({ confirmed: true }) }, 'Yes')
            : req.method !== 'select'
              ? button({ class: 'trust-yes', type: 'button', onClick: () => this.answerDialog({ value: this.dlgInput }) }, 'OK')
              : null,
        ),
      ))
  }

  #dlgKey(e: KeyboardEvent) {
    if (e.key === 'Enter') { e.preventDefault(); this.answerDialog({ value: this.dlgInput }) }
    if (e.key === 'Escape') { e.preventDefault(); this.answerDialog({ cancelled: true }) }
  }

  // ── the select dialog's filter (a 400-row model catalog is unusable flat) ──

  // Substring match, prefix hits first (the palette's ranking); empty query keeps pi's order.
  filteredDlgOptions(): string[] {
    const opts = this.dlg?.req.options ?? []
    const q = this.dlgFilter.trim().toLowerCase()
    return q ? rankFilter(opts, o => o.toLowerCase().indexOf(q)) : opts
  }

  // Type-to-filter input over the ranked options; arrows move, Enter picks, Escape cancels — the
  // palette's scheme. Every select consumer (extension dialogs, /model, /fork) inherits it.
  // Filter below the list, at the pills' anchored edge (bulb launcher / session picker parity).
  selectBody() {
    const rows = this.filteredDlgOptions()
    const active = Math.min(this.dlgIndex, Math.max(0, rows.length - 1))
    return div({ key: 'dlg-select' },
      // onMounted: a preselected row can sit mid-list — bring it into view when the dialog opens.
      div({ class: 'dlg-opts', onMounted: (el: Element) => el.querySelector('.at-row.active')?.scrollIntoView({ block: 'nearest' }) },
        this.#rowList(rows, 'No matches', active, i => this.answerDialog({ value: rows[i]! }), o => o)),
      inputText({
        target: this, prop: () => this.dlgFilter,
        attrs: {
          class: 'dlg-input dlg-filter', placeholder: 'Type to filter…',
          onMounted: this.#focusOnMount,
          onKeyDown: (e: KeyboardEvent) => this.#dlgSelectKey(e),
          // keyup = after the binding committed the value; reset the active row only when the query
          // changed (the palette's reset-on-query-change), never on arrow keys.
          onKeyUp: () => {
            if (this.dlgFilter !== this.#dlgFilterSeen) { this.#dlgFilterSeen = this.dlgFilter; this.dlgIndex = 0; this.update() }
          },
        },
      }),
    )
  }

  #dlgSelectKey(e: KeyboardEvent) {
    const rows = this.filteredDlgOptions()
    const active = Math.min(this.dlgIndex, Math.max(0, rows.length - 1))
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      this.dlgIndex = Math.max(0, Math.min(active + (e.key === 'ArrowDown' ? 1 : -1), rows.length - 1))
      this.update()
      setTimeout(() => document.querySelector('.dlg-opts .at-row.active')?.scrollIntoView({ block: 'nearest' }), 0)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const pick = rows[active]
      if (pick !== undefined) this.answerDialog({ value: pick })
      return
    }
    if (e.key === 'Escape') { e.preventDefault(); this.answerDialog({ cancelled: true }) }
  }
}
