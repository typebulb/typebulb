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
import { normalizeUpstreamError, consumeStreamText, streamAiChunks, buildInferencePrompt, sanitizeJsonOutput, encodeToHash, decodeFromHash, ProviderStreamError } from 'typebulb/ai'
import { parseConfig, splitIntoChunks } from 'typebulb/format'
import { FsProxyCache } from '../deps/cache/fsProxyCache.js'
import { inferModalJs } from '../bulb/inferModalUi.js'
import { recordDenial } from './serverRegistry.js'
import { getFilteredModels, hasOwnKeys } from './modelCatalog.js'
import { resolveLocalProvider, sendTbAi } from './localProvider.js'
import { streamNdjson, toStreamError } from './ndjsonStream.js'
import { resolveServerFn, isAsyncGenerator } from './builtins.js'
import { isEsmAbsoluteImportPath } from './esmProxyPaths.js'

// The CLI is a local tool: the server binds loopback only and is never reachable
// off-machine. Sharing / other-device access is typebulb.com's job, not the CLI's.
const LOOPBACK = '127.0.0.1'

// Hostnames that address THIS machine. Since the server binds loopback only, a
// legitimate request's Host/Origin is always one of these; anything else (e.g. a
// DNS-rebinding domain pointed at 127.0.0.1) addresses us by a name we don't own.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

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
  /** Base for RELATIVE /__fs paths: the bulb's folder, or its --dir subfolder (TB-FS.md). Containment stays
   *  `basePath` (the project), so `../` reaches siblings but never escapes the project.
   *  Absent (agent mirror, older tests) → falls back to basePath, the old cwd-relative rule. */
  fsBase?: string
  port: number
  reloadEmitter?: EventEmitter
  /** Carries `typebulb send` pushes to connected pages as `message` SSE events (TB-CLI.md).
   *  Created unconditionally by the web runner (unlike `reloadEmitter`, which is watch-only) so
   *  send works even under `--no-watch`. Each connected page adds one `message` listener, so its
   *  `listenerCount('message')` is the count `/__send` reports back. */
  messageEmitter?: EventEmitter
  getServerExports?: () => Record<string, Function> | null
  /** The bulb's raw block sources for `tb.infer()` prompt building (TB-Inference.md): `code` is
   *  the TSX source, not transpiled output. A closure over the latest compile, like
   *  `getServerExports`, so hot reload stays fresh. */
  getBulbBlocks?: () => { infer: string; insight: string; code: string; config: string; data: string } | null
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
}

export interface ServerInstance {
  port: number
  close: () => void
}

