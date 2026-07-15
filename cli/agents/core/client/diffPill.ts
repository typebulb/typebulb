import { div, span, button } from 'domeleon'
import { ComboboxPill } from './statusPill.js'
import { icon } from './icons.js'
import { searchFilter } from './ui.js'
import { highlightToLines } from './markdown.js'

// One changed file from gitChangedFiles; add/del ride from --numstat when known (absent ⇒ "new").
interface ChangedFile { path: string; status: string; add?: number; del?: number }
type DiffKind = 'add' | 'del' | 'ctx' | 'gap'
type DiffLine = { kind: DiffKind; text: string }

// Above this, skip real highlighting (hljs on megabytes blocks the UI) — plaintext still escapes fast.
const MAX_HIGHLIGHT_CHARS = 400_000

// Full-context unified diff, parsed for display: headers dropped, hunk gaps kept as ⋯ rows (rare —
// -U999999 usually yields one hunk), the ± re-drawn as the udiff gutter glyphs. "Binary file" covers
// both git's own "Binary files … differ" line and the server's untracked-binary note.
function parseDiff(text: string, untracked: boolean): DiffLine[] {
  const raw = text.split('\n').map(l => l.replace(/\r$/, ''))
  if (raw.length && raw[raw.length - 1] === '') raw.pop()
  if (untracked) return raw.map(l => ({ kind: 'add' as const, text: l }))
  const out: DiffLine[] = []
  let inHunk = false, pastFirst = false
  for (const l of raw) {
    if (l.startsWith('@@')) { if (pastFirst) out.push({ kind: 'gap', text: '⋯' }); pastFirst = true; inHunk = true; continue }
    if (!inHunk) { if (l.startsWith('Binary file')) out.push({ kind: 'ctx', text: l }); continue }
    if (l.startsWith('\\')) continue                       // "\ No newline at end of file"
    if (l.startsWith('+')) out.push({ kind: 'add', text: l.slice(1) })
    else if (l.startsWith('-')) out.push({ kind: 'del', text: l.slice(1) })
    else out.push({ kind: 'ctx', text: l.slice(1) })
  }
  return out
}

// The doc's render form: the per-line kinds for the ruler/counts, plus the body as one HTML string
// (per-line text has no consumer once the HTML exists, so it isn't kept — the doc is otherwise held
// three times over: raw text, rows, html). The
// highlight is TWO whole-file passes — old (ctx+del) and new (ctx+add) — so multi-line constructs
// lex correctly on both sides of a change; del lines take their tokens from the old pass, add/ctx
// from the new. Assembled to a single string injected once (per version), not per-line vnodes:
// thousands of onMounted injections would be the slow, stale-patch-prone shape.
function buildDoc(text: string, untracked: boolean, path: string): { kinds: DiffKind[]; bodyHtml: string } {
  const rows = parseDiff(text, untracked)
  const tag = text.length > MAX_HIGHLIGHT_CHARS ? 'txt' : (path.split('.').pop() ?? '')
  const oldSrc: string[] = [], newSrc: string[] = []
  for (const r of rows) {
    if (r.kind === 'ctx' || r.kind === 'del') oldSrc.push(r.text)
    if (r.kind === 'ctx' || r.kind === 'add') newSrc.push(r.text)
  }
  const oldHtml = highlightToLines(oldSrc.join('\n'), tag)
  const newHtml = highlightToLines(newSrc.join('\n'), tag)
  let oi = 0, ni = 0
  const parts: string[] = []
  for (const r of rows) {
    if (r.kind === 'gap') { parts.push('<div class="udiff-gap">⋯</div>'); continue }
    const html = r.kind === 'del' ? oldHtml[oi++]
      : r.kind === 'add' ? newHtml[ni++]
      : (oi++, newHtml[ni++])                        // ctx lives in both passes; consume both counters
    parts.push(`<div class="udiff-line${r.kind === 'add' ? ' udiff-add' : r.kind === 'del' ? ' udiff-del' : ''}">${html ?? ''}</div>`)
  }
  return { kinds: rows.map(r => r.kind), bodyHtml: parts.join('') }
}

