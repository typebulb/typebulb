import { readFileSync, writeFileSync, mkdirSync, appendFileSync, rmSync } from 'fs'
import { join, dirname } from 'path'
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'http'
import { type AddressInfo } from 'net'
import { getFilteredModels, catalogFetchError } from '../../../src/servers.js'
import { errorMessage, projectCwd } from '../../core/server/context.js'
import { OPENROUTER_ATTRIBUTION } from 'typebulb/ai'

// ---- agent switcher: which model backs each `claude` launch (TB-Agent-Switcher.md) ----
//
// THE WIRE PROXY. The old design wrote the model into .claude/settings.local.json and hoped CC resolved
// to it — but CC resolves the model it sends through a five-rung ladder, and a settings write owns only
// rung 3, so rungs 1/2/5 routinely sent a model the switcher never chose (the ~$6 Opus-via-OpenRouter
// incident). This design intercepts BELOW the ladder: a local HTTP proxy receives CC's /v1/messages
// request — by which point all five rungs have collapsed into one `model` string — rewrites that string
// to the chosen OpenRouter slug, pins the caching provider, injects the real key, and forwards to
// OpenRouter. Whatever CC resolved, OpenRouter only ever sees the model we chose. The desync becomes
// structurally impossible, not merely alarmed.
//
// CC is pointed at the proxy via ANTHROPIC_BASE_URL = http://127.0.0.1:<port>, written ONLY while an
// override is active (default = no base URL, proxy idle, normal claude path untouched). Switching among
// models is proxy-internal state with zero per-switch settings writes — no more "blinking" config. The
// proxy relays CC's own request; it originates no inference and never calls the Claude SDK (Invariant 1).
//
// OpenRouter only: it's the one provider whose wire shape matches the Anthropic Messages API at a base
// URL. Project scope only: the override is project-local and gitignored. The real OpenRouter key is held
// by the proxy and injected per-request — it never lands in CC's settings (a security win over the old
// design, which wrote it into the env block).

const UPSTREAM_BASE_URL = 'https://openrouter.ai/api'
const UPSTREAM_MESSAGES = `${UPSTREAM_BASE_URL}/v1/messages`

// CC needs *some* auth value to attach to a custom base URL; this placeholder satisfies that. The proxy
// ignores it entirely and injects the real OPENROUTER_API_KEY, so the real key never sits in settings.
const PLACEHOLDER_TOKEN = 'typebulb-proxy-managed'

// THE LIFECYCLE INVARIANT: never invalidate a route a running CC process may still hold. The proxy is
// born on the first model pick and lives until the mirror stops — switch and revert NEVER tear it down.
// Every disaster the old lifecycle caused was the route changing under a live session: revert killed the
// proxy, so a VS Code extension host that had already adopted the base URL then dialled a dead port and
// hung for minutes. Now revert only removes the base URL from the FILE (so the next launch/reload is
// clean) and leaves the listener up; a stale session that still points here gets REVERTED_MSG instantly
// instead of a dead socket. The irreducible residue — a *live* extension session can't return to your
// Anthropic subscription without a window reload (CC drops out of OAuth the moment any base URL is set) —
// is a platform limit, surfaced as a clear instruction rather than a silent failure.
const REVERTED_MSG =
  'The typebulb model override was reverted to Anthropic, but this Claude Code session still points at the ' +
  'now-idle proxy. Reload the window (VS Code/Cursor: “Developer: Reload Window”) or relaunch `claude` in a ' +
  'terminal to return to your Anthropic subscription.'

// The only settings keys we ever write — snapshotting exactly these (and nothing else) keeps revert
// surgical. Down from the old design's seven: the model and the real key are gone (the proxy holds the
// model at the wire and injects the key per-request), so only the route + a placeholder token remain.
const PROXY_KEYS = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN'] as const

// A turn that billed this many fresh input tokens with no cache read/write was genuinely served
// uncached — the floor keeps a tiny first prompt (legitimately cache-less) from reading as a leak.
const UNCACHED_MIN_TOKENS = 5000

// The reasoning dial (TB-Agent-Switcher.md reasoning appendix). CC-CALIBRATED to Claude Code's own effort
// range: low/medium/high(/max), default medium for Opus. Routing through OpenRouter we map onto OpenRouter's
// own `reasoning.effort` enum — itself low/medium/high — so we match NOMINALLY on those three (the label IS
// the wire value). We drop CC's `max` (Anthropic/Opus-only → collapses to high on OpenRouter). `low` is the
// floor, never the off state (`effort:"none"`/`enabled:false`), which 400s mandatory-reasoning slugs (some
// DeepSeek/Grok/Step). (This is a route-global base level, distinct from typebulb's per-call `effort` dial.)
const EFFORT = ['low', 'medium', 'high'] as const

