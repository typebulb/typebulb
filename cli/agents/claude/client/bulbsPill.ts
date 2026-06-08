import { div, span, a, button, pre, svg, path, rect } from 'domeleon'
import { ComboboxPill } from './statusPill.js'
import { searchFilter } from './ui.js'
import { pathKey, basename, bulbBasename, relTime } from './util.js'
import type { RunningServer, BulbFile, BulbRow } from './types.js'

// Inline SVG play/stop icons for the launch/stop controls (the pattern from
// typebulbs/xor-x-ray.bulb.md): font glyphs centre unpredictably across platforms, a fixed
// viewBox is reliable, and currentColor lets the button's own colour flow through.
const btnIcon = (...shapes: unknown[]) => svg({ viewBox: '0 0 16 16', width: '13', height: '13', class: 'btn-icon' }, ...shapes as never[])
// Triangle nudged ~2px right of centre: a right-pointing triangle's visual mass sits left of its
// bounding box, so geometric centring reads as too-far-left in the round button.
const iconPlay = () => btnIcon(path({ d: 'M5.5 2 L15.5 8 L5.5 14 Z', fill: 'currentColor' }))
const iconStop = () => btnIcon(rect({ x: 3, y: 3, width: 10, height: 10, fill: 'currentColor' }))

// Status-bar bulb launcher + off-switch. Lists every *.bulb.md in the project (MRU-first,
// type to filter) so a bulb you just authored is one click from running — no trip to the
// terminal — and overlays the machine-global running-server registry so the same menu
// stops them. A broken-out/launched server is detached and outlives this page (surviving
// every hot-reload), so without this the only way to stop one is the OS. The bulb drives
// nothing except launching (Invariant 2) — the same deliberate exception as breakout.
//
// The host's own file (the mirror you're looking through) is dropped — no relaunching
// yourself — identified by *pid*, not filename, so it survives a rename and doesn't hide a
// second, unrelated mirror. Polls on a lazy cadence: the set changes on a launch / stop /
// breakout / edit, not per-frame.
export class BulbsPill extends ComboboxPill {
  files: BulbFile[] = []
  servers: RunningServer[] = []
  protected keepOpenSelector = '.servers-wrap'
  protected filterId = 'bulb-filter'
  // Bulb paths (pathKey) mid-launch — a transient in-memory state (NO persistence): launchBulbServer
  // doesn't resolve until the server registers (~2s), so the play button shimmers until then.
  launching = new Set<string>()
  // Denials (by pid) the user chose to keep restricted, so the elevation modal doesn't
  // nag again for the same running bulb. Resets when that bulb stops (new pid).
  dismissedDenials = new Set<number>()
  // A stopped bulb the proactive scan thinks needs trust, awaiting the user's launch-tier choice.
  // Set by launch() before anything spawns, so the offer precedes the tab opening (not after the
  // server registers). Cleared on choice or dismiss.
  pendingLaunch?: { path: string; name: string; cap: string }
  // The bulb whose console is being tailed, if any (one at a time).
  openLog?: { pid: number; name: string; text: string; offset: number }
  #logTimer?: ReturnType<typeof setInterval>

  protected itemCount() { return this.rows().length }
  protected listEl() { return document.querySelector('.bulb-list') }
  // Enter on the highlighted row: open a running server's tab, or launch a stopped bulb.
  protected onActivate(i: number) {
    const r = this.rows()[i]
    if (r) r.running ? window.open(r.running.url, '_blank', 'noopener') : this.launch(r.path)
  }

  override onAttached() {
    this.refresh()
    // The running registry is cheap (reads one dir) and carries the time-critical signal —
    // a denial flag that must raise the elevation modal promptly — so poll it fast. The file
    // walk is heavier (recursive project scan) and only changes on author/launch, so it stays
    // lazy. Splitting them keeps the modal near-instant without re-walking the tree every tick.
    setInterval(() => this.refreshServers(), 800)
    setInterval(() => this.refreshFiles(), 3000)
    // breakout resolves only after the new server has self-registered, so this nudge
    // refreshes immediately rather than waiting for the next backstop tick.
    window.addEventListener('tb-breakout', () => this.refreshServers())
  }

