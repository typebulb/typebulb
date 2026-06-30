/**
 * Browser-safe bulb→HTML renderer — the same parse→compile→resolve→renderHtml
 * pipeline the CLI server runs per request, minus the HTTP/Node layer, exposed
 * as one function. Lets a bulb embed another bulb (typebulb.com already runs
 * every bulb this way in-browser; this is that operation called one level down).
 *
 * Self-contained on purpose: this is the package's browser entry, so esbuild
 * bundles it (no bare imports) — that's also what makes it `--replace`-able.
 */

import { parseBulb, toLocalBulb, parseDataChunks, parseConfig } from './bulb/bulbParser.js'
import { transpile } from 'typebulb/transpile'
import { lint } from 'typebulb/lint'
import { summarizeLint } from './bulb/lintGate.js'
import { renderHtml } from './bulb/template.js'
import { createResolver, type PackageCache } from 'typebulb/resolver'
import { fetchHttpClient } from './deps/fetchHttpClient.js'

// Pure bulb-source helpers, re-exported on the browser entry so a host embedding
// bulbs (code-view, copy, breakout) needn't re-derive frontmatter parsing.
export { bulbName, slugifyBulbName, stripFrontmatter } from './bulb/source.js'
// Structural validation (unterminated-fence detection), re-exported so a host can flag a malformed
// embed that still rendered — same reason: it shouldn't re-derive the block grammar. `parseBulb` rides
// along so a host can structurally test whether an arbitrary fence body *is* a bulb (mislabel tolerance).
export { validateBulbStructure, parseBulb, findEmbeddedBulbs } from './bulb/bulbParser.js'

export interface RenderBulbResult {
  /** Complete standalone HTML document, ready for an iframe srcdoc. */
  html?: string
  /** Set instead of `html` when the source couldn't be rendered. */
  error?: string
}

// The Node CLI persists resolver metadata to ~/.typebulb/cache; in the browser
// a per-session Map is enough — esm.sh metadata is cheap and the page is short-lived.
function memoryCache(): PackageCache {
  const pinned = new Map<string, string>()
  const index = new Map<string, { versions: string[]; distTags?: Record<string, string>; updatedAt: number }>()
  const negative = new Set<string>()
  const meta = new Map<string, { dependencies?: Record<string, string>; peerDependencies?: Record<string, string>; peerDependenciesMeta?: Record<string, { optional?: boolean }>; updatedAt: number }>()
  return {
    async getPinnedExact(n, r) { return pinned.get(`${n}@${r}`) },
    async setPinnedExact(n, r, e) { pinned.set(`${n}@${r}`, e) },
    async getIndex(n) { return index.get(n) },
    async setIndex(n, versions, distTags) { index.set(n, { versions, distTags, updatedAt: Date.now() }) },
    async invalidateVersionsCache(n) { index.delete(n) },
    async isNegative(n) { return negative.has(n) },
    async recordNegative(n) { negative.add(n) },
    async clearNegative(n) { negative.delete(n) },
    async getMeta(n, v) { return meta.get(`${n}@${v}`) },
    async setMeta(n, v, dependencies, peerDependencies, peerDependenciesMeta) {
      meta.set(`${n}@${v}`, { dependencies, peerDependencies, peerDependenciesMeta, updatedAt: Date.now() })
    },
  }
}

const { packageService } = createResolver(memoryCache(), fetchHttpClient)

/**
 * Compile a bulb source string to a standalone HTML document.
 *
 * Client-only: a nested bulb has no server, so a `**server.ts**` block is
 * rejected rather than silently ignored (its RPC would have nowhere to land).
 * The import map keeps the CLI's relative `/proxy/` URLs — when the result is
 * mounted in a same-origin or srcdoc iframe under the CLI server, those resolve
 * against the host page and flow through its caching CDN proxy.
 */
export async function renderBulb(source: string, opts: { theme?: 'light' | 'dark' } = {}): Promise<RenderBulbResult> {
  const parsed = parseBulb(source)
  if (!parsed) return { error: 'Not a valid bulb (missing `---` frontmatter or a **code.tsx** block).' }

  const bulb = toLocalBulb(parsed)
  if (bulb.server.trim()) return { error: 'Nested bulbs are client-only; a **server.ts** block is not supported.' }
  if (!bulb.code.trim()) return { error: 'Bulb has no **code.tsx** to run.' }

  const config = parseConfig(bulb.config)

  // Lint on the raw source before transpile — the same `typebulb/lint` pass `typebulb check` runs, on the
  // browser ruleset (an embed is client-only). It catches the import-map / sandbox patterns that compile
  // fine but break in an embed (dynamic import, URL/version imports, navigation), turning a silent runtime
  // failure into a precise, fix-named error. Surfaced as a render error so it rides the embed's existing
  // compile-error → `typebulb logs <agent>` readback path (TB-Agent-Mirror-Embed-Iterate.md).
  //
  // We deliberately do NOT pass `dependencies` here, so the UNDECLARED_IMPORT rule stays dormant for an
  // embed: a model-emitted embed often imports a package its config.json doesn't declare, and the
  // import-driven resolver CDN-resolves "latest" and renders fine. An embed is throwaway and forgiving
  // by design (same spirit as the structural fence tolerance) — a render is worth more than enforcing
  // the authored-config contract on a block no one keeps. The contract is enforced where a real file
  // exists instead: `breakout` DERIVES the missing `dependencies` into the promoted `.bulb.md`
  // (launcher.ts), and the local run / `check` enforce it there (TB-Lint-Transpile.md).
  const issues = lint(bulb.code, { target: 'client' })
  if (issues.length) return { error: `Lint failed:\n${summarizeLint(issues)}` }

  const compiled = transpile(bulb.code, { jsxImportSource: config.ts?.jsxImportSource })
  if (compiled.error) return { error: `Compile error: ${compiled.error}` }

  let importMap
  try {
    ({ importMap } = await packageService.buildImportMap(compiled.code, config.dependencies ?? {}))
  } catch (e) {
    return { error: `Dependency resolution failed: ${e instanceof Error ? e.message : String(e)}` }
  }

  const html = renderHtml({
    name: bulb.name || 'bulb',
    code: compiled.code,
    css: bulb.css,
    html: bulb.html,
    data: parseDataChunks(bulb.data),
    insight: bulb.insight,
    importMap,
    watch: false,
    theme: opts.theme,
    embedded: true,
  })
  return { html }
}