const settingsLocalPath = (cwd: string) => join(cwd, '.claude', 'settings.local.json')
// Pre-switcher snapshot + the live override (model + pinned provider), so a revert restores exactly and
// a hard-crash boot can re-adopt. Beside the settings file, also gitignored.
const switcherSidecarPath = (cwd: string) => join(cwd, '.claude', '.cc-switcher.json')
const proxyUrlFor = (port: number) => `http://127.0.0.1:${port}`

function readJsonFile(p: string): any | null {
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null }
}
function writeJsonFile(p: string, obj: unknown) {
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(obj, null, 2) + '\n')
}

// Append entries to the project .gitignore if missing — so a token at rest can never be committed.
function ensureGitignored(cwd: string, entries: string[], comment: string) {
  const gi = join(cwd, '.gitignore')
  let cur = ''
  try { cur = readFileSync(gi, 'utf8') } catch { /* no .gitignore yet */ }
  const have = new Set(cur.split(/\r?\n/).map(l => l.trim()))
  const missing = entries.filter(e => !have.has(e))
  if (!missing.length) return
  const prefix = cur && !cur.endsWith('\n') ? '\n' : ''
  try { appendFileSync(gi, prefix + comment + '\n' + missing.join('\n') + '\n') }
  catch (err) { console.error('[switcher] .gitignore update failed', errorMessage(err)) }
}

// OpenRouter resells Anthropic's OWN models (anthropic/claude-*) at full API rate with no caching —
// the single most expensive way to run a model you already have on subscription. Excluded from the menu
// AND refused on set; the proxy also rewrites any Anthropic model CC resolves to the chosen alt slug, so
// even a rung-1/rung-5 desync can't ride the route. Belt, braces, and a wire-level backstop.
const isAnthropicSlug = (name: string) => /^anthropic\//i.test(name) || /claude/i.test(name)

// ---- live proxy state (module-scoped — this is the source of truth, not the settings file) ----
let proxyServer: Server | null = null
let proxyPort: number | null = null
let activeModel: string | null = null            // the slug the proxy rewrites every request to
let pinnedProvider: string | null = null         // the caching provider to pin (from a probe), or null
let routedModel: string | null = null            // the model CC last SENT (pre-rewrite) — drives the "rewrote Opus" cue
let lastCaching: 'live' | 'uncached' | 'unknown' = 'unknown' // observed from the last response's usage
let reasoningLevel: number | null = 1            // index into EFFORT (low/medium/high); default medium = CC's Opus default (null = inject nothing)
const probedProvider: Record<string, string> = {} // model → provider a probe found caches, fed to the pin

// ---- the proxy ----

const num = (v: unknown) => (typeof v === 'number' ? v : 0)

// Pin OpenRouter to one provider with no fallback — the same shape used by the live forward and the probe,
// in one place so they can't drift (a forgotten `allow_fallbacks` would silently re-enable the routing lottery).
const providerPin = (p: string) => ({ order: [p], allow_fallbacks: false })

// Read the streamed/buffered response usage to set the live caching cue. cache_read > 0 means a cache
// hit; cache_creation > 0 means it wrote the cache this turn (caching works, reads next turn) — both
// count as "live". A substantial turn with neither was served uncached (the route ignored cache_control).
//
// CAVEAT (don't re-investigate — caching IS working when this can't see it): some providers behind
// OpenRouter (e.g. GLM/Alibaba) stream `usage` with the cache fields null, so this stays at 'unknown' even
// while real turns cache ~90%+. The true per-turn numbers live only in OpenRouter's post-hoc generation
// record — verify caching THERE (a single generation's `native_tokens_cached`), never from the dashboard's
// per-row input/cost summaries (an already-discounted turn reads as full-rate and looks uncached).
function noteUsage(text: string) {
  const matchInt = (re: RegExp) => { const m = re.exec(text); return m ? Number(m[1]) : 0 }
  const read = matchInt(/"cache_read_input_tokens":\s*(\d+)/)
  const created = matchInt(/"cache_creation_input_tokens":\s*(\d+)/)
  const input = matchInt(/"input_tokens":\s*(\d+)/)
  if (read > 0 || created > 0) lastCaching = 'live'
  else if (input > UNCACHED_MIN_TOKENS) lastCaching = 'uncached'
  // else: too small to judge — leave the prior verdict.
}

