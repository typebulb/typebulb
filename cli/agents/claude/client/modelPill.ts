import { div, span, button, inputText, inputSelect, svg, path, VElement } from 'domeleon'
import { ComboboxPill } from '../../core/client/statusPill.js'

// The agent switcher (TB-Agent-Switcher.md): a status-bar menu that switches which model backs every
// `claude` launch — terminal and VS Code/Cursor extension — by routing CC's API traffic through a local
// proxy the mirror runs. When an override is active the proxy rewrites the model on every request before
// forwarding to OpenRouter, so whatever CC resolves, OpenRouter only ever sees the chosen model. The pill
// shows the live model AUTHORITATIVELY (read from the proxy, not inferred from a stale transcript), and
// the caching cue comes from the proxy's direct observation of real responses. OpenRouter only, project
// scope.
//
// Built on ComboboxPill for the same look + keyboard nav as the session/bulb menus, but with no full-text
// corpus, so the 🔬 mode toggle is dropped (modeToggle → null) and search() never fires. Three row kinds:
// the "Anthropic (native)" row at top (clicking it IS the revert), one row per OpenRouter model (the
// active one marked), and — only when no key is present — a single "add key" row.

type ModelOpt = { id: string; label: string }
type ModelRow =
  | { kind: 'default'; active: boolean }
  | { kind: 'model'; id: string; label: string; active: boolean }
  | { kind: 'unlock' }

// The authoritative proxy state (server-side module state, not the settings file). `active` ⇒ the proxy
// is routing; `routedModel` is the model CC last SENT pre-rewrite (an Anthropic value means the proxy
// caught a desync and rewrote it); `caching` is observed from the last response; `externalBaseUrl` is a
// base URL set outside this tool, surfaced only when we're not active.
type SwitchState = {
  active: boolean; managed: boolean; model: string | null; port: number | null
  provider: string | null; routedModel: string | null
  caching: 'live' | 'uncached' | 'unknown'; reasoning: number | null; externalBaseUrl: string | null
}

// The reasoning dial — CC-calibrated low/medium/high, shown only while routing to an OpenRouter model.
// Index maps to the server's EFFORT (switcher.ts) → OpenRouter `reasoning.effort`; we drop CC's "max"
// (Anthropic-only). `low` is the floor (no off state). Keep these two in sync with switcher.ts.
const REASONING_LEVELS: [number, string][] = [[0, 'Low'], [1, 'Med'], [2, 'High']]
// The level pre-selected when the route has no explicit reasoning yet — medium, CC's Opus default. Mirrors
// the server's own default (switcher.ts reasoningLevel); keep the two in sync.
const DEFAULT_REASONING = 1

const errMsg = (e: unknown) => (e as Error)?.message ?? String(e)

// The Anthropic brand glyph, inlined so the default row's pill can show the mark instead of the word
// "Anthropic" — a square glyph pill the size of the prose toggle, currentColor so it tracks state.
const anthropicGlyph = () => svg(
  { viewBox: '0 0 24 24', width: '15', height: '15', class: 'anthropic-glyph', fill: 'currentColor' },
  path({ d: 'M13.827 3.52h3.603L24 20h-3.603l-6.57-16.48zm-7.258 0h3.767L16.906 20h-3.674l-1.343-3.461H5.017l-1.344 3.46H0L6.57 3.522zm4.132 9.959L8.453 7.687 6.205 13.48H10.7z' }),
)

type ProbeCache = { works: boolean | null; read: number; created: number; note: string }
type ProbeResult = {
  ok: boolean; callable?: boolean; status?: number; ms?: number; sample?: string
  error?: string; restriction?: string; provider?: string; cache?: ProbeCache
}

// One mapping from a caching verdict to a status colour, shared by the row badge and the diag panel so
// they can't disagree: confirmed → ok, no-caching → bad (it bites on cost), unconfirmed → neutral.
const cacheClass = (works: boolean | null | undefined) => works === true ? 'ok' : works === false ? 'bad' : 'warn'

