/**
 * The page shell every rendered bulb document ships. ONE copy, in a core subpath,
 * because every host must emit it identically or a bulb renders differently local
 * vs published: the CLI's pages take it via cli/bulb/pageChrome.ts, typebulb.com's
 * sandbox via its Template (client sandbox/template.ts). Both constants are
 * indented to sit inside a `<style>` block.
 */

/** Base reset + the `data-theme` → `color-scheme` mapping every page emits. The
 *  theme engine sets `html[data-theme]`; this maps it to the UA color-scheme — the
 *  Theming invariant (Specs/Typebulb-CLI.md): `data-theme` and `color-scheme` must
 *  always travel together.
 *
 *  `body { display: flow-root }` makes body a block formatting context so a first/
 *  last child's vertical margin (author's, or a UA default like `<h1>`'s) can't
 *  collapse out through body — the embed auto-height reports `body.scrollHeight`
 *  (cli/bulb/template.ts), and an escaped margin sizes the frame short → clipped
 *  content + premature scrollbar (TB-Agent-Mirror-Embed.md Invariant 3). Don't drop it.
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

/** The definite-height chain, for pages whose frame has a definite height — the CLI's
 *  standalone page and every typebulb.com context (all frame-sized iframes) — so a
 *  fill bulb (`height: 100%` root) resolves against the window instead of collapsing
 *  to zero. NEVER for a content-measured embed: there `body` must stay content-height
 *  or the auto-height protocol's `body.scrollHeight` can no longer shrink the frame
 *  (TB-Agent-Mirror-Embed.md). */
export const pageHeightStyle = `    html, body { height: 100%; }`
