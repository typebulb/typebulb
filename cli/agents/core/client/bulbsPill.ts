import { div, span, a, button, pre } from 'domeleon'
import { ComboboxPill } from './statusPill.js'
import { icon } from './icons.js'
import { hitsBadge, snippetLine } from './ui.js'
import { pathKey, basename, bulbBasename, parseBulbUrlText, relTime } from './util.js'
import type { RunningServer, BulbFile, BulbRow, BulbHit, RemoteBulb } from './types.js'

// Launch/stop icons through icons.ts (material play/stop, filled): svgs centre reliably where
// font glyphs don't, and currentColor lets the button's own colour flow through.
const iconPlay = () => icon('play', 'btn-icon')
const iconStop = () => icon('stop', 'btn-icon')

// typebulbs/u/<user>/ mirrors the site's /u/<user>/ URL shape, so the folder names the owner
// (TB-Agent-Mirror.md; full story: server launcher.ts samples section). A remote row's path is
// samplePath (already pathKey-shaped), so the same derivations cover remote and downloaded rows.
const samplePath = (slug: string) => `typebulbs/u/samples/${slug}.bulb.md`
const rowUser = (r: BulbRow): string | undefined => pathKey(r.path).match(/typebulbs\/u\/([^/]+)\//)?.[1]
const rowUserUrl = (r: BulbRow, user: string) => `https://typebulb.com/u/${user}/${bulbBasename(r.path)}/full`

// pullTo's terse RPC errors, given the CLI's own wording (runPull) where the raw form is cryptic.
const friendlyPullError = (e?: string): string =>
  e === 'HTTP 404' ? 'not found — check the URL (private bulbs need their owner\'s token)'
  : e === 'HTTP 401' || e === 'HTTP 403' ? 'private — needs its owner\'s TYPEBULB_TOKEN in .env'
  : e || 'pull failed'

// Status-bar bulb launcher + off-switch. Lists every *.bulb.md in the project (MRU-first,
// type to filter) so a bulb you just authored is one click from running — no trip to the
// terminal — and overlays the cross-project running-server registry so the same menu
// stops them. A broken-out/launched server is detached and outlives this page (surviving
// every hot-reload), so without this the only way to stop one is the OS. The bulb drives
// nothing except launching (Invariant 2) — the same deliberate exception as breakout.
//
// The host's own file (the mirror you're looking through) is dropped — no relaunching
// yourself — identified by *pid*, not filename, so it survives a rename and doesn't hide a
// second, unrelated mirror. Polls on a lazy cadence: the set changes on a launch / stop /
// breakout / edit, not per-frame.
export class BulbsPill extends ComboboxPill<BulbHit> {
  files: BulbFile[] = []
  servers: RunningServer[] = []
  samples: RemoteBulb[] = []
  // The token user's own typebulb.com bulbs (listMyBulbs) + who they are. Empty/undefined without
  // a TYPEBULB_TOKEN in the project .env — the push/pull surface simply doesn't exist then.
  mine: RemoteBulb[] = []
  myUser?: string
  protected keepOpenSelector = '.servers-wrap'
  protected filterId = 'bulb-filter'
  protected listSelector = '.bulb-list'
  protected filterNoun = 'name'
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
  // The just-broken-out server's pid — its launcher row stays bright while the rest dim (see spotlight()).
  spotlightPid?: number
  // Expanded remote folds, keyed by owner slug ('samples', the token user) — per-open view state
  // like filter/highlight, reset in onClosed, never persisted (TB-Agent-Mirror.md).
  openFolds = new Set<string>()
  // A push/pull that hit the conflict guard, awaiting the one-gesture overwrite confirm
  // (TB-Push-Pull.md, Mirror surface): yes retries with force.
  pendingOverwrite?: { heading: string; body: string; yesLabel: string; onYes: () => void }
  // A remote pull's visible failure, keyed by pathKey — a pasted URL fails far more often than a
  // catalog row (typo, private bulb), so console-only won't do. Cleared on retry and on close.
  pullErrors = new Map<string, string>()
  // In-flight / just-landed sync verbs, keyed `${pathKey}:${verb}` — transient, in-memory: the
  // shimmer while the PUT/GET runs, a ~1s ✓ on success. The click's heartbeat; success stays
  // otherwise silent (Mirror surface).
  syncBusy = new Set<string>()
  syncDone = new Set<string>()
  // The stopped-row scope picker's explicit choices, keyed by pathKey ('' = unscoped) — per-open
  // view state like openFolds, reset in onClosed, never persisted: the default snaps back to the
  // newest batch on the next open, which tracks the agent's latest work (TB-Batch.md Invariant 7).
  batchSel = new Map<string, string>()
  // Which row's batch menu is open (pathKey) + fixed-position coords measured from its B at click
  // time — position:fixed escapes the scrolling list's overflow clip without the list-edge
  // anchoring the hover-peek card needs. Transient view state, reset on close.
  batchMenu?: { key: string; left: number; bottom: number }

  protected search(query: string) { return tb.server.searchBulbs(query) as Promise<BulbHit[]> }
  // Enter on the highlighted row: open a running server's tab, or launch a stopped bulb.
  protected onActivate(i: number) {
    const r = this.rows()[i]
    if (!r) return
    if (r.group) this.toggleFold(r.group.user)
    else if (r.running) window.open(r.running.url, '_blank', 'noopener')
    else if (r.remote) this.downloadAndLaunch(r)
    else this.launch(r.path)
  }

  override onAttached() {
    this.refresh()
    // The running registry is cheap (reads one dir) and carries the time-critical signal —
    // a denial flag that must raise the elevation modal promptly — so poll it fast. The file
    // walk is heavier (recursive project scan) and only changes on author/launch, so it stays
    // lazy. Splitting them keeps the modal near-instant without re-walking the tree every tick.
    setInterval(() => this.refreshServers(), 800)
    setInterval(() => this.refreshFiles(), 3000)
    // breakout self-registers its new server, then fires this with its pid.
    window.addEventListener('tb-breakout', (e) => this.spotlight((e as CustomEvent<{ pid?: number }>).detail?.pid))
  }

  // Open the launcher with the new bulb's row bright and the rest dimmed — mirror-launched bulbs are
  // windowless (TB-Agent-Mirror.md), so its green :port link is the user's next click. show() is the
  // pill-click path (refresh, pin newest into view, arm the closer); the dim lifts on close or row-hover.
  spotlight(pid?: number) { this.spotlightPid = pid; this.show() }

  refresh() { return Promise.all([this.refreshServers(), this.refreshFiles(), this.refreshSamples(), this.refreshMine()]) }

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
      if (changed) { this.update(); this.keepBottom() }
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
        files.some((f, i) => f.path !== this.files[i]?.path || f.mtime !== this.files[i]?.mtime || f.lastRunAt !== this.files[i]?.lastRunAt)
      this.files = files
      if (changed) { this.update(); this.keepBottom() }
    } catch (err) {
      console.error('[mirror] bulb list refresh failed', err)
    }
  }

  // typebulb.com's curated sample catalog (server-cached 1h; offline → empty). No interval of its
  // own: the set changes on the site's cadence, not the project's — refresh() re-asks on attach
  // and each menu open.
  async refreshSamples() {
    try {
      const samples = await tb.server.listSamples() as RemoteBulb[]
      const changed = samples.length !== this.samples.length || samples.some((s, i) => s.slug !== this.samples[i]?.slug)
      this.samples = samples
      if (changed) { this.update(); this.keepBottom() }
    } catch (err) {
      console.error('[mirror] samples refresh failed', err)
    }
  }

  // The token user's own bulbs (server-cached 5min; no token / offline → empty). Same cadence
  // as samples: refresh() re-asks on attach and each menu open.
  async refreshMine() {
    try {
      const { user, bulbs } = await tb.server.listMyBulbs() as { user?: string; bulbs: RemoteBulb[] }
      const changed = user !== this.myUser || bulbs.length !== this.mine.length || bulbs.some((b, i) => b.slug !== this.mine[i]?.slug)
      this.myUser = user
      this.mine = bulbs
      if (changed) { this.update(); this.keepBottom() }
    } catch (err) {
      console.error('[mirror] my-bulbs refresh failed', err)
    }
  }

  // Project files ∪ running servers, keyed by path. The host's own file (and byte-identical copies)
  // are already dropped server-side in listBulbFiles; its own running server is dropped here by pid.
  // A running server outside the project still shows so the off-switch stays unified. MRU = max(last
  // edit, last run, live server startedAt) — the run half persists past the stop, so a bulb you drove
  // all afternoon holds its place instead of teleporting back to wherever its last edit put it.
  merged(): BulbRow[] {
    const byKey = new Map<string, BulbRow>()
    const fileKeys = this.files.map(f => pathKey(f.path))
    // Remote bulbs (samples catalog + the token user's own) with no local file yet: recent 0 sorts
    // them to the far end, away from the newest-at-bottom anchor. Once pulled, the local file's row
    // takes over (suffix match — file paths are absolute, a remote's path is project-relative) and
    // the remote row vanishes. The owner rides in the path (Invariant 4), so one loop serves both.
    const remotes: [string, RemoteBulb][] = [
      ...this.samples.map(s => [samplePath(s.slug), s] as [string, RemoteBulb]),
      ...(this.myUser ? this.mine.map(b => [`typebulbs/u/${this.myUser}/${b.slug}.bulb.md`, b] as [string, RemoteBulb]) : []),
    ]
    for (const [rel, smp] of remotes) {
      if (!fileKeys.some(k => k.endsWith('/' + rel))) {
        byKey.set(rel, { path: rel, name: smp.name, recent: 0, remote: smp })
      }
    }
    this.files.forEach((f, i) => {
      byKey.set(fileKeys[i], { path: f.path, name: f.name, recent: Math.max(f.mtime, f.lastRunAt ?? 0), trusted: f.trusted, batches: f.batches })
    })
    for (const s of this.servers) {
      if (s.pid === this.parent.ownPid) continue
      const k = pathKey(s.file)
      const base = bulbBasename(s.file) || s.file
      const row = byKey.get(k) ?? { path: s.file, name: base, recent: 0 }
      row.running = s
      row.recent = Math.max(row.recent, s.startedAt)
      byKey.set(k, row)
    }
    return [...byKey.values()]
  }

  // Display order is newest-at-bottom, so just-edited and just-launched both sit adjacent to the
  // filter input at the anchored edge. The default filter matches name + path; full-text mode keeps
  // only the rows the server search hit, decorated with hit count + snippet — unlike the session
  // picker's results-only list, a search row here stays an ordinary row (launch/stop/trust intact),
  // just fewer of them. With no query, the catalog folds into one group row at the far end
  // (recent -1 sorts it past the samples' 0) — collapsed by default; a typed filter reaches into
  // the fold since remote rows match like any other, so find-by-name works without expanding.
  rows(): BulbRow[] {
    let rows = this.merged()
    if (this.searchActive) {
      const hits = new Map(this.results.map(h => [pathKey(h.path), h]))
      rows = rows.flatMap(r => {
        const h = hits.get(pathKey(r.path))
        return h ? [{ ...r, hitCount: h.hitCount, snippet: h.snippet }] : []
      })
    } else {
      const q = this.filter.trim().toLowerCase()
      // A pasted bulb URL narrows to that identity's one row (TB-Push-Pull.md, Mirror surface): the
      // project's existing row when it has one — local file, sample, or listed-mine; play/pull work
      // as ever — else a synthetic remote row whose play pulls it in (the owner rides in the path,
      // so the ordinary downloadAndLaunch route covers it). The pasted origin is ignored: the path
      // shape is the identity, and the pull speaks the project's own TYPEBULB_ORIGIN.
      const url = parseBulbUrlText(this.filter)
      if (url) {
        const rel = `typebulbs/u/${url.user}/${url.slug}.bulb.md`
        const existing = rows.find(r => ('/' + pathKey(r.path)).endsWith('/' + rel))
        return existing ? [existing] : [{
          path: rel, name: url.slug, recent: 0,
          remote: { slug: url.slug, name: url.slug, description: `u/${url.user}/${url.slug} on typebulb.com — play pulls it into the project` },
        }]
      }
      if (q) rows = rows.filter(r => r.name.toLowerCase().includes(q) || r.path.toLowerCase().includes(q))
      else {
        // One fold per remote owner slug (the typebulbs/u/<slug> partition); ownership rides in
        // the row's path (rowUser). 'samples' and the token user are today's two instances.
        // An open fold's items re-anchor just past their own header (-.5 - i), so they always sit
        // directly under it — the contiguous shaded band depends on that adjacency.
        const owners = [...new Set(rows.filter(r => r.remote).map(r => rowUser(r)!))]
        owners.forEach((user, i) => {
          const inFold = (r: BulbRow) => !!r.remote && rowUser(r) === user
          const count = rows.filter(inFold).length
          if (!this.openFolds.has(user)) rows = rows.filter(r => !inFold(r))
          else rows = rows.map(r => inFold(r) ? { ...r, recent: -0.5 - i } : r)
          rows.push({ path: `::${user}`, name: this.foldLabel(user), recent: -1 - i, group: { user, count } })
        })
      }
    }
    return rows.sort((a, b) => a.recent - b.recent)
  }

  show() {
    this.beginOpen()
    this.refresh()
    this.refreshList()
    this.armClose()
    this.focusFilter()
  }

  protected override onClosed() {
    super.onClosed()
    this.closeLog()
    this.openFolds.clear()
    this.pendingOverwrite = undefined
    this.pullErrors.clear()
    this.batchSel.clear()
    this.batchMenu = undefined
    this.spotlightPid = undefined   // close() re-renders right after, so no extra update needed
  }

  // Expand/collapse a fold in place. No pinToBottom: the fold sits at the list's top edge, so
  // the user toggling it is looking there — yanking to the bottom would hide what they just opened.
  toggleFold(user: string) {
    if (!this.openFolds.delete(user)) this.openFolds.add(user)
    this.update()
  }

  // The fold header's texts. Every owner reads the same — "antypica's bulbs" names the account
  // where "Your typebulb.com bulbs" only named the relationship; the title below still says which
  // one is yours, and carries the "on typebulb.com" origin the label drops.
  foldLabel(user: string): string {
    return user === 'samples' ? 'Samples from typebulb.com' : `${user}'s bulbs`
  }
  foldTitle(user: string): string {
    return user === 'samples'
      ? 'Runnable sample bulbs from typebulb.com — click to browse'
      : `${user === this.myUser ? 'Your' : `${user}'s`} bulbs on typebulb.com — click to browse; play pulls one into the project`
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

  // Play on a remote catalog row: pull the bulb into typebulbs/u/<owner>/, then run the
  // ordinary launch flow (trust scan included) on the new local file. Samples keep their
  // unconditional-overwrite semantics (downloadSample); the user's own bulbs go through the
  // conflict-guarded pull (no local file exists for a remote row, so no conflict in practice).
  // The remote row's rel path keys the shimmer; refreshFiles swaps the row to the local
  // absolute-path file, so re-find it by suffix before launching to keep the shimmer + trust
  // modal on the row actually displayed.
  async downloadAndLaunch(r: BulbRow) {
    const key = pathKey(r.path)
    this.launching.add(key); this.pullErrors.delete(key); this.update()
    try {
      const user = rowUser(r)
      const res = (user === 'samples'
        ? await tb.server.downloadSample(r.remote!.slug)
        : await tb.server.pullRemoteBulb(user, r.remote!.slug)) as { ok: boolean; file?: string; error?: string }
      if (!res.ok || !res.file) {
        console.error('[mirror] remote pull failed', res.error)
        this.pullErrors.set(key, friendlyPullError(res.error))
        return
      }
      await this.refreshFiles()
      const local = this.files.find(f => pathKey(f.path).endsWith('/' + pathKey(res.file!)))?.path ?? res.file
      await this.launch(local)
    } catch (err) {
      console.error('[mirror] remote pull failed', err)
      this.pullErrors.set(key, friendlyPullError((err as Error)?.message))
    } finally {
      this.launching.delete(key); this.update()
    }
  }

  // ---- push/pull verbs on local rows (TB-Push-Pull.md, Mirror surface) ----
  // Pull is valid wherever a remote exists (any u/<owner>/ row); push where the row is the token
  // user's and a local file exists. A conflict raises the one-gesture overwrite confirm; its yes
  // retries with force. Success is silent — the row/list is the confirmation.

  // One verb's full protocol: shimmer while the RPC runs, the overwrite confirm on a conflict
  // (yes = retry with force), a ✓ beat on success, console on failure. The two verbs differ only
  // in the RPC and which side the confirm offers to overwrite.
  async syncRow(r: BulbRow, verb: 'pull' | 'push', force = false) {
    const key = `${pathKey(r.path)}:${verb}`
    this.syncBusy.add(key); this.update()
    try {
      const res = (verb === 'pull'
        ? await tb.server.pullRemoteBulb(rowUser(r)!, bulbBasename(r.path), force)
        : await tb.server.pushLocalBulb(r.path, force)) as { ok: boolean; conflict?: boolean; error?: string }
      if (res.ok) this.tickDone(key)
      else if (res.conflict) {
        this.pendingOverwrite = {
          ...(verb === 'pull'
            ? { heading: `“${r.name}” has local changes`,
                body: `Your local file differs from the typebulb.com copy. Overwrite the local file with the site's version?`,
                yesLabel: 'Overwrite local' }
            : { heading: `The site copy of “${r.name}” changed`,
                body: `It changed since your last sync. Overwrite the typebulb.com copy with your local file?`,
                yesLabel: 'Overwrite site copy' }),
          onYes: () => this.syncRow(r, verb, true),
        }
      } else console.error(`[mirror] ${verb} failed`, res.error)
    } catch (err) {
      console.error(`[mirror] ${verb} failed`, err)
    } finally {
      this.syncBusy.delete(key)
    }
    // Pull changes local files; push changes the remote listing's world (e.g. a create).
    await (verb === 'pull' ? this.refreshFiles() : this.refreshMine())
    this.update()
  }

  // The success tick: ✓ for a beat, then back to the arrow. Purely visual, never persisted.
  tickDone(key: string) {
    this.syncDone.add(key)
    setTimeout(() => { this.syncDone.delete(key); this.update() }, 1200)
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
    try { pid = (await tb.server.launchBulb(path, trust, this.launchBatch(key)) as { pid?: number }).pid }
    catch (err) { console.error('[mirror] launchBulb failed', err) }
    finally { this.launching.delete(key) }
    if (suppressNag && pid) this.dismissedDenials.add(pid)
    await this.refresh()
    // A launch is a deliberate foreground action: the now-running row jumped to the bottom (newest),
    // so force the list there to reveal it + its green :port. Unlike keepBottom (a background refresh
    // only holds the bottom if already resting there), this pins regardless of current scroll.
    this.pinToBottom()
  }

  // Whether any current row carries a scope — the gate on the scope column below. A batch-less
  // project renders no column at all (the 6-track template), keeping today's layout exactly.
  get anyScope(): boolean {
    return this.servers.some(x => x.batch) || this.files.some(f => f.batches?.length)
  }

  // The scope column: one B chip in its own subgrid track (styles.css .bulb-list.has-scope) — the
  // row shows THAT a scope applies; the tooltip and click-menu name it (TB-Batch.md Invariant 7).
  // States: absent (no batches / running unscoped), dim (launch will be unscoped), lit (play
  // launches scoped — the newest-batch default — or running scoped). Every row must emit this
  // cell (spacer included) whenever the has-scope template is active, or auto-placement shifts
  // the row's remaining cells left a track.
  scopeCell(r: BulbRow, s?: RunningServer) {
    if (!this.anyScope) return null
    if (s) {
      // A running row's scope is a fact, not a control (changing it is a relaunch — TB-Batch.md
      // Invariant 5), so the lit B is static; the tooltip names the batch.
      return s.batch
        ? span({ class: 'batch-b on static bulb-scope', title: `Running with --batch ${s.batch} — its files land in batches/${s.batch} inside the bulb's folder` }, 'B')
        : span({ class: 'bulb-scope' })
    }
    if (r.remote || !r.batches?.length) return span({ class: 'bulb-scope' })
    const key = pathKey(r.path)
    const active = this.launchBatch(key)
    return span({ class: 'bulb-scope' },
      button({
        class: ['batch-b', active ? 'on' : ''],
        title: active ? `Play launches --batch ${active} — click to change` : 'Play launches unscoped — click to pick a batch',
        ariaLabel: 'Batch scope',
        onClick: (e: MouseEvent) => this.openBatchMenu(r, e),
      }, 'B'),
      this.batchMenu?.key === key ? this.batchMenuPop(r, key, active) : null,
    )
  }

  openBatchMenu(r: BulbRow, e: MouseEvent) {
    e.stopPropagation()
    const key = pathKey(r.path)
    if (this.batchMenu?.key === key) { this.closeBatchMenu(); return }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    this.batchMenu = { key, left: rect.left, bottom: window.innerHeight - rect.top + 4 }
    this.update()
  }

  closeBatchMenu() { this.batchMenu = undefined; this.update() }

  // The B's menu rides the composer's popup register (.dlg-catcher + .at-popup/.at-row — one
  // mini-menu UI across the mirror, not another bespoke one): the catcher dismisses on outside
  // mousedown, rows pick on mousedown so the choice can't be blurred away, the effective choice
  // wears .active. Only the positioning is local — fixed coords measured from the B — because a
  // container-anchored absolute popup can't ride a row in a scrolling list.
  batchMenuPop(r: BulbRow, key: string, active?: string) {
    const m = this.batchMenu!
    const pick = (v: string) => (e: MouseEvent) => { e.preventDefault(); this.batchSel.set(key, v); this.closeBatchMenu() }
    return [
      div({ class: 'dlg-catcher', onMouseDown: (e: MouseEvent) => { e.preventDefault(); this.closeBatchMenu() } }, ''),
      div({ class: 'at-popup batch-pop', style: { left: `${m.left}px`, bottom: `${m.bottom}px` } },
        r.batches!.map(b => div({ class: ['at-row', b === active ? 'active' : ''], onMouseDown: pick(b) }, b)),
        div({ class: ['at-row', 'unscoped', active ? '' : 'active'], onMouseDown: pick('') }, 'unscoped'),
      ),
    ]
  }

  // The effective scope the row's B shows (TB-Batch.md Invariant 7), resolved again at spawn so
  // the trust-modal flow (launch → tier choice → doLaunch) uses the same scope the row displayed:
  // an explicit pick wins, else the newest batch; '' is the explicit unscoped choice → undefined.
  launchBatch(key: string): string | undefined {
    const batches = this.files.find(f => pathKey(f.path) === key)?.batches
    return (this.batchSel.get(key) ?? batches?.[0]) || undefined
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

  // Elevate: relaunch trusted (explicit trust → the host remembers it). Trust is fixed at
  // process start, so this is a restart, not an in-place flip — and the launch itself stops
  // the running server (one server per bulb file, TB-CLI.md).
  async elevate(s: RunningServer) {
    this.dismissedDenials.add(s.pid)
    if (this.openLog?.pid === s.pid) this.closeLog()
    try { await tb.server.launchBulb(s.file, true) }
    catch (err) { console.error('[mirror] elevate failed', err) }
    await this.refresh()
  }

  dismissDenial(pid: number) { this.dismissedDenials.add(pid); this.update() }

  // Flip a bulb's trust tier. Always updates the remembered decision; for a running server the
  // tier is fixed at process start, so apply it now by relaunching in the new tier — the launch
  // replaces the running server — so the toggle reflects reality rather than only the next launch.
  async toggleTrust(r: BulbRow) {
    const next = !(r.running ? !!r.running.trust : !!r.trusted)
    try {
      await tb.server.setBulbTrust(r.path, next)
      if (r.running) {
        if (this.openLog?.pid === r.running.pid) this.closeLog()
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
    // Remote samples count as launchable, so the chip shows even in a bulb-less project —
    // deliberate (an empty project is where samples help most); offline, the catalog is empty
    // and the old hide-when-idle behavior returns. (files: self + copies already dropped server-side.)
    const launchable = this.files.length > 0 || this.samples.length > 0
    if (!launchable && running === 0) return div({ class: 'servers-wrap' })   // nothing to do → no chip
    const denial = this.pendingDenial()
    return div({ class: 'servers-wrap' },
      // Idle: a square glyph pill (the 💡 alone, grayscale at rest like the prose monkey); with
      // bulbs running the count rides along as a word pill. `on` latches while the menu is open
      // (the diff pill's convention).
      button({
        class: ['pill', running > 0 ? '' : 'glyph', this.open ? 'on' : ''],
        title: 'Launch a project bulb · stop a running one',
        onClick: (e: MouseEvent) => { e.stopPropagation(); this.open ? this.close() : this.show() },
      }, running > 0 ? `${running}💡` : span({ class: 'glyph-img' }, '💡')),
      this.open ? this.popup() : null,
      // Pre-launch offer (proactive) wins the slot if present — it's the one blocking a launch;
      // the reactive denial modal handles an already-running bulb that tripped the gate.
      this.pendingLaunch ? this.launchModal(this.pendingLaunch)
        : this.pendingOverwrite ? this.overwriteModal(this.pendingOverwrite)
        : denial ? this.denialModal(denial) : null,
    )
  }

  // The push/pull conflict confirm (TB-Push-Pull.md, Mirror surface): the CLI's stateless guard
  // given a yes/no face — yes IS --force. Reuses the trust-modal chrome (same interrupt register).
  overwriteModal(p: { heading: string; body: string; yesLabel: string; onYes: () => void }) {
    const clear = () => { this.pendingOverwrite = undefined; this.update() }
    return this.trustModal({
      heading: p.heading,
      body: p.body,
      warn: 'There is no undo — the overwritten side\'s changes are gone.',
      noLabel: 'Cancel',
      yesLabel: p.yesLabel,
      onNo: clear,
      onYes: () => { this.pendingOverwrite = undefined; p.onYes() },
      onDismiss: clear,
    })
  }

  // Shared modal chrome for both trust prompts (TB-Security.md). It lives here, in the
  // launcher — a surface the launched bulb's page can't script — so a bulb can trigger a prompt but
  // never self-grant (Trust spec Invariant 3). Backdrop click and Escape both run onDismiss;
  // focused on mount so Escape lands here without a click first.
  trustModal(cfg: { heading: string; body: string; warn: string; noLabel: string; yesLabel: string; onNo: () => void; onYes: () => void; onDismiss: () => void }) {
    // Every way out of the modal shares one exit protocol: swallow the event, run the action, and
    // return focus to the filter (when the popover is open) — the modal stole focus on mount, and
    // unmounting would drop it on <body>, where the next Esc — which should close the popover —
    // lands on nothing.
    const act = (e: Event, fn: () => void) => { e.stopPropagation(); fn(); if (this.open) this.focusFilter() }
    return div({ class: 'trust-back', tabIndex: 0,
        onMounted: (el: Element) => (el as HTMLElement).focus(),
        onKeyDown: (e: KeyboardEvent) => { if (e.key === 'Escape') act(e, cfg.onDismiss) },
        onClick: (e: MouseEvent) => act(e, cfg.onDismiss) },
      div({ class: 'trust-modal', onClick: (e: MouseEvent) => e.stopPropagation() },
        div({ class: 'trust-modal-h' }, cfg.heading),
        div({ class: 'trust-modal-b' }, cfg.body),
        div({ class: 'trust-modal-warn' }, cfg.warn),
        div({ class: 'trust-modal-acts' },
          button({ class: 'trust-no', onClick: (e: MouseEvent) => act(e, cfg.onNo) }, cfg.noLabel),
          button({ class: 'trust-yes', onClick: (e: MouseEvent) => act(e, cfg.onYes) }, cfg.yesLabel),
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
    // Dim every row but the spotlit one — only once it's present, so the list never flashes all-dimmed.
    const spot = this.spotlightPid
    const dimOthers = spot !== undefined && rows.some(r => r.running?.pid === spot)
    return div({ class: 'servers-pop' },
      rows.length === 0
        ? this.emptyState('No bulbs in this project yet.')
        : div({ class: ['bulb-list', this.anyScope ? 'has-scope' : ''], onScroll: () => this.onListScroll() },
            rows.map((r, i) => this.row(r, i, dimOthers && r.running?.pid !== spot))),
      // Count the project's own bulbs, not the folded catalog — 4 bulbs, not 54. Also the honest
      // full-text figure: searchBulbs's corpus is project files only.
      this.filterBox(this.merged().filter(r => !r.remote).length, 'bulb'),
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

  // Row hover: move the keyboard cursor there; hovering the spotlit (just-broken-out) row also
  // lifts the spotlight dim. Shared by ordinary rows and the fold header.
  hoverRow(i: number, s?: RunningServer) {
    const lift = s !== undefined && s.pid === this.spotlightPid
    if (lift) this.spotlightPid = undefined
    if (this.highlighted !== i || lift) { this.highlighted = i; this.update() }
  }

  row(r: BulbRow, i: number, dimmed = false) {
    if (r.group) return this.groupRow(r, i, dimmed)
    const s = r.running
    const showing = s && this.openLog?.pid === s.pid
    const pullError = this.pullErrors.get(pathKey(r.path))
    // Running tier is authoritative; otherwise the remembered decision the next launch uses.
    const trusted = s ? !!s.trust : !!r.trusted
    // Layout: the action button + name read together on the LEFT (▶/■ Title); the metadata/controls
    // form a right-aligned cluster of fixed-width columns (trust · logs · time/port) that line up
    // row-to-row. Right-anchored, so the rightmost column (time/port) always aligns; the others
    // stack inward from it.
    // fold-row: in the default folded view a remote row sits directly under its owner's header, so it
    // joins the fold's shaded band. Not applied in filter/search modes, where rows appear headerless.
    const inFold = !!r.remote && !this.searchActive && !this.filter.trim()
    return div({ class: ['server-row', inFold ? 'fold-row' : '', i === this.highlighted ? 'active' : '', dimmed ? 'dimmed' : ''],
        onMouseEnter: () => this.hoverRow(i, s) },
      s
        ? button({ class: 'server-stop', title: 'Stop this server', ariaLabel: 'Stop', onClick: (e: MouseEvent) => { e.stopPropagation(); this.stop(s.pid) } }, iconStop())
        : button({ class: ['bulb-launch', this.launching.has(pathKey(r.path)) ? 'launching shimmer' : ''], title: r.remote ? 'Download from typebulb.com & launch' : trusted ? 'Launch (trusted — remembered)' : 'Launch (restricted)', ariaLabel: 'Launch', onClick: (e: MouseEvent) => { e.stopPropagation(); r.remote ? this.downloadAndLaunch(r) : this.launch(r.path) } }, iconPlay()),
      // The name opens the bulb's .bulb.md in the editor (running or stopped). The live app is
      // reachable separately via the :port link; the play button launches. Not a launch trigger.
      // A remote sample has no file yet, so its name is inert (description in the tooltip); the
      // row's user link is the way to its typebulb.com page.
      div({ class: 'bulb-name-cell' },
        r.remote
          ? span({ class: 'server-name stopped remote', title: r.remote.description }, r.name)
          : span({ class: ['server-name', s ? '' : 'stopped'], title: `Open ${r.path}`, onClick: (e: MouseEvent) => { e.stopPropagation(); tb.server.openFile(r.path) } }, r.name),
        this.userLink(r),
        hitsBadge(r.hitCount),
        pullError ? span({ class: 'pull-error' }, pullError) : null,
      ),
      // push/pull sits beside the name cell's typebulb.com link — one sync cluster; the scope column
      // then heads the execution controls (trust · logs · port), where picking a batch belongs.
      this.syncCell(r),
      this.scopeCell(r, s),
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
        : r.remote ? span({ class: 'cell-empty' }) : span({ class: 'bulb-time' }, relTime(r.recent)),
      // Full-text mode only: the first matching line, on a second subgrid row under the name column.
      snippetLine(r.snippet, this.filter.trim()),
    )
  }

  // The low-profile link back to a downloaded (or not-yet-downloaded) bulb's published page,
  // reading its owner's slug — the logs-link register. Nothing for an ordinary project bulb.
  userLink(r: BulbRow) {
    const user = rowUser(r)
    return user ? a({ class: 'sample-link', href: rowUserUrl(r, user), target: '_blank', rel: 'noopener noreferrer', title: `Open this bulb's page on typebulb.com` }, user) : null
  }

  // push/pull verbs, one cell so the grid stays one column wider: pull ↓ where a remote exists
  // (any u/<owner>/ path), push ↑ where the bulb is the token user's and local. A remote row's
  // play already pulls, so it gets an empty cell; so does an ordinary project bulb (no remote).
  syncCell(r: BulbRow) {
    const user = rowUser(r)
    if (!user || r.remote) return span({ class: 'cell-empty' })
    const verb = (name: 'pull' | 'push', title: string) => {
      const key = `${pathKey(r.path)}:${name}`
      const busy = this.syncBusy.has(key)
      const done = this.syncDone.has(key)
      return button({ class: ['sync-btn', busy ? 'busy shimmer' : '', done ? 'done' : ''], title, ariaLabel: name,
        onClick: (e: MouseEvent) => { e.stopPropagation(); if (!busy) this.syncRow(r, name) } },
        icon(done ? 'check' : name, 'btn-icon-sm'))
    }
    return span({ class: 'sync-cell' },
      verb('pull', `Pull — update the local file from typebulb.com/u/${user}`),
      user === this.myUser
        ? verb('push', 'Push — upload this file to typebulb.com')
        : null,
    )
  }

  // A catalog's fold header — a full-width row in the ordinary row slot, so the keyboard cursor and
  // highlight treat it like any other row; Enter/click toggles the fold. The caret rides a
  // play-button-sized box (.fold-caret), so the button column exists — same width, same margins —
  // even when no local row renders a real button, and the caret centres under the play glyphs.
  groupRow(r: BulbRow, i: number, dimmed: boolean) {
    const { user, count } = r.group!
    const open = this.openFolds.has(user)
    return div({ class: ['server-row', 'sample-group', open ? 'open' : '', i === this.highlighted ? 'active' : '', dimmed ? 'dimmed' : ''],
        title: open ? 'Collapse' : this.foldTitle(user),
        onMouseEnter: () => this.hoverRow(i),
        onClick: (e: MouseEvent) => { e.stopPropagation(); this.toggleFold(user) } },
      span({ class: 'fold-caret' }, icon('caret', ['caret-tri', open ? 'open' : ''])),
      span({ class: 'sample-group-label' }, `${r.name} (${count})`),
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