// Forward headers built from scratch: keep CC's anthropic-version + anthropic-beta (the route may use or
// ignore them), drop hop-by-hop / host / content-length (refetch sets length), REPLACE auth with the real
// OpenRouter key (CC's placeholder token is discarded here), and add OpenRouter's app attribution: this
// proxy, not CC, is the client on the wire.
function upstreamHeaders(req: IncomingMessage, key: string): Record<string, string> {
  const h: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${key}`,
    'anthropic-version': (req.headers['anthropic-version'] as string) || '2023-06-01',
    ...OPENROUTER_ATTRIBUTION,
  }
  const beta = req.headers['anthropic-beta']
  if (typeof beta === 'string') h['anthropic-beta'] = beta
  return h
}

// A reasoning model behind OpenRouter (GLM, DeepSeek, …) emits `thinking`/`redacted_thinking` content
// blocks whose payload is OpenRouter's own encoding (`data: "openrouter.reasoning:…"`), NOT a valid
// Anthropic-signed block. We strip those blocks out of the response stream so they never enter CC's
// transcript (see sanitizeEventStream) — but a session poisoned before this fix still has them on disk,
// and CC replays them. Anthropic (after a revert) and even some OpenRouter providers then reject the
// history with "Unsupported content type: redacted_thinking". So we ALSO strip them from every outbound
// request: existing poisoned sessions self-heal, and the model never round-trips foreign reasoning.
function stripReasoningFromMessages(body: any) {
  if (!Array.isArray(body?.messages)) return
  for (const m of body.messages) {
    if (!Array.isArray(m?.content)) continue
    const kept = m.content.filter((b: any) => b?.type !== 'thinking' && b?.type !== 'redacted_thinking')
    if (kept.length && kept.length !== m.content.length) m.content = kept // keep ≥1 block (empty content is invalid)
  }
}

// Rewrite the request body: force the model to the active slug (this is the load-bearing line — it
// overrides whatever rung 1/2/3/4/5 resolved, including a desynced Opus), inject the OpenRouter provider
// pin so caching is deterministic for CC's real turns (the thing settings could never do), and scrub any
// reasoning blocks/params so the route never sees foreign thinking. The pre-rewrite model is recorded as
// routedModel for the "CC resolved X → routed to Y" cue.
function rewriteBody(raw: string): string {
  let body: any
  try { body = JSON.parse(raw) } catch { return raw } // not JSON we understand — forward as-is
  routedModel = typeof body?.model === 'string' ? body.model : null
  if (activeModel) body.model = activeModel
  if (pinnedProvider) body.provider = providerPin(pinnedProvider)
  // The reasoning dial → OpenRouter's `reasoning.effort`: the switcher dial is the BASE level for the route
  // (never `enabled:false`/`none` — the mandatory-reasoning 400). Per-turn `ultrathink` needs NO handling
  // here: CC doesn't encode it as a param, it renders it as a system-reminder *message* ("…requested
  // reasoning effort level: high. Apply this to the current turn.") which rides through untouched in
  // `messages`, so the routed model gets the same soft per-turn nudge native CC gives an adaptive model.
  // That IS parity — we deliberately don't hard-bump effort per turn (native doesn't either; a per-turn
  // param flip would also thrash the cache). Subagents never carry that reminder (their prompts are seeded
  // past the keyword scan), so they always run at the base — no per-agent branch needed.
  //
  // CC's own resolved effort (`output_config.effort`) is for the Anthropic model we just overrode, so it's
  // dropped, not read. The only differentiation the wire affords is the model CLASS CC resolved
  // (`routedModel`, pre-rewrite) — used to spare haiku-class background calls (titles, summaries) the dial,
  // since those are deliberately cheap. Per-class tuning beyond this is the tier-aware extension.
  const isBackgroundClass = /haiku/i.test(routedModel || '')
  if (reasoningLevel != null && !isBackgroundClass) body.reasoning = { effort: EFFORT[reasoningLevel] }
  delete body.thinking
  if (body.output_config) delete body.output_config.effort
  stripReasoningFromMessages(body)
  return JSON.stringify(body)
}

// Strip reasoning content blocks out of CC's SSE response stream. GLM/DeepSeek/etc. behind OpenRouter
// emit `thinking` and `redacted_thinking` blocks regardless of the request; left in, they land in CC's
// transcript and poison the history (the "Unsupported content type: redacted_thinking" failures, in the
// proxied session AND after a revert to Anthropic). We drop those blocks and RE-INDEX the survivors so
// CC sees a contiguous, text/tool-only message — the indices it assembles against stay 0,1,2,….
//
// Anthropic SSE is `event: <type>\n` + `data: <json>\n\n` per event. We keep a per-response map from the
// upstream block index to its rewritten index (or null = dropped); start/delta/stop for a dropped index
// emit nothing. Non-block events (message_start/delta/stop, ping, the terminal `[DONE]`) pass through.
function makeStreamSanitizer() {
  let buf = ''
  let outIndex = 0
  const map = new Map<number, number | null>() // upstream idx → output idx, or null when dropped
  const DROP = new Set(['thinking', 'redacted_thinking'])

  const transform = (event: string): string | null => {
    const dataLine = /^data: (.*)$/m.exec(event)
    if (!dataLine) return event
    let obj: any
    try { obj = JSON.parse(dataLine[1]) } catch { return event } // e.g. `data: [DONE]` — pass through
    switch (obj.type) {
      case 'message_start': { map.clear(); outIndex = 0; return event }
      case 'content_block_start': {
        if (DROP.has(obj.content_block?.type)) { map.set(obj.index, null); return null }
        const n = outIndex++; map.set(obj.index, n); obj.index = n
        return `event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`
      }
      case 'content_block_delta':
      case 'content_block_stop': {
        const mapped = map.get(obj.index)
        if (mapped === null || mapped === undefined) return null // dropped block, or one we never opened
        obj.index = mapped
        return `event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`
      }
      default: return event // message_delta/message_stop/ping/error
    }
  }

  // Feed a decoded chunk; return the rewritten chunk to forward (whole events only; partial tail buffered).
  return (chunk: string): string => {
    buf += chunk
    let out = ''
    let sep: number
    while ((sep = buf.indexOf('\n\n')) !== -1) {
      const event = buf.slice(0, sep)
      buf = buf.slice(sep + 2)
      if (!event.trim()) continue
      const t = transform(event)
      if (t !== null) out += t
    }
    return out
  }
}

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
}

// Anthropic-shaped error response — CC parses `{ type:'error', error:{ type, message } }` and keys its
// render/retry on `error.type` (it doesn't retry 4xx). One helper so every refusal on the route speaks the
// same shape; the writableEnded guard makes it safe to call from a half-streamed response.
function sendError(res: ServerResponse, status: number, type: string, message: string) {
  if (res.writableEnded) return
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ type: 'error', error: { type, message } }))
}

async function handleMessages(req: IncomingMessage, res: ServerResponse, raw: string) {
  // Reverted, but a stale session still points here: fail FAST and CLEAR, never forward. A 400
  // invalid_request_error surfaces immediately (CC doesn't retry 4xx), so there's no dead-port hang and
  // no silently-billed OpenRouter turn — just the reload instruction. This is the heart of the fix.
  if (!activeModel) { sendError(res, 400, 'invalid_request_error', REVERTED_MSG); return }

  const key = process.env.OPENROUTER_API_KEY
  if (!key) { sendError(res, 401, 'authentication_error', 'OPENROUTER_API_KEY not set in the typebulb proxy'); return }

  // Propagate CC's cancel (Esc) upstream so an aborted turn stops billing tokens.
  const ctrl = new AbortController()
  res.on('close', () => { if (!res.writableEnded) ctrl.abort() })

  let upstream: Response
  try {
    upstream = await fetch(UPSTREAM_MESSAGES, {
      method: 'POST', headers: upstreamHeaders(req, key), body: rewriteBody(raw), signal: ctrl.signal,
    })
  } catch (e) {
    sendError(res, 502, 'api_error', `proxy upstream failed: ${errorMessage(e)}`)
    return
  }

  const ct = upstream.headers.get('content-type') || 'application/json'
  res.writeHead(upstream.status, { 'content-type': ct })
  if (!upstream.body) { res.end(); return }

  // Sanitize reasoning blocks out of CC's transcript only on the SSE happy path; an error/non-stream body
  // (JSON, no event framing) is piped verbatim so OpenRouter's error reaches CC unmangled.
  const isStream = ct.includes('event-stream')
  const reader = upstream.body.getReader()
  const decoder = new TextDecoder()
  const sanitize = isStream ? makeStreamSanitizer() : null
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      if (sanitize) {
        const text = decoder.decode(value, { stream: true })
        noteUsage(text)
        const cleaned = sanitize(text)
        if (cleaned) res.write(cleaned)
      } else {
        res.write(Buffer.from(value))
      }
    }
  } catch { /* aborted or upstream hiccup — end what we have */ }
  finally { if (!res.writableEnded) res.end() }
}

async function handleCountTokens(req: IncomingMessage, res: ServerResponse, raw: string) {
  const key = process.env.OPENROUTER_API_KEY
  // Best-effort: forward with the model rewritten; if the route can't count tokens, synthesise a rough
  // estimate so CC's context gauge degrades gracefully rather than erroring.
  const synth = () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ input_tokens: Math.max(1, Math.ceil(raw.length / 4)) })) }
  if (!activeModel) return synth() // reverted — degrade to a local estimate, never forward CC's Anthropic model to OpenRouter
  if (!key) return synth()
  try {
    const r = await fetch(`${UPSTREAM_MESSAGES}/count_tokens`, { method: 'POST', headers: upstreamHeaders(req, key), body: rewriteBody(raw) })
    if (!r.ok) return synth()
    const text = await r.text()
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(text)
  } catch { synth() }
}

function proxyHandler(req: IncomingMessage, res: ServerResponse) {
  const url = req.url || '/'
  // CC sends a HEAD / preflight to the base URL before the first call — answer it so it proceeds.
  if (req.method === 'HEAD') { res.writeHead(200); res.end(); return }
  if (req.method !== 'POST') { sendError(res, 404, 'not_found_error', url); return }
  void readRequestBody(req).then((raw) => {
    if (url.includes('count_tokens')) return handleCountTokens(req, res, raw)
    if (url.includes('/v1/messages')) return handleMessages(req, res, raw)
    sendError(res, 404, 'not_found_error', url)
  })
}

// Bind the proxy on an ephemeral port (once). Idempotent — switching models reuses the live listener.
function ensureProxy(): Promise<number> {
  if (proxyServer && proxyPort) return Promise.resolve(proxyPort)
  return new Promise((resolve, reject) => {
    const srv = createServer(proxyHandler)
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      proxyServer = srv
      proxyPort = (srv.address() as AddressInfo).port
      console.log(`[switcher] wire proxy listening on ${proxyUrlFor(proxyPort)}`)
      resolve(proxyPort)
    })
  })
}

function stopProxy() {
  try { proxyServer?.close() } catch { /* best-effort */ }
  proxyServer = null; proxyPort = null
}

// ---- settings + sidecar I/O (the surgical merge contract) ----

// Write the route into settings (snapshotting the two managed keys once). Skips the write entirely when
// the base URL already points at this proxy — so switching models touches no config (the spec's
// zero-per-switch-write promise).
function writeProxySettings(cwd: string, port: number) {
  const sp = settingsLocalPath(cwd)
  const existing = readJsonFile(sp)
  const settings = existing || {}
  if (!settings.env || typeof settings.env !== 'object') settings.env = {}
  if (settings.env.ANTHROPIC_BASE_URL === proxyUrlFor(port) && settings.env.ANTHROPIC_AUTH_TOKEN) return

  const scp = switcherSidecarPath(cwd)
  const sidecar = readJsonFile(scp)
  if (!sidecar) {
    const snapshot: Record<string, string | null> = {}
    for (const k of PROXY_KEYS) snapshot[k] = k in settings.env ? settings.env[k] : null
    writeJsonFile(scp, { managedBy: 'agent-switcher', fileExisted: existing !== null, snapshot, active: null })
  }
  settings.env.ANTHROPIC_BASE_URL = proxyUrlFor(port)
  settings.env.ANTHROPIC_AUTH_TOKEN = PLACEHOLDER_TOKEN
  writeJsonFile(sp, settings)
  ensureGitignored(cwd, ['.claude/settings.local.json', '.claude/.cc-switcher.json'],
    '# agent switcher (local Claude Code model override)')
}

// Record the live override in the sidecar so a hard-crash boot can re-adopt it.
function writeSidecarActive(cwd: string, model: string, provider: string | null) {
  const scp = switcherSidecarPath(cwd)
  const sidecar = readJsonFile(scp) || { managedBy: 'agent-switcher', fileExisted: false, snapshot: {} }
  sidecar.active = { model, provider }
  writeJsonFile(scp, sidecar)
}

// Restore the two managed keys to their snapshot (or delete if absent), drop an emptied env, delete a
// file that was ours alone, remove the sidecar. A set→revert round-trip leaves a pre-existing file
// byte-identical. Synchronous so it can run from process shutdown.
function revertSettings(cwd: string) {
  const sp = settingsLocalPath(cwd)
  const scp = switcherSidecarPath(cwd)
  const sidecar = readJsonFile(scp)
  const settings = readJsonFile(sp)
  if (settings?.env) {
    const snap: Record<string, string | null> = sidecar?.snapshot || {}
    for (const k of PROXY_KEYS) {
      const prev = snap[k]
      if (prev === null || prev === undefined) delete settings.env[k]
      else settings.env[k] = prev
    }
    if (Object.keys(settings.env).length === 0) delete settings.env
    if (sidecar?.fileExisted === false && Object.keys(settings).length === 0) {
      try { rmSync(sp, { force: true }) } catch { /* best-effort */ }
    } else {
      writeJsonFile(sp, settings)
    }
  }
  try { rmSync(scp, { force: true }) } catch { /* best-effort */ }
}

// ---- RPC surface ----

// The OpenRouter model menu + whether a key is present (drives the no-key "unlock" row). The catalog
// filter reads process.env, so a key added via saveOpenRouterKey shows up without relaunch.
export async function listSwitchModels() {
  const hasKey = !!process.env.OPENROUTER_API_KEY
  let models: { id: string; label: string }[] = []
  try {
    models = (await getFilteredModels())
      .filter(m => m.provider === 'openrouter' && !isAnthropicSlug(m.name))
      .map(m => ({ id: m.name, label: m.friendlyName || m.name }))
  } catch (err) { console.error('[switcher] model list failed', errorMessage(err)) }
  // Surface a fetch failure only when it left the menu empty, so it reads as "couldn't load" rather
  // than a bare "no models"; a populated (stale-cache) list needs no warning.
  const error = models.length ? undefined : catalogFetchError() ?? undefined
  return { hasKey, models, error }
}

// The authoritative live state — read from the proxy itself (module state), not inferred from a stale
// transcript. `active` ⇒ the proxy is routing; `routedModel` is what CC last sent (an Anthropic value
// here means the proxy caught a desync and rewrote it); `caching` is observed from the last response.
// Only when NOT active does it touch the file, to surface a base URL set outside this tool.
export async function switchState() {
  if (proxyServer && activeModel) {
    return { active: true, managed: true, model: activeModel, port: proxyPort, provider: pinnedProvider,
      routedModel, caching: lastCaching, reasoning: reasoningLevel, externalBaseUrl: null as string | null }
  }
  const env = readJsonFile(settingsLocalPath(projectCwd))?.env || {}
  return { active: false, managed: false, model: null as string | null, port: null as number | null,
    provider: null as string | null, routedModel: null as string | null, caching: 'unknown' as const,
    reasoning: reasoningLevel, externalBaseUrl: (env.ANTHROPIC_BASE_URL as string) || null }
}

// Bind/refresh the route: ensure the listener is up, point the in-proxy state at `model` on `provider`, and
// (re)write the base URL to the live port. The single home for the activation sequence — shared by a fresh
// switch (setSwitchModel) and boot re-adoption (reconcile). Returns the live port.
async function bindRoute(model: string, provider: string | null): Promise<number> {
  const port = await ensureProxy()
  activeModel = model
  pinnedProvider = provider
  writeProxySettings(projectCwd, port)
  return port
}

// Set (or switch to) a model. First activation binds the proxy and writes the route; subsequent switches
// only update the in-proxy model (no settings write). Refuses an Anthropic slug — the menu never offers
// one, and even if it did, routing it through OpenRouter is the full-rate footgun.
export async function setSwitchModel({ model }: { model: string }) {
  if (!process.env.OPENROUTER_API_KEY) return { ok: false, error: 'OPENROUTER_API_KEY not set — add a key first' }
  if (!model) return { ok: false, error: 'no model given' }
  if (isAnthropicSlug(model)) return { ok: false, error: 'Refusing to route an Anthropic model through OpenRouter — that bills full API rate with no caching. Use it on your Anthropic subscription instead.' }
  try {
    await bindRoute(model, probedProvider[model] ?? null)
    routedModel = null
    lastCaching = 'unknown'
    writeSidecarActive(projectCwd, model, pinnedProvider)
  } catch (err) {
    return { ok: false, error: `failed to start the wire proxy: ${errorMessage(err)}` }
  }
  return { ok: true }
}

// The reasoning dial: set the global effort level (0–3) the proxy injects on every forward, or null to
// inject nothing (model default). One setting for the whole route — not per-model (that's the tier-aware
// extension). Proxy-internal state, no settings write; takes effect on the next turn. Authoritative over
// CC's per-turn think/ultrathink — see rewriteBody.
export async function setReasoning({ level }: { level: number | null }) {
  if (level != null && (!Number.isInteger(level) || level < 0 || level >= EFFORT.length))
    return { ok: false, error: `reasoning level must be 0–${EFFORT.length - 1} or null` }
  reasoningLevel = level
  return { ok: true, level }
}

// Revert to Anthropic: remove the route from the file and clear the in-proxy model — but DELIBERATELY
// leave the listener running (the lifecycle invariant; see REVERTED_MSG). A new launch/reload reads the
// cleaned file and goes straight to Anthropic; a stale session still pointing here hits the fast, clear
// `!activeModel` guard in handleMessages instead of a dead port. The proxy is reaped only at mirror
// shutdown (shutdownSwitcher). Re-activating later reuses the SAME listener/port, so the extension's
// cached base URL stays valid across a revert→re-switch with no settings churn.
export async function clearSwitchModel() {
  revertSettings(projectCwd)
  activeModel = null; pinnedProvider = null; routedModel = null; lastCaching = 'unknown'
  return { ok: true }
}

// No-key unlock: persist a typed OpenRouter key into the project .env (where keys live; gitignored), and
// into THIS process so the catalog filter populates the menu without a relaunch.
export async function saveOpenRouterKey({ key }: { key: string }) {
  const k = (key || '').trim()
  if (!k) return { ok: false, error: 'empty key' }
  const cwd = projectCwd
  const envPath = join(cwd, '.env')
  let cur = ''
  try { cur = readFileSync(envPath, 'utf8') } catch { /* no .env yet */ }
  try {
    if (/^\s*OPENROUTER_API_KEY\s*=/m.test(cur)) {
      writeFileSync(envPath, cur.replace(/^\s*OPENROUTER_API_KEY\s*=.*$/m, `OPENROUTER_API_KEY=${k}`))
    } else {
      const prefix = cur && !cur.endsWith('\n') ? '\n' : ''
      appendFileSync(envPath, prefix + `OPENROUTER_API_KEY=${k}\n`)
    }
  } catch (err) {
    return { ok: false, error: errorMessage(err) }
  }
  process.env.OPENROUTER_API_KEY = k
  ensureGitignored(cwd, ['.env'], '# secrets')
  return { ok: true }
}

// Called from the mirror's process shutdown (serve.ts cleanup): fail-SAFE — remove the route so a closed
// mirror never leaves CC pointed at a dead proxy port. A hard crash skips this; boot reconciliation
// (below) recovers that case by re-binding.
export function shutdownSwitcher() {
  if (!proxyServer && !activeModel) return
  try { revertSettings(projectCwd) } catch { /* best-effort */ }
  stopProxy()
}

// ---- model probe (TB-Agent-Switcher.md): is a model callable for you, and which provider caches? ----
//
// Two questions the catalog can't answer: (1) is it callable on YOUR key right now — or blocked by auth,
// credits, or (the common surprise) OpenRouter's data-policy refusal of training-only models? (2) which
// provider actually caches on this route? probeModel answers both empirically by hitting the EXACT path
// CC uses (<base>/v1/messages, Bearer) with a large cache_control'd prefix sent TWICE: the first writes
// the cache, the second (pinned to the provider the first used) should read it. Real, paid calls — an
// explicit per-row click (disclosed spend, which Invariant 2 permits), never auto-run. The provider it
// confirms caching on is REMEMBERED (probedProvider) and pinned by the proxy on every forward — so the
// probe doesn't just answer "does it ever cache for me", it locks CC to the provider where it does.

const DATA_POLICY_RE = /data policy|no endpoints|no allowed providers|privacy|requires.*(training|logging|data)/i
function classifyProbeError(status: number, raw: string): string {
  if (DATA_POLICY_RE.test(raw)) return 'blocked by your OpenRouter data policy'
  if (status === 401 || status === 403 || /unauthor|invalid api key|no auth|forbidden/i.test(raw))
    return 'auth rejected — check your OpenRouter key'
  if (status === 404 || /not a valid model|no such model|unknown model|model not found/i.test(raw))
    return 'model not found on this route'
  if (status === 429 || /rate limit/i.test(raw)) return 'rate limited'
  if (status === 402 || /insufficient|credit|quota|balance/i.test(raw)) return 'out of credits / quota'
  return raw.slice(0, 160)
}
function probeRestrictionHint(raw: string): string | undefined {
  if (DATA_POLICY_RE.test(raw))
    return "This model's only provider(s) require prompt logging/training, which your OpenRouter account disallows by default. Allow it (or that provider) at openrouter.ai/settings/privacy, then probe again."
  return undefined
}

// The caching verdict from the warm (2nd) probe call: did the cache_control'd prefix read back? `ok=false`
// means the re-test itself failed (verdict unknown); a route that reports no cache fields at all is treated
// as almost-certainly-uncached; reported-but-zero is a clean no; read > 0 confirms it.
function cachingVerdict(ok: boolean, usage: any, provider?: string): { works: boolean | null; read: number; note: string } {
  if (!ok) return { works: null, read: 0, note: provider ? `couldn't re-test on ${provider} — caching unconfirmed` : 'caching unconfirmed' }
  const read = num(usage?.cache_read_input_tokens) || num(usage?.prompt_tokens_details?.cached_tokens)
  const reportsCacheField = usage?.cache_read_input_tokens !== undefined
    || usage?.cache_creation_input_tokens !== undefined || usage?.prompt_tokens_details !== undefined
  if (read > 0) return { works: true, read, note: `${read} tokens read from cache on the 2nd call` }
  if (!reportsCacheField) return { works: null, read, note: "route doesn't report cache usage — caching almost certainly not honored" }
  return { works: false, read, note: 'no cache reads after a warm call — every turn re-bills the full context' }
}

