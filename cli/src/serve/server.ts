/**
 * Local HTTP server for serving bulbs.
 * Uses Hono for routing, consistent with the main Typebulb server.
 */

import { Hono, type Context } from 'hono'
import { serve } from '@hono/node-server'
import { streamSSE } from 'hono/streaming'
import * as fs from 'fs/promises'
import * as path from 'path'
import type { EventEmitter } from 'events'
import open from 'open'
import { normalizeUpstreamError, consumeStreamResult, streamAiChunks, buildInferencePrompt, sanitizeJsonOutput, encodeToHash, decodeFromHash, ProviderStreamError } from 'typebulb/ai'
import { parseConfig, splitIntoChunks, contentTypeFor, forbiddenAssetExt } from 'typebulb/format'
import { FsProxyCache } from '../deps/cache/fsProxyCache.js'
import { inferModalJs } from '../bulb/inferModalUi.js'
import { RECONNECT_RETRY_MS } from '../bulb/pageChrome.js'
import { recordDenial, relayOpen } from './serverRegistry.js'
import { getFilteredModels, aiAccess } from './modelCatalog.js'
import { resolveLocalProvider, sendTbAi } from './localProvider.js'
import { streamNdjson, toStreamError } from './ndjsonStream.js'
import { resolveServerFn, isAsyncGenerator } from './builtins.js'
import { resolvePath, readFsBytes, writeFsFile } from './tbFs.js'
import { isEsmAbsoluteImportPath } from './esmProxyPaths.js'
import { PageSet, PAGE_LOG, RELOAD_SETTLE_MS, PAGE_ARRIVAL_MS, type PageCloseReason } from './pages.js'

// The CLI is a local tool: the server binds loopback only and is never reachable
// off-machine. Sharing / other-device access is typebulb.com's job, not the CLI's.
const LOOPBACK = '127.0.0.1'

// Hostnames that address THIS machine. Since the server binds loopback only, a
// legitimate request's Host/Origin is always one of these; anything else (e.g. a
// DNS-rebinding domain pointed at 127.0.0.1) addresses us by a name we don't own.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

/** Counts server instances in this process, so two started in the same millisecond still differ. */
let serverInstances = 0

/** Hostname of a `Host` header (`127.0.0.1:3000`) or an `Origin` (`http://…:3000`),
 *  port and IPv6 brackets stripped. undefined if absent/unparseable. */
function hostnameOf(value: string | undefined): string | undefined {
  if (!value) return undefined
  try { return new URL(value.includes('://') ? value : `http://${value}`).hostname } catch { return undefined }
}

/** Does this Host/Origin value address the local machine? */
function isLocalAddress(value: string | undefined): boolean {
  const host = hostnameOf(value)
  return !!host && LOCAL_HOSTS.has(host)
}

/** A local http(s) URL — the only kind `/__open` relays. */
function isLocalHttpUrl(value: string): boolean {
  try {
    const u = new URL(value)
    return (u.protocol === 'http:' || u.protocol === 'https:') && isLocalAddress(u.host)
  } catch { return false }
}

/** Rendered by VS Code's integrated browser? Its UA carries both `Code/<ver>` and `Electron/<ver>`
 *  (verified live on 1.134 — TB-VSCode-Browser.md). */
function isVsCodeUserAgent(ua: string | undefined): boolean {
  return !!ua && /\bCode\/\d/.test(ua) && /\bElectron\//.test(ua)
}

/** Does `origin` address the exact host:port given by the request's `Host` — i.e. the
 *  page's *own* origin? This is the only origin allowed to reach a privileged endpoint
 *  when `Sec-Fetch-Site` is absent. Matching against `Host` tracks whichever local name
 *  the page was opened under (localhost vs 127.0.0.1), since both headers carry it. A
 *  sibling localhost origin (a different port) is *same-site but not same-origin*, so it
 *  fails here — the distinction the same-site CSRF finding turns on (TB-Security-Attacks.md). */
function isOwnOrigin(origin: string, host: string | undefined): boolean {
  if (!host) return false
  try { return new URL(origin).host === host } catch { return false }
}

/** Message text for a caught unknown, for JSON error bodies. */
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : 'Unknown error'
}

export interface ServerOptions {
  getHtml: () => string
  basePath: string
  /** Base for RELATIVE /__fs paths: the bulb's folder, or its --batch folder (TB-FS.md, TB-Batch.md). Containment stays
   *  `basePath` (the project), so `../` reaches siblings but never escapes the project.
   *  Absent (agent mirror, older tests) → falls back to basePath, the old cwd-relative rule. */
  fsBase?: string
  port: number
  reloadEmitter?: EventEmitter
  /** Does this server carry the `typebulb send` channel (TB-CLI.md)? Set unconditionally by the web
   *  runner (unlike `reloadEmitter`, which is watch-only) so send works even under `--no-watch`; the
   *  mirror sets nothing. The pushes ride each page's own stream as `message` SSE events carrying an
   *  `{ id?, payload }` envelope (`id` only when the sender awaits replies), fanned out over the
   *  page set — which is therefore both the delivery list and the count `/__send` reports, one fact
   *  with one spelling (TB-Page-Lifecycle.md, invariant 6). */
  sendChannel?: boolean
  getServerExports?: () => Record<string, Function> | undefined
  /** The bulb's raw block sources for `tb.infer()` prompt building (TB-Inference.md): `code` is
   *  the TSX source, not transpiled output. A closure over the latest compile, like
   *  `getServerExports`, so hot reload stays fresh. */
  getBulbBlocks?: () => { infer: string; insight: string; code: string; config: string; data: string } | undefined
  /** "Save to bulb" (TB-Inference.md): write a decoded inference run into the bulb file's
   *  data.txt/insight.json blocks. Owned by the web runner (it knows the file and the watcher). */
  saveInferenceResult?: (data: string[], insightJson: string) => Promise<void>
  /** Local package override: serve `<name>`'s bytes read-only from `serveDir`. */
  localOverride?: { name: string; serveDir: string }
  /** Whether the bulb was launched with `--trust`. When false (the default),
   *  the privileged endpoints (`/__fs`, `/__api`, `/__ai`, `/__infer`, `/__infer-save`) are hard-denied
   *  server-side — the airtight half of default-deny (TB-Security.md),
   *  independent of the sandboxed-frame origin isolation that also fences them off.
   *  `trustHint` is the re-run command surfaced in the 403 for non-browser callers. */
  trusted?: boolean
  trustHint?: string
  /** Serve a built asset directory read-only under `mount` (e.g. the agent mirror's
   *  bundled client at `/agents/claude/`). Like `localOverride` but not tied to the
   *  `--replace` mechanism — just static bytes from disk, content-typed and
   *  traversal-guarded. The global COOP/COEP middleware wraps these too. */
  staticAssets?: { mount: string; dir: string }
  /** The bulb's `assets/` folder(s) (TB-Assets.md), served read-only at `/assets/` in every
   *  paged tier — NOT trust-gated: its exposure class equals the `/` route's compiled source.
   *  `dirs` is the ordered shadowing chain — under `--batch` the batch's `assets/` precedes the
   *  authored one (batch shadows authored shadows remote). `remoteBase` is the bulb's derived
   *  hosted base (TB-Assets-Push.md Invariant 2); a miss in every dir 302s there when set,
   *  else 404s. */
  bulbAssets?: { dirs: string[]; remoteBase?: string }
  /** The `.bulb.md` this page was compiled from. Served read-only at `/__source/…` so devtools can
   *  fetch the file the page's source map points at (TB-CLI.md, One coordinate space). */
  sourceFile?: string
  /** Which bulb this server serves (`bulbStreamKey`, serve/paths.ts — the why is there). A page
   *  announcing another's is declined `close: foreign`. Absent (the mirror, tests) ⇒ never checked. */
  bulbKey?: string
  /** Run when `/__stop` is accepted: the owner's ordinary cleanup, which exits the process. Called
   *  after the response flushes, so the caller reads the observed page count first. */
  onStop?: (opts: { pages: 'close' | 'keep' }) => void | Promise<void>
}