  refresh() { return Promise.all([this.refreshServers(), this.refreshFiles()]) }

  // Running registry only. Re-render on any change that the UI shows — count, identity, AND
  // the per-server flags the rows/modal key off (`denied`/`predicted` drive the elevation modal;
  // `trust` drives the badge). Omitting the flags is why the modal used to lag seconds behind a
  // denial: it changes neither count nor pid, so the old check stayed false and skipped update().
  async refreshServers() {
    try {
      const servers = await tb.server.listBreakouts() as RunningServer[]
      const changed =
        servers.length !== this.servers.length ||
        servers.some((s, i) =>
          s.pid !== this.servers[i]?.pid ||
          s.denied !== this.servers[i]?.denied ||
          s.predicted !== this.servers[i]?.predicted ||
          s.trust !== this.servers[i]?.trust)
      this.servers = servers
      if (changed) this.update()
    } catch (err) {
      console.error('[mirror] server list refresh failed', err)
    }
  }

  // Project *.bulb.md files (the heavier recursive walk). Re-render only on a real change so
  // the lazy tick is otherwise invisible.
  async refreshFiles() {
    try {
      const files = await tb.server.listBulbFiles() as BulbFile[]
      const changed =
        files.length !== this.files.length ||
        files.some((f, i) => f.path !== this.files[i]?.path || f.mtime !== this.files[i]?.mtime)
      this.files = files
      if (changed) this.update()
    } catch (err) {
      console.error('[mirror] bulb list refresh failed', err)
    }
  }

  // Project files ∪ running servers, keyed by path. The host's own file (and byte-identical copies)
  // are already dropped server-side in listBulbFiles; its own running server is dropped here by pid.
  // A running server outside the project still shows so the off-switch stays unified. MRU = max(file
  // mtime, server startedAt), so just-edited and just-launched both float up. Filter matches name + path.
  rows(): BulbRow[] {
    const byKey = new Map<string, BulbRow>()
    for (const f of this.files) {
      byKey.set(pathKey(f.path), { path: f.path, name: f.name, recent: f.mtime, trusted: f.trusted })
    }
    for (const s of this.servers) {
      if (s.pid === this.parent.ownPid) continue
      const k = pathKey(s.file)
      const base = bulbBasename(s.file) || s.file
      const row = byKey.get(k) ?? { path: s.file, name: base, recent: 0 }
      row.running = s
      row.recent = Math.max(row.recent, s.startedAt)
      byKey.set(k, row)
    }
    const q = this.filter.trim().toLowerCase()
    let rows = [...byKey.values()]
    if (q) rows = rows.filter(r => r.name.toLowerCase().includes(q) || r.path.toLowerCase().includes(q))
    return rows.sort((a, b) => b.recent - a.recent)
  }

  show() {
    this.beginOpen()
    this.highlighted = 0
    this.refresh()
    this.update()
    this.armClose()
    this.focusFilter()
  }

  protected override onClosed() {
    super.onClosed()
    this.closeLog()
  }

  // Launch a stopped bulb — but PROBE TRUST FIRST so the offer precedes the tab. A
  // remembered-trusted bulb (its tier already decided) and a bulb the scan reads as benign both
  // launch straight away; only a fresh bulb the scan flags raises the pre-launch modal, and the
  // spawn waits for the user's tier choice. (A scan miss still falls through to the runtime gate's
  // reactive modal — see pendingDenial.)
  async launch(path: string) {
    const trusted = this.files.find(f => pathKey(f.path) === pathKey(path))?.trusted
    if (!trusted) {
      let cap: string | undefined
      try { cap = (await tb.server.predictTrustOf(path) as { cap?: string }).cap }
      catch (err) { console.error('[mirror] predictTrustOf failed', err) }
      if (cap) { this.pendingLaunch = { path, name: this.displayName(path), cap }; this.update(); return }
    }
    await this.doLaunch(path)
  }