export class ModelPill extends ComboboxPill<never> {
  models: ModelOpt[] = []
  hasKey = true                              // optimistic until the first load, so the unlock row doesn't flash
  loaded = false                             // a refresh has completed (success or failure) at least once
  current: SwitchState = { active: false, managed: false, model: null, port: null, provider: null, routedModel: null, caching: 'unknown', reasoning: null, externalBaseUrl: null }
  busy = false
  err: string | null = null
  enteringKey = false
  keyDraft = ''                              // bound to the key-entry input via inputText
  probes: Record<string, ProbeResult> = {}   // per-model probe results, kept for the page's life (session cache)
  probing: string | null = null              // the model id whose probe is in flight (one at a time)
  openDiag: string | null = null             // model id whose diagnostics drill-in is open
  infoOpen = false                            // the "More info" routing/reasoning explainer drill-in is open
  private ticking = false                     // a background switchState poll is in flight (re-entrancy guard)

  protected keepOpenSelector = '.model-wrap'
  protected filterId = 'model-filter'
  protected listSelector = '#model-list'
  protected filterNoun = 'model'

  protected search() { return Promise.resolve([] as never[]) }
  protected override modeToggle(): VElement { return null as unknown as VElement }

  protected onActivate(i: number) {
    const r = this.rows()[i]
    if (!r) return
    if (r.kind === 'default') this.clear()
    else if (r.kind === 'unlock') this.beginKeyEntry()
    else this.set(r.id)
  }

  override onAttached() { this.refresh() }

  // Full load — the model catalog + key presence + live state. Runs on attach and on menu open.
  async refresh() {
    try {
      const [list, st] = await Promise.all([
        tb.server.listSwitchModels() as Promise<{ hasKey: boolean; models: ModelOpt[]; error?: string }>,
        tb.server.switchState() as Promise<SwitchState>,
      ])
      this.models = list.models
      this.hasKey = list.hasKey
      this.current = st
      this.err = list.error ?? null   // a fetch failure that emptied the menu → the "Couldn't load" empty state
    } catch (err) {
      this.err = errMsg(err)
      console.error('[mirror] switcher refresh failed', err)
    } finally {
      this.loaded = true
      this.update()
    }
  }

  // Lightweight live-state poll, called from Root's pump each tick — keeps the pill's model + caching cue
  // authoritative and current without the menu being open (switchState is module-state, cheap). Skips the
  // catalog/key load that refresh() does; never fires while typing a key.
  async tickState() {
    if (this.ticking || this.enteringKey) return
    this.ticking = true
    try {
      const st = await tb.server.switchState() as SwitchState
      const changed = st.active !== this.current.active || st.model !== this.current.model
        || st.caching !== this.current.caching || st.routedModel !== this.current.routedModel
        || st.externalBaseUrl !== this.current.externalBaseUrl || st.provider !== this.current.provider
        || st.reasoning !== this.current.reasoning
      this.current = st
      if (changed) this.update()
    } catch { /* transient — the next tick retries */ }
    finally { this.ticking = false }
  }

  // Reverse / bottom-anchored, like the session + bulb menus. "Anthropic (native)" is hard-pinned at the
  // bottom (the home / revert row); the models (or the no-key unlock row) sit above it. The active model is
  // hoisted to *directly above* the Anthropic row so it's always in view when the bottom-anchored menu opens
  // — otherwise a selection sitting high in the catalog scrolls off the top. (On Anthropic native nothing is
  // hoisted: no model row is active, and the Anthropic row itself carries the active mark.)
  rows(): ModelRow[] {
    const out: ModelRow[] = []
    if (!this.hasKey) {
      out.push({ kind: 'unlock' })
    } else {
      const q = this.filter.trim().toLowerCase()
      let activeRow: ModelRow | null = null
      for (const m of this.models) {
        if (q && !m.label.toLowerCase().includes(q) && !m.id.toLowerCase().includes(q)) continue
        const row: ModelRow = { kind: 'model', id: m.id, label: m.label, active: this.current.active && this.current.model === m.id }
        if (row.active) activeRow = row // hold it back, append last (just above the Anthropic row)
        else out.push(row)
      }
      if (activeRow) out.push(activeRow)
    }
    out.push({ kind: 'default', active: !this.current.active && !this.current.externalBaseUrl })
    return out
  }

  private activeIndex(): number {
    const rs = this.rows()
    const i = rs.findIndex(r => (r as { active?: boolean }).active)
    return i < 0 ? Math.max(0, rs.length - 1) : i
  }

  async show() {
    this.beginOpen()
    this.refreshList(this.activeIndex())
    this.focusFilter()
    await this.refresh()
    this.refreshList(this.activeIndex())
    this.armClose()
  }

  protected override onClosed() {
    super.onClosed()
    this.enteringKey = false
    this.keyDraft = ''
    this.openDiag = null
    this.infoOpen = false
    this.err = null
    // probes survive close/reopen (a session cache) — re-probing costs real calls, so don't discard.
  }

