/**
 * Shared HTML page chrome for the two server-rendered pages: the bulb template
 * (template.ts) and the agent mirror (agentViewer/page.ts). Both emit the same
 * no-flash theme engine, the same base reset, and the same `escapeHtml`; one copy
 * keeps the security-sensitive inline theme script from drifting between them.
 * Pure string assembly, isomorphic (no node builtins), so it lives in bulb/.
 */

/** Escape text for safe interpolation inside an inline `<script>` body — a literal
 *  `</script` in the payload would close the tag early and break out of the script. */
export const escapeScript = (s: string) => s.replace(/<\/script/gi, '<\\/script')

/** Escape text for safe interpolation into HTML element/attribute content. */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// The base reset + definite-height chain live in typebulb/format (pageShell.ts) — one
// copy shared with typebulb.com's sandbox, so every tier ships the same shell and a
// bulb can't render differently local vs published. Re-exported so the CLI's pages
// keep importing their chrome from one place.
export { baseResetStyle, pageHeightStyle } from 'typebulb/format'

/**
 * The no-flash theme engine, injected into <head>. Sets `html[data-theme]` before
 * stylesheets paint (no flash) and exposes the `tb.theme` accessor via
 * `window.__tbTheme`. The override is persisted per-page in localStorage keyed by
 * `name`; its absence means follow the OS. A host-forced `theme` (a bulb inline in
 * a bulb, whose sandboxed iframe can't read the host's localStorage) outranks the OS
 * but not an explicit in-iframe override, so the user can still toggle an inline bulb
 * independently. Ctrl/Cmd+Shift+L toggles the effective theme. See Specs/Theme.md.
 *
 * `apply` writes `data-theme` WITHOUT persisting — the transient half of the engine,
 * used by the host's theme push (below) and by `tb:theme` in shim.ts. `set` is the
 * durable one. Nothing else should write the attribute.
 */
export function themeHeadScript(name: string, theme?: 'light' | 'dark'): string {
  return `  <script>
    (function() {
      try {
        var KEY = ${escapeScript(JSON.stringify('tb-theme:' + name))};
        var doc = document.documentElement;
        var mq = window.matchMedia('(prefers-color-scheme: dark)');
        var os = function() { return mq.matches ? 'dark' : 'light'; };
        var FORCED = ${escapeScript(JSON.stringify(theme ?? null))};
        var stored = function() {
          try { var v = localStorage.getItem(KEY); return (v === 'dark' || v === 'light') ? v : undefined; }
          catch (e) { return undefined; }
        };
        var apply = function(t) { doc.setAttribute('data-theme', t); };
        var effective = function() { return stored() || FORCED || os(); };
        var set = function(v) {
          if (v === 'dark' || v === 'light') {
            try { localStorage.setItem(KEY, v); } catch (e) {}
            apply(v);
          } else {
            try { localStorage.removeItem(KEY); } catch (e) {}
            apply(FORCED || os());
          }
        };
        apply(effective());
        var onOsChange = function() { if (!stored() && !FORCED) apply(os()); };
        mq.addEventListener ? mq.addEventListener('change', onOsChange) : mq.addListener(onOsChange);
        window.__tbTheme = { get: stored, set: set, apply: apply, effective: effective };
        /* The host pushes its theme when it flips (render.ts): a framed bulb's baseline is stamped
           into its srcdoc at creation, so it would otherwise hold the theme it was born in. The
           host owns the baseline, the bulb owns its override. */
        if (window.parent !== window) {
          window.addEventListener('message', function(e) {
            if (e.source !== window.parent) return;
            var d = e.data;
            if (d && d.__typebulbEmbed === true && d.kind === 'theme' && (d.theme === 'dark' || d.theme === 'light')) apply(d.theme);
          });
        }
        window.addEventListener('keydown', function(e) {
          if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === 'KeyL') {
            e.preventDefault();
            set(effective() === 'dark' ? 'light' : 'dark');
          }
        });
      } catch (e) {}
    })();
  </script>`
}

/**
 * The `/__reload` client, shared by the bulb page (`shim.ts`) and the mirror (`agentViewer/page.ts`):
 * hot reload, plus the reconnect half of a contract whose server half is `startServer`'s per-instance
 * boot id. Both pages have to behave identically here, and one copy is what stops them drifting —
 * the same reason the theme script lives in this file.
 *
 * Riding out a drop is the point. A relaunch stops the predecessor, compiles, then binds the same
 * slot, so the stream is down for seconds; closing on the first error leaves a zombie page — stale
 * render, no hot reload, and invisible to `typebulb send`, which counts open streams. EventSource
 * retries on its own, so all we do is bound how long. The window is long (30 min) because a CRASHED
 * server sits dead until its agent notices and relaunches — a tab that gave up early greets that
 * successor as a zombie, and localhost retries are free. A deliberate stop still ends with a dead
 * page, eventually. A successor serves bytes we don't have, so a boot id other than the one we
 * opened with means reload rather than resume.
 *
 * Leaves `es` in scope: the bulb shim adds its own `message` listener (the `typebulb send` channel)
 * to the same stream.
 */
export const reloadClientScript = `
    const es = new EventSource('/__reload');
    let bootId = null;
    let firstErrorAt = 0;
    const RETRY_WINDOW_MS = 30 * 60000;
    es.addEventListener('open', () => { firstErrorAt = 0; });
    es.addEventListener('hello', (e) => {
      if (bootId === null) bootId = e.data;
      else if (e.data !== bootId) window.location.reload();
    });
    es.addEventListener('reload', () => {
      console.log('[typebulb] Reloading...');
      window.location.reload();
    });
    es.onerror = () => {
      if (!firstErrorAt) firstErrorAt = Date.now();
      if (Date.now() - firstErrorAt > RETRY_WINDOW_MS) es.close();
    };`