  // The actual spawn. `trust` true → launch trusted + remember it (the pre-launch "Launch Trusted"
  // choice, parallel to elevate); omitted → the server resolves the remembered tier itself.
  // `suppressNag` records the new pid as already-dismissed so a deliberate Restricted launch isn't
  // re-prompted the instant it trips the gate (elevate later via the row's trust toggle).
  async doLaunch(path: string, trust?: boolean, suppressNag = false) {
    // Mark launching so the play button stays visible + shimmers for the ~2s until the server
    // registers (else the click feels dead). Transient, in-memory; cleared when refresh flips the
    // row to running (which renders a stop button instead).
    const key = pathKey(path)
    this.launching.add(key); this.update()
    let pid: number | undefined
    try { pid = (await tb.server.launchBulb(path, trust) as { pid?: number }).pid }
    catch (err) { console.error('[mirror] launchBulb failed', err) }
    finally { this.launching.delete(key) }
    if (suppressNag && pid) this.dismissedDenials.add(pid)
    await this.refresh()
  }

  // Bulb's frontmatter name when known (nicer than the filename), else the basename sans extension.
  displayName(path: string): string {
    const f = this.files.find(x => pathKey(x.path) === pathKey(path))
    return f?.name || bulbBasename(path) || path
  }

  // Pre-launch modal actions.
  launchTrusted() { const p = this.pendingLaunch; this.pendingLaunch = undefined; if (p) this.doLaunch(p.path, true) }
  launchRestricted() { const p = this.pendingLaunch; this.pendingLaunch = undefined; if (p) this.doLaunch(p.path, undefined, true) }
  cancelLaunch() { this.pendingLaunch = undefined; this.update() }

  async stop(pid: number) {
    if (this.openLog?.pid === pid) this.closeLog()
    this.dismissedDenials.delete(pid)
    try { await tb.server.stopBreakout(pid) }
    catch (err) { console.error('[mirror] stopBreakout failed', err) }
    await this.refresh()
  }

  // A running untrusted bulb that actually tripped the gate (`denied`), awaiting an elevation
  // decision. This is the REACTIVE path — the proactive offer happens before launch (see launch()),
  // so here `denied` is either a deliberate-Restricted bulb the user let trip, or a scan MISS (the
  // bulb reached a capability its source didn't visibly use — the suspicious case, flagged in the
  // modal via `denied` without `predicted`). Surfaced even when the popover is closed; skips ones
  // the user already dismissed (by pid).
  pendingDenial(): RunningServer | undefined {
    return this.servers.find(s => s.denied && s.pid !== this.parent.ownPid && !this.dismissedDenials.has(s.pid))
  }

  // Elevate: stop the untrusted server, relaunch it trusted (explicit trust → the host
  // remembers it). Trust is fixed at process start, so this is a restart, not an in-place flip.
  async elevate(s: RunningServer) {
    this.dismissedDenials.add(s.pid)
    if (this.openLog?.pid === s.pid) this.closeLog()
    try {
      await tb.server.stopBreakout(s.pid)
      await tb.server.launchBulb(s.file, true)
    } catch (err) { console.error('[mirror] elevate failed', err) }
    await this.refresh()
  }

  dismissDenial(pid: number) { this.dismissedDenials.add(pid); this.update() }

  // Flip a bulb's trust tier. Always updates the remembered decision; for a running server the
  // tier is fixed at process start, so apply it now by stopping and relaunching in the new tier
  // (so the toggle reflects reality rather than only the next launch).
  async toggleTrust(r: BulbRow) {
    const next = !(r.running ? !!r.running.trust : !!r.trusted)
    try {
      await tb.server.setBulbTrust(r.path, next)
      if (r.running) {
        if (this.openLog?.pid === r.running.pid) this.closeLog()
        await tb.server.stopBreakout(r.running.pid)
        await tb.server.launchBulb(r.path, next)
      }
    } catch (err) { console.error('[mirror] toggleTrust failed', err) }
    await this.refresh()
  }