export interface ServerInstance {
  port: number
  close: () => void
  /** Have a page for this server, where the agent mirror is (TB-VSCode-Browser.md). See requestPage. */
  requestPage: (opts: PageRequest) => Promise<PageOutcome>
  /** Tell every page to go and wait to SEE it (TB-Page-Lifecycle.md). Cleanup's first step, so a
   *  Ctrl-C, a POSIX signal and `/__stop` all dispose of the pages by one path. Never throws. */
  closePages: (reason: PageCloseReason) => Promise<{ told: number; gone: number }>
  /** How many pages are attached right now — the same field `/__pages` and `/__send` report
   *  (invariant 6), read directly by the process that owns it rather than over its own HTTP. What
   *  makes a "Browser reloading..." line state what it reached instead of what it hoped. */
  pageCount: () => number
}

export interface PageRequest {
  /** May the CLI open the external browser when no page of ours is inside VS Code to relay through?
   *  `never` — a replaced server's tab may still return; `follow` — only where the mirror itself is
   *  open externally; `force` — the CLI's 'window' mode. The relay is tried first either way. */
  external: 'never' | 'follow' | 'force'
  /** No earlier tab of this server's can be reattaching (a bulb never run before), so its settle window is skipped. */
  fresh: boolean
}

/**
 * How `requestPage` ended. Every member is TERMINAL (TB-Page-Lifecycle.md): the ask holds for the
 * page itself, so there is no longer an answer that means *ask me again*, and a caller cannot
 * mishandle one by omission. `editor` and `external` are the two ways it opened one AND saw it
 * arrive; `unreached` is an open that never produced a page, which is a different nothing from
 * having nothing to open through.
 */
export type PageOutcome =
  | { how: 'attached' }                 // a page is here: it already was, or it came back on its own
  | { how: 'editor'; via: string }      // relayed into VS Code through `via`, and the page attached
  | { how: 'external' }                 // the external browser was opened, and the page attached
  | { how: 'unreached'; via?: string }  // a page was opened and never attached
  | { how: 'none' }                     // nothing to open through, and no external window wanted

/** Where an outcome opened a page, when it names one — the half of it a status line quotes. */
export const openedVia = (o: PageOutcome): string | undefined =>
  o.how === 'editor' || o.how === 'unreached' ? o.via : undefined

/** An ask that found nothing to open through is answered "none" for this long before asking the
 *  registry again — off the 150ms retry cadence, but quick to notice a mirror the user just opened. */
const RELAY_RETRY_MS = 2000