  // Probe one model: 2 real paid calls against the OpenRouter route (callability + caching). A confirmed-
  // caching provider is remembered server-side and pinned by the proxy on every forward. Explicit per-row
  // action, never auto-run (Invariant 2: disclosed spend). One at a time.
  async probe(id: string) {
    if (this.probing) return
    this.probing = id; this.update()
    try {
      this.probes[id] = await tb.server.probeModel({ model: id }) as ProbeResult
    } catch (e) {
      this.probes[id] = { ok: false, error: errMsg(e) }
    }
    this.probing = null
    this.update()
  }

  showDiag(id: string) { this.openDiag = id; this.update() }
  closeDiag() { this.openDiag = null; this.update(); this.focusFilter() }

  private label(id: string | null): string {
    if (!id) return 'Anthropic'
    return this.models.find(m => m.id === id)?.label || id.split('/').pop() || id
  }

  private async runBusy(fn: () => Promise<{ ok?: boolean; error?: string }>, fallback: string): Promise<boolean> {
    this.busy = true; this.err = null; this.update()
    try {
      const r = await fn()
      if (r?.ok === false) { this.err = r.error || fallback; this.busy = false; this.update(); return false }
    } catch (e) {
      this.err = errMsg(e); this.busy = false; this.update(); return false
    }
    this.busy = false
    return true
  }

  // Set the model. No pre-write confirm anymore: the proxy rewrites whatever CC resolves at the wire, so
  // there is no rung-1 desync to warn about — the footgun the old confirm guarded is now structurally
  // closed.
  async set(id: string) {
    if (!await this.runBusy(() => tb.server.setSwitchModel({ model: id }) as Promise<{ ok: boolean; error?: string }>, 'failed to set model')) return
    await this.refresh()
    this.close()
  }

  async clear() {
    if (!await this.runBusy(() => tb.server.clearSwitchModel() as Promise<{ ok: boolean }>, 'failed to revert')) return
    await this.refresh()
    this.close()
  }

  // Two-way binding target for the reasoning dropdown. The getter falls back to the default so the select
  // is never blank when the route has no explicit level yet; the setter routes through setReasoning.
  get reasoningSel(): number { return this.current.reasoning ?? DEFAULT_REASONING }
  set reasoningSel(level: number) { void this.setReasoning(level) }

  // Set the reasoning level (0–3). Optimistic + keeps the popover open — it's a quick proxy-internal flip,
  // no settings write, so no busy spinner and no menu close (unlike set/clear). Takes effect next CC turn.
  async setReasoning(level: number) {
    if (this.current.reasoning === level) return
    this.current = { ...this.current, reasoning: level }
    this.update()
    try {
      const r = await tb.server.setReasoning({ level }) as { ok: boolean; error?: string }
      if (r?.ok === false) { this.err = r.error || 'failed to set reasoning'; this.update() }
    } catch (e) { this.err = errMsg(e); this.update() }
  }

  beginKeyEntry() {
    this.enteringKey = true
    this.keyDraft = ''
    this.update()
    setTimeout(() => document.getElementById('or-key-input')?.focus())
  }
  cancelKeyEntry() {
    this.enteringKey = false
    this.keyDraft = ''
    this.update()
    this.focusFilter()
  }
  async saveKey() {
    const key = this.keyDraft.trim()
    if (!key) return
    if (!await this.runBusy(() => tb.server.saveOpenRouterKey({ key }) as Promise<{ ok: boolean; error?: string }>, 'failed to save key')) return
    this.enteringKey = false
    this.keyDraft = ''
    await this.refresh()          // hasKey now true → the model rows appear
    this.refreshList(this.activeIndex())
  }

  // ---- live state, read from the proxy ----
  get overridden(): boolean { return this.current.active }
  // The cache cue is now a measured fact: the proxy observes each response's usage and reports uncached
  // when a substantial turn billed its whole context as fresh input. Amber, not red — a cache flip is
  // pennies-scale (the Opus desync, the red catastrophe, is now impossible at the wire).
  get uncached(): boolean { return this.current.active && this.current.caching === 'uncached' }