  // Tail a running server's console: poll readBulbLog from a byte offset and append, the
  // same drain pattern as the transcript. Display is capped to recent output so a chatty
  // server doesn't bloat the DOM. One log open at a time.
  showLog(s: RunningServer, name: string) {
    if (this.openLog?.pid === s.pid) { this.closeLog(); return }
    this.closeLog()
    this.openLog = { pid: s.pid, name, text: '', offset: 0 }
    this.update()
    setTimeout(() => document.getElementById('bulb-console')?.focus())   // so Esc returns to the list
    this.#pollLog()
    this.#logTimer = setInterval(() => this.#pollLog(), 700)
  }
  closeLog() {
    if (this.#logTimer) { clearInterval(this.#logTimer); this.#logTimer = undefined }
    if (!this.openLog) return
    this.openLog = undefined
    this.update()
  }
  async #pollLog() {
    const log = this.openLog
    if (!log) return
    try {
      const { text, offset } = await tb.server.readBulbLog(log.pid, log.offset) as { text: string; offset: number }
      if (this.openLog !== log) return                 // closed/switched mid-await
      if (text) {
        log.text = (log.text + text).slice(-50_000)    // keep the recent tail
        log.offset = offset
        this.update()
      } else if (offset !== log.offset) {
        log.offset = offset                            // file trimmed/rotated — resync silently
      }
    } catch (err) {
      console.error('[mirror] readBulbLog failed', err)
    }
  }

  view() {
    const running = this.servers.filter(s => s.pid !== this.parent.ownPid).length
    const launchable = this.files.length > 0   // self + byte-identical copies already dropped in listBulbFiles
    if (!launchable && running === 0) return div({ class: 'servers-wrap' })   // nothing to do → no chip
    const label = running > 0 ? `${running} running` : 'bulbs'
    const denial = this.pendingDenial()
    return div({ class: 'servers-wrap' },
      button({
        class: 'pill',
        title: 'Launch a project bulb · stop a running one',
        onClick: (e: MouseEvent) => { e.stopPropagation(); this.open ? this.close() : this.show() },
      }, label),
      this.open ? this.popup() : null,
      // Pre-launch offer (proactive) wins the slot if present — it's the one blocking a launch;
      // the reactive denial modal handles an already-running bulb that tripped the gate.
      this.pendingLaunch ? this.launchModal(this.pendingLaunch) : denial ? this.denialModal(denial) : null,
    )
  }

  // Shared modal chrome for both trust prompts (TB-Trust.md). It lives here, in the
  // launcher — a surface the launched bulb's page can't script — so a bulb can trigger a prompt but
  // never self-grant (Trust spec Invariant 3). Backdrop click runs onDismiss.
  trustModal(cfg: { heading: string; body: string; warn: string; noLabel: string; yesLabel: string; onNo: () => void; onYes: () => void; onDismiss: () => void }) {
    return div({ class: 'trust-back', onClick: (e: MouseEvent) => { e.stopPropagation(); cfg.onDismiss() } },
      div({ class: 'trust-modal', onClick: (e: MouseEvent) => e.stopPropagation() },
        div({ class: 'trust-modal-h' }, cfg.heading),
        div({ class: 'trust-modal-b' }, cfg.body),
        div({ class: 'trust-modal-warn' }, cfg.warn),
        div({ class: 'trust-modal-acts' },
          button({ class: 'trust-no', onClick: (e: MouseEvent) => { e.stopPropagation(); cfg.onNo() } }, cfg.noLabel),
          button({ class: 'trust-yes', onClick: (e: MouseEvent) => { e.stopPropagation(); cfg.onYes() } }, cfg.yesLabel),
        ),
      ),
    )
  }