// Status-bar git-diff pill (TB-Agent-Mirror.md): lists the working tree's changed files; picking one
// swaps the transcript for a full-context unified diff of that file — every unchanged line shown,
// deletions red, insertions green, one column (the same udiff classes the tool cards use). Render-only,
// the same move as prose mode: a view over `git status`/`git diff` reads — no writes, no inference
// (Invariant 1). The chip is `± N` (glyph + changed-file count) and hides entirely outside a git repo
// or on a clean tree — its appearing IS the "there are changes" signal, so the glyph stays colored;
// the accent border stays reserved for latched (menu or doc open), like every other pill.
export class DiffPill extends ComboboxPill<never> {
  files: ChangedFile[] = []
  repo = true                    // false once the probe says no git here — the chip renders nothing
  root = ''                      // repo toplevel (abs) — status paths are relative to it; openFile needs abs
  // The active diff doc — Root renders docView() in the transcript's place while set. `text` stays
  // raw so the live refresh can cheap-compare before reparsing/rehighlighting.
  viewing?: { path: string; status: string; text: string; truncated: boolean; kinds: DiffKind[]; bodyHtml: string }
  // Bumped per (re)build of the doc; keys the injected body so domeleon remounts it (and onMounted
  // re-injects) exactly when the content changed — the scroll container above it is stable, so the
  // user's scroll position rides through a live refresh.
  #docVersion = 0
  protected keepOpenSelector = '.gitdiff-wrap'
  protected filterId = 'gitdiff-filter'
  protected listSelector = '.gitdiff-list'
  protected filterNoun = 'file'
  protected search(): Promise<never[]> { return Promise.resolve<never[]>([]) }   // no full-text mode over a file list

  protected onActivate(i: number) {
    const f = this.rows()[i]
    if (f) this.openDiff(f)
  }

  override onAttached() {
    this.refreshFiles()
    // The chip's presence IS the "there are changes" signal, so the file list polls on a lazy tick
    // even with nothing open — one `git status` per beat (the bulbs pill's file-walk cadence). The
    // open doc refreshes faster: the diff grows in place as the agent edits.
    setInterval(() => this.refreshFiles(), 3000)
    setInterval(() => { if (this.viewing) this.refreshDiff() }, 1500)
  }

  rows(): ChangedFile[] {
    const q = this.filter.trim().toLowerCase()
    return q ? this.files.filter(f => f.path.toLowerCase().includes(q)) : this.files
  }

  async refreshFiles() {
    try {
      const { repo, root, files } = await tb.server.gitChangedFiles() as { repo: boolean; root: string; files: ChangedFile[] }
      const changed = repo !== this.repo || files.length !== this.files.length ||
        files.some((f, i) => { const o = this.files[i]; return f.path !== o?.path || f.status !== o.status || f.add !== o.add || f.del !== o.del })
      this.repo = repo
      this.root = root
      this.files = files
      if (changed) { this.update(); this.keepBottom() }
    } catch (err) { console.error('[mirror] gitChangedFiles failed', err) }
  }