  // The watchdog banner (rendered by Root above the statusbar). Amber for the measured uncached route; no
  // red tier — the model desync the old red banner caught can no longer happen.
  watchdogView(): VElement | null {
    if (this.uncached) {
      return div({ class: ['model-banner', 'warn'] },
        span({ class: 'model-banner-text' },
          `${this.label(this.current.model)} was served uncached via OpenRouter — the full context is re-billed each turn. Probe the model to pin a provider that caches, or pick a different one.`))
    }
    return null
  }

  // The popover's top section: ONE row — a "More info" link on the left (lined up with the model titles
  // below) and the reasoning dial on the right (a "reasoning" label + the Low/Med/High select, the
  // select sized and column-aligned to the per-row "probe" button). The route headline was dropped as
  // redundant — the statusbar pill and the active-row marker already show the model — and the long
  // explanatory text moved into the "More info" drill-in (infoView), so the row stays one clean line.
  // The external-override warning is the one case that still needs words here.
  head(): VElement | null {
    if (!this.current.active) {
      if (this.current.externalBaseUrl)
        return div({ class: 'model-head' },
          span({ class: ['model-route', 'warn'] },
            'Custom base URL set elsewhere — “Anthropic (native)” clears it'))
      return null
    }
    return div({ class: 'model-head' },
      button({ class: 'model-info-toggle',
        onClick: (e: MouseEvent) => { e.stopPropagation(); this.infoOpen = true; this.update() } },
        'Routing info'),
      div({ class: 'reasoning-ctl', title: 'Reasoning sets the route’s base thinking effort.' },
        span({ class: 'reasoning-label' }, 'reasoning'),
        this.reasoningSelect(),
      ),
    )
  }

  // The reasoning dial — one global control for the whole route (NOT per-model): the route's BASE effort.
  // Per-turn `ultrathink` is not overridden — it rides through to the routed model as a reminder message,
  // same as native CC (see switcher.ts rewriteBody). Low/Med/High via a plain native select (a full combobox
  // is over-powered for three fixed levels), sized to the probe-button width so the two share a column.
  reasoningSelect(): VElement {
    return inputSelect({
      target: this,
      prop: () => this.reasoningSel,
      attrs: { class: 'reasoning-select', onClick: (e: MouseEvent) => e.stopPropagation() },
      options: REASONING_LEVELS.map(([value, label]) => ({ value, label })),
    })
  }

