/**
 * HTML template generation for serving bulbs.
 */

import type { ImportMap } from 'typebulb/resolver'
import { typebulbShim } from './shim.js'
import { escapeHtml, baseResetStyle, themeHeadScript } from './pageChrome.js'

export interface RenderOptions {
  name: string
  code: string
  css: string
  html: string
  data: string[]
  insight: string
  importMap: ImportMap
  watch: boolean
  /** Force the initial theme instead of detecting the OS. An embedding host
   *  (a bulb rendering a bulb) passes its own effective theme so the nested
   *  document matches it — a sandboxed iframe can't read the host's localStorage. */
  theme?: 'light' | 'dark'
  /** True when this page is an embed srcdoc (renderBulb), false/omitted for the
   *  standalone top-level page (the CLI server). Only the standalone page gets a
   *  `html, body { height: 100% }` chain — see the `pageHeight` note in renderHtml. */
  embedded?: boolean
}

/** Render a bulb to a complete HTML page */
export function renderHtml(options: RenderOptions): string {
  const { name, code, css, html, data, insight, importMap, watch, theme, embedded } = options

  // Default HTML if none provided
  const userHtml = html.trim() || '<div id="app"></div>'

  // Standalone only: give the top-level page a definite height chain so a fill bulb
  // (a canvas/animation whose root is `height: 100%`) resolves against the window
  // instead of collapsing to zero — without it only `100dvh` fills, and a fixed px
  // height leaves dead space below in the bulb's own window. NOT for an embed: there
  // `body` must stay content-height so the auto-height protocol's `body.scrollHeight`
  // can shrink the frame to the content (a 100%-tall body would peg it to the frame).
  const pageHeight = embedded ? '' : '\n    html, body { height: 100%; }'

  // Escape script content for embedding
  const escapeScript = (s: string) => s.replace(/<\/script/gi, '<\\/script')

  // Route browser package fetches through the CLI's caching /proxy/ endpoint.
  // Relative URL means we don't need to know the port at template-render time.
  const proxiedImportMap = { imports: routeImportsThroughProxy(importMap.imports) }

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(name)} - typebulb</title>
${themeHeadScript(name, theme)}
  <script type="importmap">
${JSON.stringify(proxiedImportMap, null, 2)}
  </script>
  <style>
${baseResetStyle}${pageHeight}
  </style>
  <style>
${css}
  </style>
</head>
<body>
${userHtml}

${data.length > 0 ? `<script>window.__TB_DATA__ = ${escapeScript(JSON.stringify(data))};</script>` : ''}
${insight ? `<script>window.__TB_INSIGHT__ = ${escapeScript(JSON.stringify(insight))};</script>` : ''}
${watch ? '<script>window.__TYPEBULB_WATCH__ = true;</script>' : ''}

<script>
${typebulbShim}
</script>

${embedProtocol}

