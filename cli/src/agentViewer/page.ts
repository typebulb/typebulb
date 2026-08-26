/**
 * HTML page for the debulbified agent mirror.
 *
 * The bulb template (`bulb/template.ts`) builds a page around a compiled bulb: import
 * map, the full `tb` shim, the inline bulb protocol. The mirror needs none of that: it's
 * ordinary bundled code, so its client (`client.js`) is a self-contained ESM module
 * with no bare imports to resolve, and it talks to its `server.ts` through one tiny
 * surface: `tb.server.<name>()` / `tb.log()`. This builds the trimmed page:
 * the no-flash theme engine (so nested inline bulbs inherit the host theme), the mirror's
 * styles and mount stub (which carries its own boot overlay), the minimal `tb`, and the module
 * script tag.
 *
 * Every stylesheet is INLINE — the mirror's own and KaTeX's alike. A page whose first paint waits on
 * a subresource can hang blank on something that is not the mirror's fault (KaTeX's css loaded from
 * jsdelivr, and a slow CDN held the whole page, module script included); with nothing to fetch, the
 * boot overlay is on screen the moment the HTML lands.
 */

import { escapeHtml, baseResetStyle, themeHeadScript, reloadClientScript } from '../bulb/pageChrome.js'

/** Where the static route in `startServer` serves an agent's bundled client from (per agent name). */
export const clientBundleUrl = (agent: string) => `/agents/${agent}/client.js`

/**
 * The mirror's `tb`. Only `tb.server.<name>(...)` (RPC → `POST /__api/<name>`, the exact
 * transport from `bulb/shim.ts`) and `tb.log(...)` (→ `POST /__log`). No inline bulb,
 * fs, ai, proxy, or theme paths — the mirror uses none of them, and it always runs
 * `trusted`, so `/__api` is never 403 for it. The `__TYPEBULB_WATCH__` listener mirrors
 * the shim's hot-reload (an esbuild rebuild restarts the server, dropping the SSE; the
 * page reconnects on the next launch / reloads on the reload event).
 */
const AGENT_TB_SHIM = `
(() => {
  const api = async (name, ...args) => {
    const resp = await fetch('/__api/' + name, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'API call failed');
    return data.result;
  };
  const tbLog = async (...args) => {
    try {
      const resp = await fetch('/__log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ args })
      });
      if (!resp.ok) console.log(...args);
    } catch { console.log(...args); }
  };
  globalThis.tb = Object.freeze({
    log: (...args) => { void tbLog(...args); },
    server: new Proxy({}, {
      get: (_, name) => (...args) => api(name, ...args)
    })
  });
  if (window.__TYPEBULB_WATCH__) {
${reloadClientScript()}
  }
})();
`

export interface AgentHtmlOptions {
  /** Names the <title> and the per-page theme-override localStorage key. */
  name: string
  /** The agent name (e.g. `claude`) — selects which client bundle the page loads. */
  agent: string
  /** The mirror's `styles.css`, inlined into <head> (read from the dist asset dir). */
  styles: string
  /** KaTeX's `katex.min.css`, inlined too (same dist asset dir; its font URLs already absolute). */
  katex: string
  /** The mount stub (`agents/client/index.html`): `#app` plus the self-driving boot overlay. */
  mountHtml: string
  /** Wire the hot-reload listener (watch mode). */
  watch: boolean
  /** Force light/dark instead of detecting the OS. */
  theme?: 'light' | 'dark'
}

/** Build the mirror's complete HTML page. Pure string assembly — no I/O. */
export function buildAgentHtml(opts: AgentHtmlOptions): string {
  const { name, agent, styles, katex, mountHtml, watch, theme } = opts
  const bundleUrl = clientBundleUrl(agent)
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(name)} - typebulb</title>
${themeHeadScript(name, theme)}
  <style>
${baseResetStyle}
  </style>
  <style>
${styles}
  </style>
  <style>
${katex}
  </style>
</head>
<body>
${mountHtml}

${watch ? '<script>window.__TYPEBULB_WATCH__ = true;</script>' : ''}

<script>
${AGENT_TB_SHIM}
</script>

<script type="module" src="${bundleUrl}"></script>
</body>
</html>`
}
