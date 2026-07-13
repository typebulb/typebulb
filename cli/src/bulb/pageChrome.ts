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