  // Proactive (pre-launch): the scan thinks this bulb needs a capability; choose its tier before it
  // opens. "Launch Restricted" still launches — the user may want the sandboxed run — just without
  // trust, and without an instant re-nag when it trips (doLaunch suppressNag).
  launchModal(p: { path: string; name: string; cap: string }) {
    return this.trustModal({
      heading: `“${p.name}” will likely need access`,
      body: `It looks like it uses ${p.cap}, which is blocked unless you launch it Trusted. Launch Trusted to allow filesystem / AI / server.ts?`,
      warn: 'Only trust bulbs you wrote or have read — be careful with anything off the internet.',
      noLabel: 'Launch restricted',
      yesLabel: 'Launch trusted',
      onNo: () => this.launchRestricted(),
      onYes: () => this.launchTrusted(),
      onDismiss: () => this.cancelLaunch(),
    })
  }

  // Reactive (post-launch): a running bulb tripped the gate. With the proactive offer now made
  // before launch, this fires for a deliberate-Restricted bulb the user let trip, or — the
  // interesting case — a scan MISS: a bulb that reached a capability its source never visibly used
  // (`denied` without `predicted`), which is exactly what dynamic access / a raw fetch('/__fs')
  // looks like, so it's headlined and warned harder. "Trust & relaunch" remembers the decision.
  denialModal(s: RunningServer) {
    const name = bulbBasename(s.file) || s.file
    const suspicious = !s.predicted
    return this.trustModal({
      heading: suspicious ? `“${name}” reached for access it didn't declare` : `“${name}” wants more access`,
      body: suspicious
        ? `It tried to use ${s.denied} at runtime, though nothing in its code obviously needed it. Relaunch it Trusted to allow filesystem / AI / server.ts?`
        : `It tried to use ${s.denied}, blocked while it's restricted. Relaunch it Trusted to allow filesystem / AI / server.ts?`,
      warn: suspicious
        ? 'Code that reaches for capabilities it never visibly uses can be hiding something — only continue if you wrote this bulb or have read it.'
        : 'Only trust bulbs you wrote or have read — be careful with anything off the internet.',
      noLabel: 'Keep restricted',
      yesLabel: 'Trust & relaunch',
      onNo: () => this.dismissDenial(s.pid),
      onYes: () => this.elevate(s),
      onDismiss: () => this.dismissDenial(s.pid),
    })
  }

  popup() {
    // Drill-in: a running row's `logs` button flips the whole popover to that server's
    // console; ← back flips home. The launcher list and a streaming console are different
    // surfaces — one narrow and transient, one tall and kept open while you poke the bulb —
    // so they take turns in the popover rather than the console hiding below a scrolling list.
    if (this.openLog) return this.consoleView(this.openLog)
    const rows = this.rows()
    return div({ class: 'servers-pop' },
      // Nav keys move the highlight; any other key edits the filter, which refilters the list — so
      // restart the highlight at the top (applied on the input event's re-render, no extra update).
      searchFilter({
        target: this,
        prop: () => this.filter,
        id: 'bulb-filter',
        placeholder: 'Filter bulbs…',
        hasValue: !!this.filter,
        onKeyDown: (e: KeyboardEvent) => this.onFilterKey(e),
        onClear: () => this.clearFilter(),
      }),
      rows.length === 0
        ? div({ class: 'picker-empty' }, this.filter ? 'No match.' : 'No bulbs in this project yet.')
        : div({ class: 'bulb-list' }, rows.map((r, i) => this.row(r, i))),
    )
  }

