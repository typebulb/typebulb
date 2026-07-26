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

/** Base reset + the `data-theme` → `color-scheme` mapping every page emits. The
 *  theme engine sets `html[data-theme]`; this maps it to the UA color-scheme — the
 *  Theming invariant (Specs/Typebulb-CLI.md): `data-theme` and `color-scheme` must
 *  always travel together. Indented to sit inside a `<style>` block.
 *
 *  `body { display: flow-root }` makes body a block formatting context so a first/
 *  last child's vertical margin (author's, or a UA default like `<h1>`'s) can't
 *  collapse out through body — the embed auto-height reports `body.scrollHeight`
 *  (template.ts), and an escaped margin sizes the frame short → clipped content +
 *  premature scrollbar (TB-Agent-Mirror-Embed.md Invariant 3). Don't drop it.
 *
 *  `canvas { max-width: 100% }` keeps a canvas inside its container the way
 *  responsive `img` does: a canvas's backing store is `devicePixelRatio`-scaled, so
 *  code that sizes the buffer but not the CSS box (e.g. three's `setSize(w, h, false)`)
 *  otherwise lays the element out at buffer size — `dpr`× too wide — and overflows.
 *  Height already defaults to `auto`, so clamping width pulls height down the intrinsic
 *  ratio with it. Base-level, so a bulb that sets its own canvas size still wins. */
export const baseResetStyle = `    *, *::before, *::after { box-sizing: border-box; }
    canvas { max-width: 100%; }
    body { margin: 0; display: flow-root; font-family: system-ui, -apple-system, sans-serif; }
    html[data-theme="dark"]  { color-scheme: dark; }
    html[data-theme="light"] { color-scheme: light; }`

/**
 * The no-flash theme engine, injected into <head>. Sets `html[data-theme]` before
 * stylesheets paint (no flash) and exposes the `tb.theme` accessor via
 * `window.__tbTheme`. The override is persisted per-page in localStorage keyed by
 * `name`; its absence means follow the OS. A host-forced `theme` (a bulb embedded in
 * a bulb, whose sandboxed iframe can't read the host's localStorage) outranks the OS
 * but not an explicit in-iframe override, so the user can still toggle an embed
 * independently. Ctrl/Cmd+Shift+L toggles the effective theme. See Specs/Theme.md.
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
        window.__tbTheme = { get: stored, set: set, effective: effective };
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