export interface BulbFrameOptions {
  /** Force light/dark. Omit to inherit the host's `data-theme` automatically. */
  theme?: 'light' | 'dark'
  /** Height the frame shows before the embed reports its content height — and the
   *  height a full-bleed (`height:100%`) bulb self-stabilises at, since its body tracks
   *  the frame rather than having an intrinsic height. Flow content settles to its true
   *  height, above OR below this. Default 320. */
  initialHeight?: number
  /** Ceiling for auto-height. The protocol channel is untrusted (the embed's user
   *  code shares the frame's window with the protocol script), so a buggy/hostile
   *  embed could report an absurd height; this bounds the blast radius. Default 100000. */
  maxHeight?: number
  /** Called with a message when the embed throws at runtime (post-mount). */
  onError?: (message: string) => void
  /** Called once, on the embed's first auto-height report — proof the bulb's code ran to
   *  first paint (the promise resolving only proves it *compiled*). Skipped if an error
   *  arrives first, so ready never follows a failure. */
  onReady?: () => void
  /** Abort to remove the frame's host-side `message` listener. The host owns frame
   *  lifecycle; without this the listener (and its ref to the frame) lives for the
   *  page — fine for a long-lived host, a leak for one that churns embeds. */
  signal?: AbortSignal
}

function hostTheme(): 'light' | 'dark' | undefined {
  const t = document.documentElement.getAttribute('data-theme')
  return t === 'dark' || t === 'light' ? t : undefined
}

/**
 * Render a bulb and return a ready-to-mount, sandboxed iframe — the batteries-
 * included counterpart to renderBulb for hosts that embed bulbs.
 *
 * Owns the two things an embedder can't safely or fully do itself: the sandbox
 * policy (see the setAttribute below) and the host↔embed protocol — auto-height
 * and runtime-error forwarding both need code inside the iframe (see template.ts)
 * talking to the listener wired here.
 *
 * Rejects if the bulb can't compile; runtime throws after mount surface via
 * `onError`. The caller owns discovery, placement, and styling.
 */
export async function createBulbFrame(source: string, opts: BulbFrameOptions = {}): Promise<HTMLIFrameElement> {
  const { html, error } = await renderBulb(source, { theme: opts.theme ?? hostTheme() })
  if (error || !html) throw new Error(error ?? 'Bulb produced no output.')

  const initialHeight = opts.initialHeight ?? 320
  const maxHeight = opts.maxHeight ?? 100_000
  const frame = document.createElement('iframe')
  // SECURITY INVARIANT: allow-scripts only. Adding allow-same-origin would let
  // the embed script into this page's DOM, storage, and same-origin endpoints —
  // it defeats the entire isolation. This is the one place that decision lives.
  frame.setAttribute('sandbox', 'allow-scripts')
  // Functional styling only; the host frames/styles the wrapper. Width stays the host
  // column (the embed reports only height — see template.ts).
  frame.style.cssText = `display:block;width:100%;height:${initialHeight}px;border:0`
  frame.srcdoc = html

  // Opaque-origin embeds post from a 'null' origin, so authenticate by window
  // identity (event.source), not origin. Treat the payload as UNTRUSTED: the
  // embed's user code shares this window with the protocol script and can spoof
  // these, so clamp height to [0, maxHeight] (and reject non-finite), and hand
  // onError a plain String the host must render as text, never HTML.
  let ready = false
  let errored = false
  const onMessage = (e: MessageEvent) => {
    if (e.source !== frame.contentWindow) return
    const d = e.data as { __typebulbEmbed?: boolean; kind?: string; height?: number; message?: string }
    if (!d || d.__typebulbEmbed !== true) return
    if (d.kind === 'height' && typeof d.height === 'number' && Number.isFinite(d.height)) {
      // No floor: the reported height is intrinsic content (template.ts), so an honest
      // short bulb settles small. Full-bleed bulbs self-stabilise at initialHeight on
      // their own (their body tracks the frame), so a floor isn't what holds them up.
      frame.style.height = `${Math.min(maxHeight, Math.max(0, Math.ceil(d.height)))}px`
      if (!ready && !errored) { ready = true; opts.onReady?.() }
    } else if (d.kind === 'error') {
      errored = true
      opts.onError?.(String(d.message ?? 'error'))
    }
  }
  window.addEventListener('message', onMessage, opts.signal ? { signal: opts.signal } : undefined)
  return frame
}