  // The drilled-in console for one running server: takes over the whole popover (wider +
  // taller than the list — a console wants room) with a back affordance to the list.
  // Esc or the ← button returns; closeLog stops the tail.
  consoleView(log: { name: string; text: string }) {
    return div({ id: 'bulb-console', class: 'servers-pop log-mode', tabIndex: 0,
        onKeyDown: (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); this.closeLog() } } },
      // Header content is right-aligned, back button rightmost.
      div({ class: 'bulb-log-head' },
        span({ class: 'bulb-log-name' }, `console · ${log.name}`),
        button({ class: 'bulb-log-back', title: 'Back to the bulb list', onClick: (e: MouseEvent) => { e.stopPropagation(); this.closeLog() } }, '← bulbs'),
      ),
      // Top-anchored: output reads from the first line down (a short log sits at the top,
      // not floated to the bottom of the tall box).
      pre({ class: 'bulb-log-body' }, span({ class: 'bulb-log-text' }, log.text || '(no output yet)')),
    )
  }

  row(r: BulbRow, i: number) {
    const s = r.running
    const showing = s && this.openLog?.pid === s.pid
    // Running tier is authoritative; otherwise the remembered decision the next launch uses.
    const trusted = s ? !!s.trust : !!r.trusted
    // Layout: the action button + name read together on the LEFT (▶/■ Title); the metadata/controls
    // form a right-aligned cluster of fixed-width columns (trust · logs · time/port) that line up
    // row-to-row. Right-anchored, so the rightmost column (time/port) always aligns; the others
    // stack inward from it.
    return div({ class: ['server-row', i === this.highlighted ? 'active' : ''],
        onMouseEnter: () => { if (this.highlighted !== i) { this.highlighted = i; this.update() } } },
      s
        ? button({ class: 'server-stop', title: 'Stop this server', ariaLabel: 'Stop', onClick: (e: MouseEvent) => { e.stopPropagation(); this.stop(s.pid) } }, iconStop())
        : button({ class: ['bulb-launch', this.launching.has(pathKey(r.path)) ? 'launching' : ''], title: trusted ? 'Launch (trusted — remembered)' : 'Launch (restricted)', ariaLabel: 'Launch', onClick: (e: MouseEvent) => { e.stopPropagation(); this.launch(r.path) } }, iconPlay()),
      // The name opens the bulb's .bulb.md in the editor (running or stopped). The live app is
      // reachable separately via the :port link; the play button launches. Not a launch trigger.
      span({ class: ['server-name', s ? '' : 'stopped'], title: `Open ${r.path}`, onClick: (e: MouseEvent) => { e.stopPropagation(); tb.server.openFile(r.path) } }, r.name),
      // Trust toggle. Shown for a running server (the live tier matters) or a trusted-remembered
      // stopped bulb; a plain restricted stopped bulb shows an empty cell — "restricted" is the
      // implicit default and repeating it down every row is noise — but the cell still holds its grid
      // column, so the trust/logs/time columns stay aligned row-to-row.
      (s || trusted) ? this.trustToggle(r, trusted) : span({ class: 'cell-empty' }),
      // Logs: a link (not a button) that flips the popover to this server's console.
      s
        ? a({ class: ['server-logs', showing ? 'on' : ''], title: 'Show this server’s console', onClick: (e: MouseEvent) => { e.stopPropagation(); this.showLog(s, r.name) } }, 'logs')
        : span({ class: 'cell-empty' }),
      s
        ? a({ class: 'server-port', href: s.url, target: '_blank', rel: 'noopener noreferrer', title: `Open ${s.url}` }, `:${s.port}`)
        : span({ class: 'bulb-time' }, relTime(r.recent)),
    )
  }

  // Trust toggle: one button showing the *current* tier (one word; clicking flips it). Shares the
  // row-button style — accent when trusted (an active control), muted when restricted. For a running
  // server the flip is a stop + relaunch (toggleTrust).
  trustToggle(r: BulbRow, trusted: boolean) {
    return button({
      class: ['trust-toggle', trusted ? 'on' : ''],
      title: `${trusted ? 'Trusted' : 'Restricted'} — click to switch to ${trusted ? 'restricted' : 'trusted'}` + (r.running ? ' (stops + relaunches it)' : ''),
      onClick: (e: MouseEvent) => { e.stopPropagation(); this.toggleTrust(r) },
    }, trusted ? 'trusted' : 'restricted')
  }
}