/** Start the local HTTP server */
export async function startServer(options: ServerOptions): Promise<ServerInstance> {
  const { getHtml, basePath, fsBase, port, reloadEmitter, sendChannel, getServerExports, getBulbBlocks, saveInferenceResult, localOverride, trusted = false, trustHint, staticAssets, bulbAssets, sourceFile, bulbKey, onStop } = options

  // Identifies THIS server instance to a connected page: a replace hands our port to a successor, and
  // the id changing across a reconnect is how the page knows to reload rather than resume. Per
  // instance, not per process — a process can hold more than one server, and "the server you are
  // talking to" is the thing the page actually needs to identify.
  const bootId = `${process.pid}-${++serverInstances}-${Date.now()}`
  // Relative /__fs paths resolve here (the bulb's folder — TB-FS.md); containment stays basePath.
  const fsRoot = fsBase ?? basePath

  const app = new Hono()

  // DNS-rebinding guard (global): the `server.ts` RPC + `tb.fs` routes run with
  // the user's full Node/filesystem privileges, so a request arriving under a
  // non-local Host header is a rebinding attempt — reject it before any route
  // runs. Legitimate browsers reaching 127.0.0.1 always send a local Host.
  app.use('*', async (c, next) => {
    if (!isLocalAddress(c.req.header('host'))) return c.text('Forbidden: untrusted Host', 403)
    await next()
  })

  // Cross-origin isolation headers — required for SharedArrayBuffer
  app.use('*', async (c, next) => {
    await next()
    c.res.headers.set('Cross-Origin-Opener-Policy', 'same-origin')
    c.res.headers.set('Cross-Origin-Embedder-Policy', 'credentialless')
  })

  // The capability boundary (TB-Security.md, Trust Invariant 2): the only routes that touch the
  // user's filesystem, API keys, or Node, each paired with the capability its denial names (the
  // same labels predictTrust echoes, so the proactive and reactive prompts read alike). Both
  // guards below apply to exactly this set — one table keeps route-is-privileged and
  // what-was-denied from drifting apart.
  const PRIVILEGED_ROUTES: Array<[pattern: string, capability: string]> = [
    ['/__fs/*', 'the filesystem'],
    ['/__api/*', 'server-side code (server.ts)'],
    ['/__ai', 'AI (your API keys)'],
    ['/__infer', 'AI (your API keys)'],
    ['/__infer-save', 'the filesystem'],
  ]

  // Trust gate (default-deny). Without `--trust`, the privileged endpoints are
  // hard-denied here — the contract of TB-Security.md. This is
  // belt-and-suspenders to the sandboxed-frame mechanism that already fences these
  // off by origin: the gate holds regardless of how the request arrives (raw
  // fetch, curl, a future non-iframe path), so default-deny never depends on
  // browser semantics. Runs before the CSRF guard so the denial that names the
  // unlock wins. The 403 body names `--trust` for non-browser callers; the
  // in-page shim throws its own `--trust` message before a fetch is ever made.
  const trustGate = async (c: Context, next: () => Promise<void>): Promise<Response | void> => {
    if (!trusted) {
      // Record which capability was denied so a host (the launcher) can offer to relaunch
      // trusted. Fire-and-forget — never block the 403 on a registry write.
      const p = new URL(c.req.url).pathname
      const cap = PRIVILEGED_ROUTES.find(([pat]) =>
        pat.endsWith('/*') ? p.startsWith(pat.slice(0, -2)) : p === pat
      )?.[1] ?? 'server-side code (server.ts)'
      void recordDenial(process.pid, cap)
      const hint = trustHint ? `\n  ${trustHint}` : ''
      return c.text(`Forbidden: this capability requires --trust.${hint}`, 403)
    }
    await next()
  }

  // CSRF guard: only the bulb's *own* page may reach a privileged endpoint. A page on a
  // different localhost origin — another bulb, a dev server, a malicious site open in the
  // same browser — shares this server's *site* (different ports are same-site, not
  // cross-site), so blocking only cross-site would let a sibling origin drive /__fs etc.
  // (the same-site CSRF finding, TB-Security-Attacks.md). So require same-origin: the
  // page's own `Sec-Fetch-Site: same-origin`, or — for clients that don't send it — an
  // Origin that exactly matches this server. Non-browser callers (curl, tests: neither
  // header) still pass, and remain `--trust`-gated regardless.
  const csrfGuard = async (c: Context, next: () => Promise<void>): Promise<Response | void> => {
    const site = c.req.header('sec-fetch-site')
    if (site) {
      // `none` (a direct navigation) never reaches these POST-only routes; anything but
      // the page's own same-origin call — same-site included — is refused.
      if (site !== 'same-origin') return c.text(`Forbidden: ${site} request`, 403)
    } else {
      const origin = c.req.header('origin')
      if (origin && !isOwnOrigin(origin, c.req.header('host'))) return c.text('Forbidden: cross-origin request', 403)
    }
    await next()
  }

  for (const [route] of PRIVILEGED_ROUTES) {
    app.use(route, trustGate)
    app.use(route, csrfGuard)
  }

  // Diagnostic log — `tb.log`. Deliberately NOT a privileged route: it only ever runs the
  // built-in `console.log` (below), never a user `server.ts` export, so it spends no keys, touches
  // no fs, and runs no user Node — it crosses no capability boundary. That's why it's ungated: a
  // Restricted bulb can still print debug output (the FAQ's recommended debugging path) without
  // tripping the trust gate (and so without raising a spurious elevation prompt for a plain log).
  // Still CSRF-guarded, so a cross-site page can't spam the console; the same-origin shim passes.
  app.use('/__log', csrfGuard)
  app.post('/__log', async (c) => {
    try {
      const { args } = await c.req.json<{ args: unknown[] }>()
      console.log(...(args || []))
    } catch { /* malformed body — never error a fire-and-forget log */ }
    return c.json({ ok: true })
  })

  // `typebulb send` push (TB-CLI.md) — re-emit the posted body to every connected page as a
  // `message` SSE event the shim hands to `tb.onMessage`. Data-in, the dual of the ungated
  // `tb.log` (data-out): it runs no user code, spends no key, touches no fs, so it crosses no
  // capability boundary and needs no --trust. Still CSRF-guarded like /__log: the CLI (no Origin)
  // passes, a cross-site browser POST is refused, so no other page can inject into the bulb. The
  // body is forwarded verbatim; the shim interprets it (JSON-or-string). Returns the connected-page
  // count so `send` can report delivery. Never buffered: with nobody listening and nobody coming,
  // nothing is emitted and the send is reported as the failure it is (invariant 8).
  //
  // The reply leg (TB-Interrogation.md): `?reply=<ms>` broadcasts under an id and holds the
  // response until every page then connected has POSTed `/__send-reply` for that id, or the window
  // elapses. Aggregation only — the one-reply rule is the CLI's to enforce — and still never a
  // queue: zero connected pages resolves immediately, reply or not.
  /** One attached page: an event stream, and whether VS Code's integrated browser renders it (its UA
   *  says so) — the footholds `/__open` relays through. */
  type Page = {
    inEditor: boolean
    doc?: string
    open: (url: string) => Promise<void>
    send: (envelope: { id?: number; payload: string }) => Promise<void>
    close: (reason: PageCloseReason) => Promise<void>
  }
  /** The set, and the transitions over it (serve/pages.ts): arrivals, departures, the close drain —
   *  every "is one here / is one coming / did they all go" is answered from here. It holds the ONE
   *  page count (invariant 6): `/__send` reports it, `/__open` answers with it, `/__pages` prints
   *  it, and `pageCount()` hands it to the watchers. */
  const pages = new PageSet<Page>()
  /** Bulb keys already declined here (below). The departure is said once per stranger, not on every
   *  reconnect of a page that could not navigate to its note — it retries forever now. */
  const declined = new Set<string>()
  /** Every CLI-opened document seen here, by the id its shim announces (`/__reload?relay=<id>`).
   *  Membership is what tells a first arrival from a reconnect of a page already here — a hot
   *  reload's drop-and-reattach must not read as a newcomer. Kept for the server's life. */
  const relayDocs = new Set<string>()
  const bootAt = Date.now()

  /**
   * Every arrival, in one place. The wake line first (a page attached where none was — an agent
   * ends its turn with the link and a background `wait --match "[page] connected"`, and the user
   * opening the page is the wake, never a popped window), then the yield rule.
   *
   * One CLI-opened page (TB-VSCode-Browser.md). **Only the newcomer ever yields**, and only on its
   * FIRST attach: a page that is already here is the user's — whatever opened it — so a second view
   * arriving never takes it away. That asymmetry is the whole rule. It gives both halves of what a
   * user means: a mirror gesture (play, the `:port` link) opens through the relay's URL, so a
   * duplicate steps aside and the launcher can never stack; a tab the user makes by hand and pastes
   * into announces no relay id, so it neither yields nor evicts, and two views is simply two views.
   * A reconnect (hot reload, a blip) is not a first attach and is exempt.
   */
  pages.onArrival(({ page, firstAttach, count }) => {
    if (sendChannel && count === 1) console.log(PAGE_LOG.connected)
    if (firstAttach && count > 1) page.close('yielded').catch(() => { /* the stream may already be gone */ })
  })
  // The departure line, the arrival's twin, settled so a hot reload's drop-and-reattach stays silent.
  // A page-driven run whose tab closed is otherwise a log that just stops (TB-Wait.md).
  if (sendChannel) pages.onSettledEmpty(() => console.log(PAGE_LOG.disconnected))

  /** An ask still in flight. The second asker awaits the SAME one rather than relaying again: never
   *  a second open, and never a "none" invented while an open is on its way. */
  let asking: Promise<PageOutcome> | undefined
  /** When an ask last found nothing to relay through. A different question from "is one coming" —
   *  purely "should I bother asking the registry again" — which is why it survived the collapse. */
  let lastNoneAt = 0

  /**
   * Have a page for this server, where the agent mirror is (TB-VSCode-Browser.md), and HOLD for it:
   * an attached page counts; else wait out any page already on its way back (a predecessor's tab
   * inside this server's first settle window, or one that just dropped) before opening anything;
   * else the relay into VS Code, else the external browser as far as `external` allows — and then
   * wait for the page that open produces. Opening without waiting delivers nothing, which is why
   * the wait is the ask's own and not each caller's (TB-Page-Lifecycle.md, Delivery).
   */
  const askForPage = async (opts: PageRequest): Promise<PageOutcome> => {
    // When a page could last have started coming back on its own: this server's boot (a predecessor's
    // tab still retrying, unless the bulb is fresh) or a page that just dropped. 0 disables the clock.
    const reattachSince = Math.max(opts.fresh ? 0 : bootAt, pages.lastDropAt)
    if (await pages.whenArrives(RELOAD_SETTLE_MS - (Date.now() - reattachSince))) return { how: 'attached' }
    if (Date.now() - lastNoneAt < RELAY_RETRY_MS) return { how: 'none' }
    // The fragment marks a page WE opened: its shim announces itself provisional and strips the hash,
    // so the page yields if another turns out to be here (yieldProvisional) and a reload is ordinary.
    const url = `http://localhost:${port}#tb-relay`
    const relay = await relayOpen(url, basePath)
    let opened: PageOutcome | undefined
    if (relay?.where === 'editor') opened = { how: 'editor', via: relay.via }
    else if (opts.external === 'force' || (opts.external === 'follow' && relay?.where === 'external')) {
      await open(url)
      opened = { how: 'external' }
    }
    if (!opened) { lastNoneAt = Date.now(); return { how: 'none' } }
    // A page takes seconds to arrive and the channel is never buffered, so an ask that opened one
    // and walked away has moved a window and lost its caller's message.
    return await pages.whenArrives(PAGE_ARRIVAL_MS) ? opened : { how: 'unreached', via: openedVia(opened) }
  }

  const requestPage = (opts: PageRequest): Promise<PageOutcome> => {
    if (pages.count > 0) return Promise.resolve({ how: 'attached' })
    // Registered synchronously, before the first await inside: a concurrent asker (the launch's
    // hand-over and a `send` can land together) must join this ask, not start a second one.
    return asking ??= askForPage(opts).finally(() => { asking = undefined })
  }

  if (sendChannel) {
    /** One held `/__send?reply` awaiting its pages' `/__send-reply` POSTs. */
    type PendingSend = { expected: number; received: number; results: string[]; errors: string[]; finish: (timedOut: boolean) => void }
    let sendSeq = 0
    const pendingSends = new Map<number, PendingSend>()
    app.use('/__send', csrfGuard)
    app.post('/__send', async (c) => {
      let payload = ''
      try { payload = await c.req.text() } catch { /* empty body ⇒ a bare trigger */ }
      const replyMs = Number(c.req.query('reply')) || 0
      // `?open=1` (every send): with nobody listening, find the page a home where the agent mirror
      // is, and HOLD for it here rather than answering "on its way" and leaving the sender to poll.
      // The hold is what lets a send that reopened a tab still deliver — and what deletes the
      // sender's own deadline arithmetic, which is where incident 4's bug lived.
      const page = pages.count === 0 && c.req.query('open') !== undefined ? await requestPage({ external: 'follow', fresh: false }) : undefined
      // Read ONCE, after the hold, and fanned out over the same set with nothing awaited in between:
      // the list we deliver to IS the count we report. The old ordering (count first) existed only
      // because the sender retried behind our answer, and a page attaching mid-ask would then run
      // the payload AND the retry — a tb:click fired twice. It holds now, so the rule inverts.
      const clients = pages.count
      // With nobody listening, report WHICH nothing this is: a bulb never opened, or a page that was
      // here until seconds ago and hasn't come back — a stale tab the user is looking at right now.
      // "No page connected" is true for both and useless for either (TB-CLI.md, observed state).
      const dropped = clients === 0 && pages.lastDropAt ? Date.now() - pages.lastDropAt : undefined
      const status = { clients, droppedMsAgo: dropped, ...(page ? { opening: page.how, via: openedVia(page) } : {}) }
      // `?solo=1` marks an actuation (TB-Interrogation-Actuation.md): a gesture broadcast to two
      // pages has fired twice before their replies can disagree, so — unlike the read-side
      // one-reply rule, which judges after the fact — this refuses BEFORE dispatch unless exactly
      // one page is connected — applied to the count the hold above settled on, never to a zero it
      // was about to leave behind.
      if (c.req.query('solo') !== undefined && clients !== 1) {
        return c.json({ ...status, refused: clients > 1 })
      }
      // Nobody listening, and nothing on its way: never emit, never buffer. The sender reports it as
      // a failed send (TB-Page-Lifecycle.md, invariant 8).
      if (clients === 0) return c.json(status)
      const fanOut = (envelope: { id?: number; payload: string }) => {
        for (const p of pages) p.send(envelope).catch(() => { /* a page leaving mid-send */ })
      }
      if (replyMs <= 0) {
        fanOut({ payload })
        return c.json(status)
      }
      const id = ++sendSeq
      const outcome = await new Promise<{ results: string[]; errors: string[]; timedOut: boolean }>(resolve => {
        const entry = {
          expected: clients, received: 0, results: [] as string[], errors: [] as string[],
          finish: (timedOut: boolean) => {
            clearTimeout(timer)
            pendingSends.delete(id)
            resolve({ results: entry.results, errors: entry.errors, timedOut })
          },
        }
        const timer = setTimeout(() => entry.finish(true), replyMs)
        pendingSends.set(id, entry)
        fanOut({ id, payload })
      })
      // The status rides the reply too: with one POST for the whole exchange, this is the only
      // answer the sender gets, so "a page was opened for you" has nowhere else to be said.
      return c.json({ ...status, ...outcome })
    })

    // The page's reply POST — same tier as /__send: data carried, no code run, CSRF-guarded.
    app.use('/__send-reply', csrfGuard)
    app.post('/__send-reply', async (c) => {
      try {
        const { id, results, errors } = await c.req.json<{ id: number; results?: string[]; errors?: string[] }>()
        const entry = pendingSends.get(id)
        if (entry) {
          entry.results.push(...(results ?? []))
          entry.errors.push(...(errors ?? []))
          if (++entry.received >= entry.expected) entry.finish(false)
        }
      } catch { /* malformed reply — never error the page's fire-and-forget POST */ }
      return c.json({ ok: true })
    })
  }

  // Main page - serve the compiled bulb HTML (dynamic for hot reload)
  app.get('/', (c) => {
    return c.html(getHtml())
  })

  // Filesystem API - read file. Returns raw bytes; the shim decodes text or
  // hands back a Uint8Array. No utf-8 decode here, so binary survives intact.
  app.post('/__fs/read', async (c) => {
    try {
      const { path: reqPath } = await c.req.json<{ path: string }>()
      const data = await readFsBytes(reqPath, fsRoot, basePath)
      return new Response(new Uint8Array(data), {
        headers: { 'Content-Type': 'application/octet-stream' },
      })
    } catch (e) {
      const message = errorMessage(e)
      return c.json({ error: message }, 400)
    }
  })

  // Filesystem API - write file. Path is a query param so the body can carry
  // raw bytes (binary) or UTF-8 text without a JSON envelope.
  app.post('/__fs/write', async (c) => {
    try {
      const reqPath = c.req.query('path')
      if (!reqPath) return c.json({ error: 'Missing path' }, 400)
      await writeFsFile(reqPath, new Uint8Array(await c.req.arrayBuffer()), fsRoot, basePath)
      return c.json({ success: true })
    } catch (e) {
      const message = errorMessage(e)
      return c.json({ error: message }, 400)
    }
  })

  // Server API - call exported functions from **server.ts**
  app.post('/__api/:name', async (c) => {
    try {
      const name = c.req.param('name')
      const fn = resolveServerFn(getServerExports?.(), name)
      if (!fn) {
        return c.json({ error: `API function '${name}' not found` }, 404)
      }
      const { args } = await c.req.json<{ args: unknown[] }>()
      // Async-generator exports stream: each `yield` is tunneled as a chunk over NDJSON, and the
      // client call becomes an async iterable.
      if (isAsyncGenerator(fn)) {
        return streamNdjson(c, fn(...(args || [])) as AsyncIterable<unknown>)
      }
      const result = await fn(...(args || []))
      return c.json({ result })
    } catch (e) {
      const message = errorMessage(e)
      return c.json({ error: message }, 500)
    }
  })

  // AI endpoint - tb.ai() calls AI providers directly using env API keys
  app.post('/__ai', async (c) => {
    try {
      const { messages, system, effort, provider: reqProvider, model: reqModel, webSearch, stream: wantStream } = await c.req.json<{
        messages: Array<{ role: string; content: string }>
        system?: string
        effort?: number
        provider?: string
        model?: string
        webSearch?: boolean
        stream?: boolean
      }>()

      if (!messages || !Array.isArray(messages) || messages.length === 0) {
        return c.json({ message: 'messages array is required', code: 'unknown', retryable: false }, 400)
      }

      const resolved = resolveLocalProvider(reqProvider, reqModel)
      if (typeof resolved === 'string') {
        return c.json({ message: resolved, code: 'unknown', retryable: false }, 400)
      }

      const response = await sendTbAi(resolved, {
        messages: messages as Array<{ role: 'user' | 'assistant'; content: string }>,
        system,
        effort,
        webSearch,
        signal: c.req.raw.signal,
      })

      if (!response.ok) {
        const error = await normalizeUpstreamError(response, resolved.protocol)
        return c.json(error, response.status as any)
      }

      // tb.ai.stream(): tunnel each provider delta to the bulb as an AiChunk over the shared NDJSON
      // transport (the final usage chunk rides along). Non-streaming tb.ai() buffers to a single
      // { text, usage? } (reasoning discarded).
      if (wantStream) {
        return streamNdjson(c, streamAiChunks(response, resolved.protocol))
      }

      const { text, usage } = await consumeStreamResult(response, resolved.protocol)

      if (!text) {
        console.warn('[tb.ai] Empty response from provider')
      }

      // JSON.stringify drops an undefined usage, so a provider that reported nothing keeps the
      // body shape bulbs had before.
      return c.json({ text, usage })
    } catch (e) {
      return c.json(toStreamError(e), 500)
    }
  })

  // Inference endpoint — tb.infer() (TB-Inference.md). The prompt is built server-side from the
  // bulb's own blocks (hot-reload fresh via getBulbBlocks); the request carries only the data
  // chunks the modal showed. Text deltas stream as NDJSON chunks for the modal's streaming view;
  // the final envelope carries the sanitized result plus the #tb= share fragment.
  app.post('/__infer', async (c) => {
    try {
      const { data } = await c.req.json<{ data?: string[] }>().catch(() => ({}) as { data?: string[] })
      const blocks = getBulbBlocks?.()
      if (!blocks?.infer.trim()) {
        return c.json({ message: 'This bulb has no infer.md block.', code: 'unknown', retryable: false }, 400)
      }
      const resolved = resolveLocalProvider()
      if (typeof resolved === 'string') {
        return c.json({ message: resolved, code: 'unknown', retryable: false }, 400)
      }

      const chunks = Array.isArray(data) ? data.map(String) : []
      const prompt = buildInferencePrompt(blocks, chunks)
      const response = await sendTbAi(resolved, {
        messages: [{ role: 'user', content: prompt }],
        signal: c.req.raw.signal,
      })
      if (!response.ok) {
        const error = await normalizeUpstreamError(response, resolved.protocol)
        return c.json(error, response.status as any)
      }

      const source = (async function* () {
        let full = ''
        for await (const chunk of streamAiChunks(response, resolved.protocol)) {
          if (chunk.kind !== 'text' || !chunk.text) continue
          full += chunk.text
          yield { kind: 'delta', text: chunk.text }
        }
        const result = sanitizeJsonOutput(full)
        if (result.parsed === undefined) {
          // Keep the evidence: without this, a parse failure is undiagnosable after the modal
          // closes (the streamed text is gone). Tail-truncated so a runaway output can't flood.
          console.warn('[tb.infer] output not valid JSON after sanitize; raw output (last 4000 chars):\n' + full.slice(-4000))
          throw new ProviderStreamError('LLM output is not valid JSON', 'parse_error', true)
        }
        if (result.fixesApplied.length) {
          console.warn('[tb.infer] sanitized output, fixes applied:', result.fixesApplied.join(', '))
        }
        const final = { insight: result.parsed, insightJson: result.json, data: chunks }
        yield { kind: 'complete', ...final, fixesApplied: result.fixesApplied, hash: encodeToHash(final) }
      })()
      return streamNdjson(c, source)
    } catch (e) {
      return c.json(toStreamError(e), 500)
    }
  })

  /** The `{hash}` body shared by /__infer-decode and /__infer-save: the page's `#tb=` fragment,
   *  decoded or undefined. */
  const decodeHashBody = async (c: Context): Promise<ReturnType<typeof decodeFromHash>> => {
    const { hash } = await c.req.json<{ hash?: string }>().catch(() => ({}) as { hash?: string })
    return typeof hash === 'string' ? decodeFromHash(hash) : undefined
  }

  // "Save to bulb" — promote the current #tb= run to source (TB-Inference.md). The fragment is the
  // carrier: the modal POSTs the page's hash, we decode it and rewrite the file's data/insight
  // blocks. Trust-gated (it writes the bulb file); the explicit modal gesture is the one sanctioned
  // writer — tb.infer() itself never touches the file (Invariant 2).
  app.post('/__infer-save', async (c) => {
    try {
      if (!saveInferenceResult) {
        return c.json({ message: 'Save is not available for this server.', code: 'unknown', retryable: false }, 400)
      }
      const result = await decodeHashBody(c)
      if (!result) {
        return c.json({ message: 'No decodable #tb= fragment to save.', code: 'unknown', retryable: false }, 400)
      }
      await saveInferenceResult(result.data, result.insightJson)
      return c.json({ ok: true })
    } catch (e) {
      return c.json(toStreamError(e), 500)
    }
  })

  // Modal seed for tb.infer's confirmation view: the resolved .env pair (or the resolver's
  // message, so a broken .env surfaces before any spend), the bulb's config.inference labels,
  // and the SOURCE data chunks. Source, not runtime: .com's IDE modal always reseeds from the
  // Data tab, never from post-run runtime state — the file is the local Data tab, and seeding
  // from runtime globals made a completed run's filtered chunks silently become the next seed
  // (an emptied chunk's tab vanished on reopen). Ungated like /__models: everything here is
  // already served in the bulb page itself, never keys.
  app.get('/__infer-info', (c) => {
    const blocks = getBulbBlocks?.()
    const inference = parseConfig(blocks?.config ?? '').inference
    const data = splitIntoChunks(blocks?.data ?? '')
    const resolved = resolveLocalProvider()
    if (typeof resolved === 'string') return c.json({ error: resolved, inference, data })
    return c.json({ provider: resolved.protocol, model: resolved.model, inference, data })
  })

  // #tb= fragment decode for the shim's boot restore (TB-Inference.md "Sharing a local run").
  // The fragment never rides an HTTP request on its own (its privacy property), so the page must
  // send it here — the server has fflate, the page doesn't. Pure function of caller-supplied
  // data, no capability, so NOT trust-gated: viewing a shared run is page data, and a Restricted
  // bulb must be able to consume one (parity with .com published pages). CSRF-guarded like /__log.
  app.use('/__infer-decode', csrfGuard)
  app.post('/__infer-decode', async (c) => {
    return c.json((await decodeHashBody(c)) ?? { error: 'invalid fragment' })
  })

  // The lazy-loaded inference modal (TB-Inference.md): fetched by the shim on the first
  // tb.infer() call, so a bulb that never infers serves a page with no host UI in it.
  app.get('/__infer-ui.js', (c) => c.body(inferModalJs, 200, { 'Content-Type': 'text/javascript; charset=utf-8' }))

  // Model discovery - fetches catalog from typebulb.com, filtered by local env API keys
  app.get('/__models', async (c) => {
    try {
      const models = await getFilteredModels()
      return c.json(models)
    } catch {
      return c.json([], 200)
    }
  })

  // AI-access check — backs tb.aiAccess(); 'none' on failure, the safe gating answer in the CLI
  app.get('/__ai-access', async (c) => {
    try {
      return c.json(await aiAccess())
    } catch {
      return c.json('none', 200)
    }
  })

  // CDN proxy — same-origin serving for Web Workers, WASM, AND all package
  // fetches that the import map routes here. Disk-cached so repeated runs
  // (and offline use) don't re-fetch.
  // The bulb's own source, for devtools: the page's source map points here, so the Sources panel
  // shows the `.bulb.md` rather than the transpiled script. Read fresh, so a save shows up on the
  // next look. Ungated — it is the source of the page you are already looking at — and it serves one
  // configured file whatever the path says, so there is nothing to traverse.
  if (sourceFile) {
    app.get('/__source/*', async (c) => {
      const text = await fs.readFile(sourceFile, 'utf-8').catch(() => undefined)
      return text === undefined
        ? c.text('Not Found', 404)
        : new Response(text, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
    })
  }

  const PROXY_ALLOWED_HOSTS = ['esm.sh', 'unpkg.com', 'cdn.jsdelivr.net', 'cdnjs.cloudflare.com']
  const proxyCache = new FsProxyCache()

  app.get('/proxy/*', async (c) => {
    // Reconstruct pathname + query as the browser saw it, then strip /proxy/
    // and locate the last "https://" — handles double-wrapped proxy URLs.
    const reqUrl = new URL(c.req.url)
    const pathAndQuery = reqUrl.pathname + reqUrl.search
    const raw = pathAndQuery.slice('/proxy/'.length)
    const idx = raw.lastIndexOf('https://')
    if (idx === -1) return c.text('Invalid proxy URL', 400)
    return proxyToUrl(c, raw.slice(idx))
  })

  // Local package override — serve the overridden package's built bytes read-only from
  // disk (TB-Replace.md). Registered only when an override is active.
  if (localOverride) serveStaticDir(app, `/local/${localOverride.name}/`, localOverride.serveDir)

  // Static asset directory (the debulbified agent mirror's bundled client) — read-only
  // bytes from disk under `mount`, independent of `--replace`.
  if (staticAssets) serveStaticDir(app, staticAssets.mount, staticAssets.dir)

  // Bulb assets (TB-Assets.md): `<img src="assets/x.png">` served from the bulb's own folder,
  // first dir in the chain wins. `no-cache` so hot iteration sees fresh bytes; remote caching
  // belongs to the author's host via the 302 fallback.
  if (bulbAssets) {
    app.get('/assets/*', async (c) => {
      const { pathname } = new URL(c.req.url)
      const rawRel = pathname.slice('/assets/'.length)
      // Decode before every check: the forbidden-ext gate, the serve, and the traversal guard
      // must all see the same real path, or a %2e-encoded dot would slip a `.js` past the gate
      // that the served (decoded) file then honours. A malformed % is a 404, not servable.
      let rel: string
      try { rel = decodeURIComponent(rawRel) } catch { return c.text('Not Found', 404) }
      // Same contract as the hosted PUT (TB-Assets-Push.md Invariant 9): code/markup
      // extensions aren't assets in any tier — a local run that served them would sail
      // into a publish-time refusal.
      const forbidden = forbiddenAssetExt(rel)
      if (forbidden) return c.text(`${forbidden} is not an asset type: a bulb's code and markup live in the bulb; assets are media and data`, 403)
      try {
        for (const dir of bulbAssets.dirs) {
          const found = await readServable(rel, dir, { 'Cache-Control': 'no-cache' })
          if (found) return found
        }
      } catch {
        return c.text('Not Found', 404)   // traversal — never redirected, never falls through
      }
      const base = bulbAssets.remoteBase
      return base ? c.redirect(base + rawRel, 302) : c.text('Not Found', 404)
    })
  }

  async function proxyToUrl(c: Context, targetUrl: string): Promise<Response> {
    let parsed: URL
    try { parsed = new URL(targetUrl) } catch { return c.text('Invalid URL', 400) }
    if (parsed.protocol !== 'https:') return c.text('HTTPS only', 400)
    if (!PROXY_ALLOWED_HOSTS.includes(parsed.hostname)) return c.text('Host not allowed', 403)

    const hit = await proxyCache.get(targetUrl)
    if (hit) {
      return new Response(hit.body as BodyInit, { status: 200, headers: buildProxyResponseHeaders(hit.contentType, hit.cacheControl) })
    }

    try {
      const resp = await fetch(targetUrl, {
        headers: { 'Accept': c.req.header('Accept') || '*/*' },
        redirect: 'follow',
      })
      if (!resp.ok) return c.text(`Upstream ${resp.status}`, resp.status as any)

      const contentType = resp.headers.get('Content-Type') || undefined
      const cacheControl = resp.headers.get('Cache-Control') || undefined

      // Tee the upstream stream so the browser sees bytes as they arrive
      // while we drain the second branch to disk in the background. Without
      // tee, large WASM (~30MB ffmpeg-core) would block until fully buffered.
      if (resp.body) {
        const [forClient, forCache] = resp.body.tee()
        void (async () => {
          try {
            const ab = await new Response(forCache).arrayBuffer()
            await proxyCache.set(targetUrl, { body: Buffer.from(ab), contentType, cacheControl })
          } catch {}
        })()
        return new Response(forClient, { status: resp.status, headers: buildProxyResponseHeaders(contentType, cacheControl) })
      }

      // Empty body — nothing to stream or cache.
      return new Response(null, { status: resp.status, headers: buildProxyResponseHeaders(contentType, cacheControl) })
    } catch (e) {
      return c.text(`Proxy fetch failed: ${e instanceof Error ? e.message : e}`, 502)
    }
  }

  // Events SSE — one connection per page carrying two channels: `reload` (hot reload, watch-only)
  // and `message` (`typebulb send`). The page's shim opens this whenever it's served by the dev
  // server. Registered if either channel is active. A message rides its `{ id?, payload }` envelope
  // JSON-encoded on the wire so a multi-line value can't break SSE's line framing; the shim decodes it.
  if (reloadEmitter || sendChannel) {
    app.get('/__reload', (c) => {
      return streamSSE(c, async (stream) => {
        // Which bulb the page thinks it is at (`bulbStreamKey`): adopting a stranger would count,
        // report and reuse someone else's page as ours.
        const claimed = c.req.query('bulb') || undefined
        if (bulbKey && claimed && claimed !== bulbKey) {
          if (!declined.has(claimed)) { declined.add(claimed); console.log(PAGE_LOG.closed('foreign')) }
          await stream.writeSSE({ event: 'close', data: 'foreign' })
          return
        }
        const onReload = () => { stream.writeSSE({ event: 'reload', data: '' }) }
        reloadEmitter?.on('reload', onReload)
        // Run on both exits — the page leaving, or being told to go. A no-op the second time.
        const detachReload = () => reloadEmitter?.removeListener('reload', onReload)
        const doc = c.req.query('relay') || undefined
        const page: Page = {
          inEditor: isVsCodeUserAgent(c.req.header('user-agent')),
          doc,
          open: (url: string) => stream.writeSSE({ event: 'open-url', data: url }),
          // A `typebulb send` push, envelope JSON-encoded so a multi-line value cannot break SSE's
          // line framing (the shim decodes it).
          send: (envelope) => stream.writeSSE({ event: 'message', data: JSON.stringify(envelope) }),
          // Told to go: stop counting at once, then watch for the stream to drop as the tab closes
          // or navigates. One departure event for every reason (invariant 6).
          close: (reason: PageCloseReason) => {
            detachReload()
            pages.closing(page)
            console.log(PAGE_LOG.closed(reason))
            return stream.writeSSE({ event: 'close', data: reason })
          },
        }
        const firstAttach = !!doc && !relayDocs.has(doc)
        if (doc) relayDocs.add(doc)
        // The arrival: the wake line, the yield rule, and every ask holding for a page are woken
        // from the one place (pages.onArrival, above).
        pages.add(page, firstAttach)
        stream.onAbort(() => { detachReload(); pages.dropped(page) })

        // Who the page just connected to. A replace hands the same port to a NEW process serving new
        // bytes, so a page that reconnects and sees a different boot id reloads itself; the same id
        // (a laptop wake, a network blip) resumes silently. Without this a reconnected tab is a
        // zombie showing the dead server's render — TB-CLI.md, "A replace keeps the user's tab". The
        // `retry` is the page's reconnect interval, which runWeb's hand-over grace is sized to.
        await stream.writeSSE({ event: 'hello', data: bootId, retry: RECONNECT_RETRY_MS })

        // Keep connection alive. Checking `aborted` is what lets this coroutine end when the
        // page disconnects — Hono's `sleep` ignores abort, and the stream only closes once
        // this callback returns, so a bare `while (true)` leaks one immortal timer loop per
        // closed EventSource (every hot reload makes one).
        while (!stream.aborted) {
          await stream.sleep(30000)
        }
      })
    })

    // A relay open (TB-VSCode-Browser.md): open `url` inside VS Code through a page of ours that its
    // integrated browser renders — that browser honors a gesture-less window.open and keeps the new
    // tab in-editor, which no CLI-side route can. Exactly one page gets it: two would open two tabs
    // and trip the one-page rule. Local URLs only, and CSRF-guarded like /__send: the CLI (no Origin)
    // passes, a foreign page is refused, so nothing else can pop tabs at the user. `pages` counts every
    // attached page, in-editor or not: how a caller tells "open only in an external browser" from "not
    // open at all" (relayOpen's external answer).
    app.use('/__open', csrfGuard)
    app.post('/__open', async (c) => {
      let url = ''
      try { url = String((await c.req.json<{ url?: unknown }>()).url ?? '') } catch { /* the 400 below */ }
      if (!isLocalHttpUrl(url)) return c.json({ error: 'a local http URL is required' }, 400)
      const foothold = [...pages].find(p => p.inEditor)
      await foothold?.open(url)
      return c.json({ opened: !!foothold, pages: pages.count })
    })

  }

  // The off switch, and the only deliberate exit (TB-Page-Lifecycle.md). Registered unconditionally:
  // stopping is a property of the PROCESS, not of a page channel, and the server that most needs its
  // cleanup to run is the one with no channels (a `--no-watch` mirror, whose switcher and composer
  // teardown a Windows kill has never once run). `pages: 'keep'` is a replace handing this address to
  // a successor the tab will reattach to. It answers with what it OBSERVED before the process exits,
  // so the caller reports what happened rather than what it asked for.
  app.use('/__stop', csrfGuard)
  app.post('/__stop', async (c) => {
    // The CSRF guard admits the page's own origin, which is right for a data channel and wrong here:
    // the blast radius is the whole server and no page has a use for it. Anything announcing itself
    // as a browser is refused; the CLI (no such headers) passes.
    if (c.req.header('sec-fetch-site') || c.req.header('origin')) return c.text('Forbidden: browser request', 403)
    // Every caller states it (serverRegistry `stopServer`); closing is the fallback that leaves
    // nothing running.
    let disposition: 'close' | 'keep' = 'close'
    try {
      const body = await c.req.json<{ pages?: unknown }>()
      if (body?.pages === 'keep' || body?.pages === 'close') disposition = body.pages
    } catch { /* no body ⇒ close, above */ }
    const outcome = disposition === 'close' ? await pages.closeAll('stopped') : { told: 0, gone: 0 }
    // After the response flushes: the count is the caller's, the exit is ours.
    if (onStop) setTimeout(() => { void onStop({ pages: disposition }) }, 50)
    return c.json({ closed: outcome.gone, stuck: outcome.told - outcome.gone, exiting: !!onStop })
  })

  // The page count, for the listing that answers "is this bulb actually running" (`typebulb logs`).
  // A read of the one count, off the hot path: probed per row by the listing, never by the registry.
  app.get('/__pages', (c) => c.json({ pages: pages.count }))

  // Re-proxy absolute imports an esm.sh module body emits — they resolve against localhost (the
  // page origin) and 404 without this. Which shapes count lives in isEsmAbsoluteImportPath
  // (esmProxyPaths.ts, runtime-specs/TB-Proxy.md Invariant 3); non-esm paths (/favicon.ico, .map, SPA routes)
  // fall through to a real 404 rather than a silent upstream relay.
  app.notFound(async (c) => {
    if (c.req.method !== 'GET') return c.text('Not Found', 404)
    const reqUrl = new URL(c.req.url)
    if (!isEsmAbsoluteImportPath(reqUrl.pathname, reqUrl.search)) return c.text('Not Found', 404)
    return proxyToUrl(c, 'https://esm.sh' + reqUrl.pathname + reqUrl.search)
  })

  // Bind loopback only. The privileged fs/RPC routes run with the user's full
  // Node/filesystem rights, so the port must never be reachable from the LAN.
  const server = serve({
    fetch: app.fetch,
    port,
    hostname: LOOPBACK,
  })

  // A bind failure arrives as an 'error' event on the underlying http server, never a throw — so
  // wait for `listening` and surface EADDRINUSE as a rejection instead of an uncaught crash. The
  // caller (serveSession) is where it becomes a message naming whoever holds the port.
  if (!server.listening) {
    await new Promise<void>((resolveListen, reject) => {
      const onError = (e: unknown) => reject(e)
      server.once('error', onError)
      server.once('listening', () => { server.removeListener('error', onError); resolveListen() })
    })
  }

  return {
    port,
    close: () => server.close(),
    requestPage,
    closePages: (reason: PageCloseReason) => pages.closeAll(reason),
    pageCount: () => pages.count,
  }
}

function buildProxyResponseHeaders(contentType?: string, cacheControl?: string): Headers {
  const headers = new Headers()
  if (contentType) headers.set('Content-Type', contentType)
  if (cacheControl) headers.set('Cache-Control', cacheControl)
  headers.set('Access-Control-Allow-Origin', '*')
  headers.set('Cross-Origin-Resource-Policy', 'cross-origin')
  return headers
}

/**
 * Register a read-only static-file route: serve bytes from `dir` under the URL prefix
 * `mount`, content-typed and path-traversal guarded. The route globs `mount`'s subtree;
 * the handler re-checks the exact prefix and 404s anything outside it. resolvePath throws
 * on traversal and readFile on a missing file — either way the asset isn't servable → 404.
 * Backs both `--replace`'s `/local/<name>/` route and the agent mirror's bundled-client
 * assets; the global COOP/COEP middleware wraps these responses too, so workers/WASM stay
 * cross-origin isolated.
 */
function serveStaticDir(app: Hono, mount: string, dir: string): void {
  app.get(`${mount}*`, async (c) => {
    const { pathname } = new URL(c.req.url)
    if (!pathname.startsWith(mount)) return c.text('Not Found', 404)
    try {
      return await readServable(decodeURIComponent(pathname.slice(mount.length)), dir) ?? c.text('Not Found', 404)
    } catch {
      return c.text('Not Found', 404)
    }
  })
}

/** The serve-one-file core shared by serveStaticDir and the bulb `/assets/` chain: bytes under
 *  `dir`, content-typed. `undefined` = not there (chains fall through); resolvePath's traversal
 *  throw propagates — the caller owns that refusal. */
async function readServable(rel: string, dir: string, extraHeaders: Record<string, string> = {}): Promise<Response | undefined> {
  const abs = resolvePath(rel, dir)
  const body = await fs.readFile(abs).catch(() => undefined)
  if (!body) return undefined
  return new Response(body as unknown as BodyInit, { headers: { 'Content-Type': contentTypeFor(abs), ...extraHeaders } })
}