/** Start the local HTTP server */
export async function startServer(options: ServerOptions): Promise<ServerInstance> {
  const { getHtml, basePath, fsBase, port, reloadEmitter, messageEmitter, getServerExports, getBulbBlocks, saveInferenceResult, localOverride, trusted = false, trustHint, staticAssets } = options
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

  // Diagnostic log — `tb.server.log`. Deliberately NOT a privileged route: it only ever runs the
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
  // `tb.server.log` (data-out): it runs no user code, spends no key, touches no fs, so it crosses no
  // capability boundary and needs no --trust. Still CSRF-guarded like /__log: the CLI (no Origin)
  // passes, a cross-site browser POST is refused, so no other page can inject into the bulb. The
  // body is forwarded verbatim; the shim interprets it (JSON-or-string). Returns the connected-page
  // count so `send` can report delivery — best-effort, never buffered (no listeners ⇒ the agent retries).
  if (messageEmitter) {
    app.use('/__send', csrfGuard)
    app.post('/__send', async (c) => {
      let payload = ''
      try { payload = await c.req.text() } catch { /* empty body ⇒ a bare trigger */ }
      const clients = messageEmitter.listenerCount('message')
      messageEmitter.emit('message', payload)
      return c.json({ clients })
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
      const resolved = resolvePath(reqPath, fsRoot, basePath)
      const data = await fs.readFile(resolved)
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
      const resolved = resolvePath(reqPath, fsRoot, basePath)

      // Ensure parent directory exists
      await fs.mkdir(path.dirname(resolved), { recursive: true })
      await fs.writeFile(resolved, Buffer.from(await c.req.arrayBuffer()))

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
      // transport. Non-streaming tb.ai() keeps buffering to a single { text } (reasoning discarded).
      if (wantStream) {
        return streamNdjson(c, streamAiChunks(response, resolved.protocol))
      }

      const text = await consumeStreamText(response, resolved.protocol)

      if (!text) {
        console.warn('[tb.ai] Empty response from provider')
      }

      return c.json({ text })
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
        if (result.parsed === null) {
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
   *  decoded or null. */
  const decodeHashBody = async (c: Context): Promise<ReturnType<typeof decodeFromHash>> => {
    const { hash } = await c.req.json<{ hash?: string }>().catch(() => ({}) as { hash?: string })
    return typeof hash === 'string' ? decodeFromHash(hash) : null
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

  // Own-keys check — backs tb.hasOwnKeys(); false on failure, the safe gating answer
  app.get('/__has-own-keys', async (c) => {
    try {
      return c.json(await hasOwnKeys())
    } catch {
      return c.json(false, 200)
    }
  })

  // CDN proxy — same-origin serving for Web Workers, WASM, AND all package
  // fetches that the import map routes here. Disk-cached so repeated runs
  // (and offline use) don't re-fetch.
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
  // server. Registered if either channel is active. The message payload is JSON-encoded on the wire
  // so a multi-line value can't break SSE's line framing; the shim JSON-decodes it back.
  if (reloadEmitter || messageEmitter) {
    app.get('/__reload', (c) => {
      return streamSSE(c, async (stream) => {
        const onReload = () => { stream.writeSSE({ event: 'reload', data: '' }) }
        const onMessage = (payload: string) => { stream.writeSSE({ event: 'message', data: JSON.stringify(payload) }) }
        reloadEmitter?.on('reload', onReload)
        messageEmitter?.on('message', onMessage)
        stream.onAbort(() => {
          reloadEmitter?.removeListener('reload', onReload)
          messageEmitter?.removeListener('message', onMessage)
        })

        // Keep connection alive. Checking `aborted` is what lets this coroutine end when the
        // page disconnects — Hono's `sleep` ignores abort, and the stream only closes once
        // this callback returns, so a bare `while (true)` leaks one immortal timer loop per
        // closed EventSource (every hot reload makes one).
        while (!stream.aborted) {
          await stream.sleep(30000)
        }
      })
    })
  }

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

  return {
    port,
    close: () => server.close(),
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
    const rel = decodeURIComponent(pathname.slice(mount.length))
    try {
      const abs = resolvePath(rel, dir)
      const body = await fs.readFile(abs)
      return new Response(body as unknown as BodyInit, { headers: { 'Content-Type': contentTypeFor(abs) } })
    } catch {
      return c.text('Not Found', 404)
    }
  })
}

/**
 * Content type for a file served from the local-override route. `.wasm` must be
 * `application/wasm` for `WebAssembly.instantiateStreaming`.
 */
function contentTypeFor(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.js':
    case '.mjs': return 'text/javascript'
    case '.wasm': return 'application/wasm'
    case '.json':
    case '.map': return 'application/json'
    default: return 'application/octet-stream'
  }
}

/** Resolve a path relative to `basePath`, contained to `containRoot` (default: basePath itself).
 *  The split serves the fs routes: resolution against the bulb's folder, containment
 *  against the project (TB-FS.md) — an ergonomics split, not a widened envelope. */
function resolvePath(requestedPath: string, basePath: string, containRoot = basePath): string {
  const resolved = path.resolve(basePath, requestedPath)

  // Security: ensure resolved path is within base directory. The separator
  // boundary stops a sibling-prefix escape (e.g. base `…/dist` vs `…/dist-evil`).
  const normalizedBase = path.normalize(containRoot)
  const normalizedResolved = path.normalize(resolved)

  if (normalizedResolved !== normalizedBase && !normalizedResolved.startsWith(normalizedBase + path.sep)) {
    throw new Error('Path traversal detected - access denied')
  }

  return resolved
}

/** Find an available port starting from the preferred port, probing loopback so
 *  the check matches the interface the server actually binds. */
export async function findAvailablePort(preferred: number): Promise<number> {
  const net = await import('net')

  return new Promise((resolve) => {
    const server = net.createServer()

    server.listen(preferred, LOOPBACK, () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : preferred
      server.close(() => resolve(port))
    })

    server.on('error', () => {
      // Port in use, try next
      resolve(findAvailablePort(preferred + 1))
    })
  })
}