export async function probeModel({ model }: { model: string }) {
  const token = process.env.OPENROUTER_API_KEY
  if (!token) return { ok: false, error: 'OPENROUTER_API_KEY not set — add a key first' }
  if (!model) return { ok: false, error: 'no model given' }
  if (isAnthropicSlug(model)) return { ok: false, error: 'Anthropic model — not offered or probed via OpenRouter' }
  const t0 = Date.now()
  const FILLER = Array(350).fill(
    'Caching probe filler sentence; its only purpose is to exceed the prompt-cache minimum token threshold.'
  ).join(' ')
  const headers: Record<string, string> = {
    'content-type': 'application/json', authorization: `Bearer ${token}`, 'anthropic-version': '2023-06-01',
  }
  const baseReq = {
    // OpenAI requires max_output_tokens >= 16; OpenRouter's Anthropic-skin maps max_tokens straight
    // through, so a smaller value 400s every GPT slug ("Provider returned error") while other providers
    // accept it. 64 clears the floor and leaves a reasoning model room to still emit the "ok" sample.
    model, max_tokens: 64,
    system: [{ type: 'text', text: FILLER, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: 'Reply with exactly: ok' }],
  }
  const call = async (pin?: string) => {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 20000)
    try {
      const reqBody = JSON.stringify(pin ? { ...baseReq, provider: providerPin(pin) } : baseReq)
      const r = await fetch(UPSTREAM_MESSAGES, { method: 'POST', signal: ctrl.signal, headers, body: reqBody })
      const j: any = await r.json().catch(() => ({}))
      return { r, j }
    } finally { clearTimeout(timer) }
  }
  try {
    const { r, j } = await call()
    if (!r.ok) {
      const rawErr = j?.error?.message || j?.message || JSON.stringify(j).slice(0, 300)
      return { ok: true, callable: false, status: r.status, ms: Date.now() - t0,
        error: classifyProbeError(r.status, rawErr), restriction: probeRestrictionHint(rawErr) }
    }
    const provider: string | undefined = typeof j?.provider === 'string' ? j.provider : undefined
    const sample = j?.content?.find?.((c: any) => c.type === 'text')?.text ?? j?.content?.[0]?.text ?? 'ok'
    const created = num(j?.usage?.cache_creation_input_tokens)
    const { r: r2, j: j2 } = await call(provider)
    const { works, read, note } = cachingVerdict(r2.ok, j2?.usage, provider)
    // Remember a confirmed-caching provider so the proxy can pin CC's traffic to it. If this model is the
    // live one, update the pin immediately.
    if (works === true && provider) {
      probedProvider[model] = provider
      if (activeModel === model) pinnedProvider = provider
    }
    return { ok: true, callable: true, status: r.status, ms: Date.now() - t0, provider,
      sample: String(sample).trim().slice(0, 60), cache: { works, created, read, note } }
  } catch (e) {
    const msg = errorMessage(e)
    return { ok: true, callable: false, ms: Date.now() - t0, error: /abort/i.test(msg) ? 'timed out (20s)' : msg }
  }
}

// ---- boot reconciliation (crash recovery) ----
// A clean shutdown reverts (shutdownSwitcher), so a normal restart finds no override and starts fresh.
// But a hard crash leaves the route in settings pointing at a now-dead port. On load, if the sidecar
// still records a live override, re-bind the proxy on a fresh port and rewrite the route — so a crashed
// mid-override mirror recovers itself instead of stranding future launches on a dead port.
void (async function reconcile() {
  try {
    const sidecar = readJsonFile(switcherSidecarPath(projectCwd))
    const model: string | undefined = sidecar?.active?.model
    if (!model) return
    const env = readJsonFile(settingsLocalPath(projectCwd))?.env || {}
    const bu: string = env.ANTHROPIC_BASE_URL || ''
    if (!/127\.0\.0\.1|localhost/.test(bu)) return // not our proxy route — leave external settings alone
    const port = await bindRoute(model, sidecar.active.provider ?? probedProvider[model] ?? null)
    console.log(`[switcher] re-adopted override after restart: ${model} via ${proxyUrlFor(port)}`)
  } catch (err) {
    console.error('[switcher] boot reconcile failed', errorMessage(err))
  }
})()