  // "More info" drills into a returnable full-popover view — the same diag-mode chrome the probe
  // diagnostics and the bulb logs use (a "← models" back). A little "Routing" explainer: where bare
  // `claude` now routes, the project scope, and how to restart after a to/from-Anthropic switch. (The
  // reasoning dial's one-liner lives in its own tooltip, not here.)
  infoView(): VElement {
    const model = this.label(this.current.model)
    const back = () => { this.infoOpen = false; this.update() }
    return div({ class: 'picker model-picker diag-mode', tabIndex: 0,
        onMounted: (el: Element) => (el as HTMLElement).focus(),
        onKeyDown: (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); back() } } },
      div({ class: 'diag-head' },
        span({ class: 'diag-name' }, 'Routing'),
        div({ class: 'diag-head-acts' },
          button({ class: 'diag-back', title: 'Back to the model list',
            onClick: (e: MouseEvent) => { e.stopPropagation(); back() } }, '← models'),
        ),
      ),
      div({ class: 'diag-body' },
        div({ class: 'diag-line' },
          `You are currently routing to ${model} via OpenRouter, not your Anthropic subscription.`),
        div({ class: 'diag-line' },
          'The route is shared by every Claude Code conversation scoped to this project.'),
        div({ class: 'diag-line' },
          'Switching to or from Anthropic toggles the proxy, so for existing conversations you’ll need to:'),
        div({ class: ['diag-line', 'diag-bullet'] }, '• Relaunch the Claude CLI'),
        div({ class: ['diag-line', 'diag-bullet'] },
          '• or, in the VS Code extension, run “Developer: Restart Extension Host” (Cmd/Ctrl+Shift+P).'),
      ),
    )
  }

  view(): VElement {
    const active = this.current.active
    const uncached = this.uncached
    const ext = !active && !!this.current.externalBaseUrl
    const label = this.label(this.current.model)
    const tip = uncached
      ? `${label} via OpenRouter, uncached — full context re-billed each turn. Click to switch or revert.`
      : active
        ? `claude → ${this.current.model}: its Anthropic API is proxied to OpenRouter. Click to switch or revert.`
        : ext
          ? `Custom ANTHROPIC_BASE_URL set outside this tool (${this.current.externalBaseUrl}). Click to manage.`
          : 'Anthropic (native) — click to proxy claude’s Anthropic API to an OpenRouter model.'
    // Default: the brand glyph stands in for the word (saving bar width). Active: the model name. External
    // override: a "custom route" label. The uncached cue is the amber border.
    const content = active ? label : ext ? 'custom route' : anthropicGlyph()
    return div({ class: 'model-wrap' },
      button({
        class: ['pill', active || ext ? 'on' : 'glyph', uncached ? 'warn' : ''],
        title: tip,
        ariaLabel: active || ext ? undefined : 'Anthropic (native)',
        onClick: (e: MouseEvent) => { e.stopPropagation(); this.open ? this.close() : this.show() },
      }, content),
      this.open ? this.popup() : null,
    )
  }

  popup(): VElement {
    if (this.enteringKey) return this.keyView()
    if (this.infoOpen) return this.infoView()
    if (this.openDiag) return this.diagView(this.openDiag)
    const rows = this.rows()
    const emptyWithKey = this.loaded && this.hasKey && !this.models.length
    return div({ class: 'picker model-picker' },
      this.head(),
      div({ id: 'model-list', class: 'picker-list', onScroll: () => this.onListScroll() },
        rows.map((r, i) => this.row(r, i)),
        emptyWithKey
          ? div({ class: 'picker-empty' }, this.err
              ? `Couldn't load models: ${this.err}`
              : 'No OpenRouter models in the catalog right now.')
          : null,
      ),
      this.err && !emptyWithKey ? div({ class: 'model-err' }, `✗ ${this.err}`) : null,
      this.hasKey && this.models.length ? this.filterBox(this.models.length, 'model') : null,
    )
  }

  row(r: ModelRow, i: number): VElement {
    const onMouseEnter = () => { if (this.highlighted !== i) { this.highlighted = i; this.update() } }
    const base = ['picker-row', i === this.highlighted ? 'active' : '']
    if (r.kind === 'unlock') {
      return div({ class: base, onMouseEnter, onClick: () => this.onActivate(i) },
        div({ class: 'picker-row-main' },
          span({ class: 'picker-dot' }),
          span({ class: 'picker-preview' }, '+ Add OpenRouter key to unlock models…')))
    }
    if (r.kind === 'default') {
      return div({
        class: [...base, r.active ? 'current' : '', 'model-row', 'model-default-row'],
        title: 'Your normal claude (subscription / API) — clears the override',
        onMouseEnter, onClick: () => this.onActivate(i),
      },
        div({ class: 'picker-row-main' },
          span({ class: 'picker-dot' }),
          span({ class: 'picker-preview' }, 'Anthropic (native)'),
          div({ class: 'model-trailing' }, r.active ? this.activeBadge() : null),
        ),
      )
    }
    const id = r.id
    return div({
      class: [...base, r.active ? 'current' : '', 'model-row'],
      title: id,
      onMouseEnter,
      onClick: () => this.onActivate(i),
    },
      div({ class: 'picker-row-main' },
        span({ class: 'picker-dot' }),
        span({ class: 'picker-preview' }, r.label),
        div({ class: 'model-trailing' },
          r.active ? this.activeBadge() : null,
          this.statusButton(id),
        ),
      ),
    )
  }

  activeBadge(): VElement {
    return span({ class: ['model-btn', 'model-active'], title: 'Active — bare claude routes here now' }, 'active')
  }

  statusButton(id: string): VElement {
    if (this.probing === id)
      return span({ class: ['model-btn', 'model-status', 'probing'] }, 'probing…')
    const p = this.probes[id]
    if (!p) {
      return button({
        class: ['model-btn', 'model-status', 'probe'],
        title: 'Check if it’s callable and which provider caches — pins the caching one.',
        onClick: (e: MouseEvent) => { e.stopPropagation(); this.probe(id) },
      }, 'probe')
    }
    const b = this.badge(p)
    return button({
      class: ['model-btn', 'model-status', b.cls],
      title: `${b.title} · click for details`,
      onClick: (e: MouseEvent) => { e.stopPropagation(); this.showDiag(id) },
    }, b.text)
  }

  private badge(p: ProbeResult): { text: string; cls: string; title: string } {
    if (!p.ok || p.callable === false) return { text: 'error', cls: 'bad', title: p.error || 'unavailable' }
    const on = p.provider ? ` on ${p.provider}` : ''
    const w = p.cache?.works, cls = cacheClass(w)
    if (w === true) return { text: 'cached', cls, title: `caching confirmed${on} — ${p.cache?.note || ''}` }
    if (w === false) return { text: 'uncached', cls, title: `no caching${on} — ${p.cache?.note || ''}` }
    return { text: 'cache?', cls, title: `${p.cache?.note || 'caching unconfirmed'}${on}` }
  }

  diagView(id: string): VElement {
    return div({ class: 'picker model-picker diag-mode', tabIndex: 0,
        onMounted: (el: Element) => (el as HTMLElement).focus(),
        onKeyDown: (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); this.closeDiag() } } },
      div({ class: 'diag-head' },
        span({ class: 'diag-name' }, this.label(id)),
        div({ class: 'diag-head-acts' },
          button({ class: 'diag-back', title: 'Re-run the probe', disabled: this.probing === id,
            onClick: (e: MouseEvent) => { e.stopPropagation(); this.probe(id) } }, this.probing === id ? 'probing…' : 'probe again'),
          button({ class: 'diag-back', title: 'Back to the model list',
            onClick: (e: MouseEvent) => { e.stopPropagation(); this.closeDiag() } }, '← models'),
        ),
      ),
      div({ class: 'diag-body' }, ...this.diagLines(id)),
    )
  }

  private diagLines(id: string): VElement[] {
    const p = this.probes[id]
    if (!p) return [div({ class: ['diag-line', 'muted'] }, 'Not probed yet — close this and hit probe.')]
    const out: VElement[] = []
    if (!p.ok || p.callable === false) {
      out.push(div({ class: ['diag-line', 'bad'] }, `✗ Not callable${p.status ? ` (HTTP ${p.status})` : ''}: ${p.error || 'unknown error'}`))
      if (p.restriction) out.push(div({ class: ['diag-line', 'warn'] }, `⚠ ${p.restriction}`))
    } else {
      out.push(div({ class: ['diag-line', 'ok'] },
        `✓ Callable${p.ms ? ` · ${p.ms}ms` : ''}${p.sample ? ` · replied “${p.sample}”` : ''}`))
      if (p.provider)
        out.push(div({ class: ['diag-line', 'muted'] },
          `Served by ${p.provider} this probe — the proxy will pin CC's turns to it when caching is confirmed.`))
      const c = p.cache
      if (c) {
        const cls = cacheClass(c.works)
        const head = c.works === true ? '✓ Caching works' : c.works === false ? '✗ No caching' : '~ Caching unconfirmed'
        const on = p.provider ? ` on ${p.provider}` : ''
        out.push(div({ class: ['diag-line', cls] }, `${head}${on} — ${c.note}`))
        if (c.works !== true)
          out.push(div({ class: ['diag-line', 'muted'] },
            'Without prompt caching every turn re-bills the whole context — costly over a long session.'))
      }
    }
    out.push(div({ class: ['diag-line', 'muted', 'small'] },
      'Caching on OpenRouter is per-provider; the proxy pins the provider a probe confirms so CC keeps caching. A probe makes two small test calls.'))
    return out
  }

  keyView(): VElement {
    return div({ class: 'picker model-picker key-entry', tabIndex: 0,
        onKeyDown: (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); this.cancelKeyEntry() } } },
      div({ class: 'key-entry-head' }, 'Paste your OpenRouter API key'),
      inputText({
        target: this,
        prop: () => this.keyDraft,
        id: 'or-key-input',
        attrs: {
          class: 'bulb-filter', placeholder: 'sk-or-…', ariaLabel: 'OpenRouter API key',
          onKeyDown: (e: KeyboardEvent) => {
            if (e.key === 'Enter') { e.preventDefault(); this.saveKey() }
            else if (e.key === 'Escape') { e.stopPropagation(); this.cancelKeyEntry() }
          },
        },
      }),
      this.err ? div({ class: 'model-err' }, `✗ ${this.err}`) : null,
      div({ class: 'key-entry-acts' },
        button({ class: 'pill', onClick: (e: MouseEvent) => { e.stopPropagation(); this.cancelKeyEntry() } }, 'Cancel'),
        button({ class: ['pill', 'on'], onClick: (e: MouseEvent) => { e.stopPropagation(); this.saveKey() } }, this.busy ? 'Saving…' : 'Save'),
      ),
      div({ class: 'key-entry-note' }, 'Written to .env in this project (gitignored). Used only via OpenRouter.'),
    )
  }
}