  // The one constructor of `viewing` (open and refresh alike): build the doc from an RPC result,
  // bump the injection key, repaint.
  #setDoc(path: string, status: string, r: { text: string; untracked?: boolean; truncated?: boolean }) {
    this.viewing = { path, status, text: r.text, truncated: !!r.truncated, ...buildDoc(r.text, !!r.untracked, path) }
    this.#docVersion++
    this.update()
  }

  async openDiff(f: ChangedFile) {
    try {
      const r = await tb.server.gitDiff(f.path)
      if (!r.ok) { console.error('[mirror] gitDiff failed:', r.error); return }
      this.#setDoc(f.path, f.status, r)
      this.close()               // the popover closes; the pill stays latched via `viewing`
    } catch (err) { console.error('[mirror] gitDiff failed', err) }
  }

  // Background re-fetch of the open doc; reparse/rehighlight only when the bytes moved.
  async refreshDiff() {
    const v = this.viewing
    if (!v) return
    try {
      const r = await tb.server.gitDiff(v.path)
      if (this.viewing !== v || !r.ok || r.text === v.text) return
      this.#setDoc(v.path, v.status, r)
    } catch (err) { console.error('[mirror] gitDiff refresh failed', err) }
  }

  closeDoc() {
    this.viewing = undefined
    this.update()
  }

  show() {
    this.beginOpen()
    this.refreshFiles()          // not awaited — the sibling pills' shape; a change repaints via update()
    this.refreshList()
    this.armClose()
    this.focusFilter()
  }

  view() {
    const n = this.files.length
    // Clean tree ⇒ no chip — but never yank it out from under an open menu/doc (a commit mid-view
    // zeroes the list; the surfaces close via their own affordances first).
    if (!this.repo || (n === 0 && !this.viewing && !this.open)) return div({ class: 'gitdiff-wrap' })
    return div({ class: 'gitdiff-wrap' },
      button({
        class: ['pill', 'glyph', 'gitdiff-pill', this.viewing || this.open ? 'on' : ''],
        title: `${n} changed file${n === 1 ? '' : 's'} — view a diff`,
        onClick: (e: MouseEvent) => { e.stopPropagation(); this.open ? this.close() : this.show() },
      }, icon('diff'), span({ class: 'gitdiff-count' }, String(n))),
      this.open ? this.popup() : null,
    )
  }

  popup() {
    const rows = this.rows()
    return div({ class: 'servers-pop gitdiff-pop' },
      rows.length === 0
        ? this.emptyState('No changes in the working tree.')
        : div({ class: 'gitdiff-list', onScroll: () => this.onListScroll() },
            rows.map((f, i) => this.row(f, i))),
      this.filterRow(),
    )
  }

  // The combobox filter row minus the full-text toggle (a 🔬 makes no sense over a file list).
  filterRow() {
    const n = this.files.length
    return searchFilter({
      target: this,
      prop: () => this.filter,
      id: this.filterId,
      placeholder: n ? `Filter ${n} file${n === 1 ? '' : 's'}…` : 'Filter files…',
      hasValue: !!this.filter,
      onKeyDown: (e: KeyboardEvent) => this.onFilterKey(e),
      onClear: () => this.clearFilter(),
    })
  }

  row(f: ChangedFile, i: number) {
    return div({
        class: ['gitdiff-row', i === this.highlighted ? 'active' : '', this.viewing?.path === f.path ? 'viewing' : ''],
        onMouseEnter: () => { if (this.highlighted !== i) { this.highlighted = i; this.update() } },
        onClick: (e: MouseEvent) => { e.stopPropagation(); this.openDiff(f) },
      },
      span({ class: ['gitdiff-status', `s-${f.status}`] }, f.status),
      span({ class: 'gitdiff-path', title: f.path }, f.path),
      f.add !== undefined || f.del !== undefined
        ? span({ class: 'gitdiff-counts' }, span({ class: 'count-add' }, `+${f.add ?? 0}`), span({ class: 'count-del' }, `−${f.del ?? 0}`))
        : span({ class: 'gitdiff-counts' }, span({ class: 'count-add' }, 'new')),
    )
  }

  // The diff doc, rendered by Root in the transcript's place. Esc / ← returns to the conversation.
  docView() {
    const v = this.viewing!
    const add = v.kinds.filter(k => k === 'add').length
    const del = v.kinds.filter(k => k === 'del').length
    return div({ class: 'diff-doc', tabIndex: 0,
        onMounted: (el: Element) => (el as HTMLElement).focus(),
        onKeyDown: (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); this.closeDoc() } } },
      div({ class: 'diff-doc-head' },
        span({ class: ['gitdiff-status', `s-${v.status}`] }, v.status),
        span({ class: 'diff-doc-path', title: `Open ${v.path}`,
          onClick: () => tb.server.openFile(`${this.root}/${v.path}`) }, v.path),
        span({ class: 'gitdiff-counts' }, span({ class: 'count-add' }, `+${add}`), span({ class: 'count-del' }, `−${del}`)),
        button({ class: 'bulb-log-back', title: 'Back to the conversation (Esc)',
          onClick: (e: MouseEvent) => { e.stopPropagation(); this.closeDoc() } }, '← conversation'),
      ),
      // A relative wrapper so the overview ruler overlays the pane instead of scrolling with it.
      div({ class: 'diff-doc-scroll' },
        div({ class: 'diff-doc-body' },
          v.kinds.length === 0
            ? div({ class: 'diff-doc-empty' }, 'No changes.')
            // One innerHTML injection per content version (see #docVersion) — the highlighted lines
            // are hljs output + our own escaping, never raw transcript/file text.
            : div({ class: 'diff-doc-code', key: `diff-code-${this.#docVersion}`,
                onMounted: (el: Element) => { el.innerHTML = v.bodyHtml } }, ''),
          v.truncated ? div({ class: 'diff-doc-trunc' }, 'Diff truncated — file too large to show in full.') : null,
        ),
        v.kinds.length ? this.ruler(v.kinds) : null,
      ),
    )
  }

  // VS Code's overview ruler, minus the scrollbar dependency: a thin track hugging the pane's right
  // edge, one mark per add/del run at its lines' fractional position — the "where are the changes"
  // map that makes a long full-context diff scannable. Positions are line-index fractions (wrapped
  // long lines skew them slightly — an approximation VS Code's ruler shares). Click jumps there.
  ruler(kinds: DiffKind[]) {
    const n = kinds.length
    const runs: { kind: 'add' | 'del'; start: number; len: number }[] = []
    kinds.forEach((k, i) => {
      if (k !== 'add' && k !== 'del') return
      const last = runs[runs.length - 1]
      if (last && last.kind === k && last.start + last.len === i) last.len++
      else runs.push({ kind: k, start: i, len: 1 })
    })
    return div({
        class: 'diff-ruler',
        title: 'Jump to a change',
        onClick: (e: MouseEvent) => {
          const body = document.querySelector('.diff-doc-body')
          const track = e.currentTarget as HTMLElement
          if (!body) return
          const frac = (e.clientY - track.getBoundingClientRect().top) / track.clientHeight
          body.scrollTop = frac * body.scrollHeight - body.clientHeight / 2
        },
      },
      runs.map(r => div({
        class: ['diff-ruler-mark', r.kind],
        style: { top: `${(r.start / n) * 100}%`, height: `${(r.len / n) * 100}%` },
      })),
    )
  }
}