<script type="module">
${escapeScript(code)}
globalThis.__tbEntryRan = true; /* load-failure backstop — see embedProtocol */
</script>
</body>
</html>`
}

// Host↔embed protocol (bulb-in-a-bulb) + uncaught-error forwarding. When framed it posts
// its content height (the host can't size the iframe otherwise), keeps overflow in sync
// with fit, and forwards runtime errors to the embedding host (createBulbFrame's
// listener). A standalone top-level page skips the height machinery but still forwards
// uncaught errors — to its own ungated /__log, so the one failure a local bulb can't
// report itself (the error that killed it) lands in the log `typebulb logs`/`wait` read
// (TB-Agent-Mirror-Embed-Iterate.md, "The local tier"). Never /__log from a
// frame: an embed's relative URL would resolve against the HOST page's origin — the
// mirror's log, untagged, bypassing its dedup. Registered as a classic script BEFORE the
// deferred module so its error listeners catch errors from first eval. Sends content
// height only; the host owns width and any height cap — an embed can't tell a
// deliberately-narrow widget from a responsive one, so those are the host's call (see
// claude.bulb's toggle).
const embedProtocol = `<script>
(function () {
  var framed = window.parent !== window;
  var post = function (m) { try { parent.postMessage(m, '*'); } catch (e) {} };   /* framed only */
  var lastError;
  var errorPosted = false;
  var postError = function (message) {
    message = String(message);
    if (message === lastError) return;   /* a tight error loop reports once, not per frame */
    lastError = message;
    errorPosted = true;
    if (framed) post({ __typebulbEmbed: true, kind: 'error', message: message });
    else { try { fetch('/__log', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ args: ['[runtime error] ' + message] }) }).catch(function () {}); } catch (e) {} }
  };
  // Capture phase: a resource/module load failure (a <script>/<link>/<img> that 404s) does NOT
  // bubble, so it reaches window only here, carrying the failing element as e.target (no message).
  window.addEventListener('error', function (e) {
    var t = e && e.target;
    if (t && t !== window && (t.src || t.href)) postError('Failed to load ' + (t.src || t.href));
  }, true);
  window.addEventListener('error', function (e) {
    var m = String((e && e.message) || (e && e.error) || 'Error');
    // The benign "ResizeObserver loop completed…" notice surfaces as a window error in
    // some browsers; it's not a bulb fault, so don't forward it to the host as one.
    if (m.indexOf('ResizeObserver') !== -1) return;
    postError(m);
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    var msg = r && r.message ? r.message : (r == null ? 'Unhandled rejection' : r);
    postError(msg);
  });
  // Load-failure backstop (both contexts): if the entry module never evaluated — its import graph
  // failed to resolve (a 404'd dependency, which throws nothing catchable) — surface it. A module
  // that only renders asynchronously still evaluates its top level, so this won't fire on a slow bulb.
  window.addEventListener('load', function () {
    if (!window.__tbEntryRan && !errorPosted) {
      postError('Bulb failed to load: a module or dependency could not be fetched (see the browser console for the failing URL).');
    }
  });
  if (!framed) return;
  var de = document.documentElement;
  // Overflow tracks fit, per axis. While content fits the frame, HIDE overflow: the
  // sub-pixel gap (frame a fraction shorter than content) would otherwise flash a
  // phantom scrollbar, and a full-bleed (height:100%) bulb — whose content equals the
  // frame — must not scroll itself. When the host CAPS the frame (claude.bulb's inline
  // mode caps height to a fraction of the viewport; a prose-column frame caps width),
  // the content genuinely overflows, so ALLOW scroll on that axis to keep it reachable.
  // Reported height is body.scrollHeight — the content's intrinsic extent: below the
  // viewport for a short bulb (so the frame shrinks to it), tracking the frame for a
  // full-bleed one (so it self-stabilises at the host's initial height).
  //
  // Showing the Y scrollbar is DEFERRED; hiding it stays eager. Content grows (a new
  // row, an expanded panel) synchronously, but the frame only grows a beat later, after
  // the host receives the height message and resizes the iframe. In that gap body is
  // taller than the still-old frame, so an eager overflow:auto flashes a scrollbar for
  // exactly the round-trip. So when Y overflows we post the height and re-check after a
  // short delay instead of flipping immediately: if the frame caught up the overflow is
  // gone (no bar), and only an overflow that SURVIVES — a genuine host cap — gets auto.
  // The host can't tell the iframe its cap (no host→iframe channel), so this round-trip
  // is how the embed distinguishes "frame about to grow" from "frame capped". X has no
  // async resize (the host never grows width on content), so it flips inline.
  //
  // Coalesce to one rAF and only write an overflow value that actually changed: setting
  // overflow adds/removes a scrollbar, which resizes the element and re-fires the
  // observer — writing unconditionally ping-pongs (the "ResizeObserver loop" warning).
  var raf = 0;
  var confirm = 0;
  var showYScroll = function () {
    confirm = 0;
    if (de.scrollHeight > de.clientHeight + 1 && de.style.overflowY !== 'auto') de.style.overflowY = 'auto';
  };
  var apply = function () {
    raf = 0;
    var ox = de.scrollWidth > de.clientWidth + 1 ? 'auto' : 'hidden';
    if (de.style.overflowX !== ox) de.style.overflowX = ox;
    if (de.scrollHeight > de.clientHeight + 1) {
      if (de.style.overflowY !== 'auto' && !confirm) confirm = setTimeout(showYScroll, 100);
    } else {
      if (confirm) { clearTimeout(confirm); confirm = 0; }
      if (de.style.overflowY !== 'hidden') de.style.overflowY = 'hidden';
    }
    post({ __typebulbEmbed: true, kind: 'height', height: Math.ceil(document.body.scrollHeight) });
  };
  var update = function () { if (!raf) raf = requestAnimationFrame(apply); };
  de.style.overflow = 'hidden';
  // Run at load (module mounted → real content, not the empty pre-mount body that would
  // collapse the frame and snap back). Observe BOTH body (content growth) and the root
  // element (the viewport — so a host resize/cap re-syncs overflow on the next frame).
  window.addEventListener('load', function () {
    update();
    if (window.ResizeObserver) {
      try { var ro = new ResizeObserver(update); ro.observe(document.body); ro.observe(de); } catch (e) {}
    }
  });
})();
</script>`

function routeImportsThroughProxy(imports: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(imports)) {
    out[k] = v.startsWith('https://') ? '/proxy/' + v : v
  }
  return out
}
