import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Browser } from 'playwright'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createRequire } from 'module'
import { startServer, type ServerInstance } from '../../src/serve/server.js'
import { freePort } from './harness/servers.js'

/**
 * Tier B — live attack on the inline bulb↔host boundary (TB-Agent-Mirror-Inline.md, the
 * `createBulbFrame` sandbox). A ````bulb```` inline bulb is attacker-influenced content
 * (assistant transcript), compiled into a `sandbox="allow-scripts"` srcdoc iframe and
 * mounted inside the *privileged* mirror page. The whole isolation rests on the iframe's
 * opaque origin: it must not be able to (a) drive the host's privileged `/__fs`, nor
 * (b) read the host's same-origin DOM. This proves the attack in a REAL browser — the
 * only layer that establishes the opaque-origin facts node can't. The host page is served
 * from a `trusted: true` server (the privileged-mirror analog), so a successful write
 * would be node-grade.
 *
 * The inline bulb signals `embedRan` so a missing pwned file means "blocked", never "never fired".
 *
 * Scope: this proves the *property* — an `allow-scripts`-only opaque-origin inline bulb cannot reach
 * the privileged host. It replicates the sandbox attribute rather than importing `createBulbFrame`,
 * so it does NOT guard that `createBulbFrame` still *emits* `allow-scripts` (no `allow-same-origin`);
 * that one-line invariant lives at [render.ts](../../src/render.ts) (`setAttribute('sandbox', …)`,
 * marked SECURITY INVARIANT). Verified red→green: switching the iframe below to
 * `allow-scripts allow-same-origin` makes the inline bulb same-origin, the CSRF guard passes, and the
 * privileged write lands — so this test detects exactly that regression in the attribute it asserts.
 */

const nodeRequire = createRequire(import.meta.url)
const { chromium } = nodeRequire('playwright') as typeof import('playwright')

async function pollExists(file: string, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return true
    await new Promise(r => setTimeout(r, 50))
  }
  return false
}

// The hostile inline bulb's body (runs inside the allow-scripts srcdoc, opaque origin). It tries
// the two escalations, then reports it ran. `\/` keeps the closing tag out of this template.
const EVIL_EMBED = `<!doctype html><meta charset=utf-8><body>evil<script>
(async () => {
  let domRead = 'blocked';
  try { domRead = String(top.document.body.innerHTML).slice(0, 40); } catch (e) { domRead = 'threw:' + e.name; }
  // The money attack: drive the privileged host endpoint from the sandbox.
  try { await fetch('/__fs/write?path=inline bulb-pwned.txt', { method: 'POST', body: 'owned-by-inline bulb' }); } catch (e) {}
  parent.postMessage({ embedRan: true, domRead }, '*');
})();
<\/script></body>`

// The privileged host page: mounts the hostile inline bulb exactly as createBulbFrame does
// (sandbox="allow-scripts", srcdoc), and records what the inline bulb reports.
function hostHtml(): string {
  return `<!doctype html><meta charset=utf-8><body>privileged host
<iframe id="f" sandbox="allow-scripts" style="width:100%;height:320px;border:0"></iframe>
<script>
  window.__inlineRan = false;
  window.__domRead = '';
  window.addEventListener('message', e => {
    if (e && e.data && e.data.embedRan) { window.__inlineRan = true; window.__domRead = e.data.domRead; }
  });
  document.getElementById('f').srcdoc = ${JSON.stringify(EVIL_EMBED).replace(/<\//g, '<\\/')};
<\/script></body>`
}

let browser: Browser
let host: ServerInstance
let hostDir: string

beforeAll(async () => {
  browser = await chromium.launch()
  hostDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-embedhost-'))
  // trusted: true — the privileged origin. If the sandbox leaked, the inline bulb's write to
  // /__fs would actually land here.
  host = await startServer({ getHtml: hostHtml, basePath: hostDir, port: await freePort(), trusted: true })
}, 60_000)

afterAll(async () => {
  await browser?.close()
  host?.close()
  if (hostDir) fs.rmSync(hostDir, { recursive: true, force: true })
})

describe('a malicious allow-scripts inline bulb cannot escape into the privileged host', () => {
  it('cannot drive the host\'s privileged /__fs, nor read its DOM', async () => {
    const page = await browser.newPage()
    await page.goto(`http://localhost:${host.port}`)
    // Wait until the inline bulb has actually executed (so a missing file = blocked, not unfired).
    await page.waitForFunction('window.__inlineRan === true', undefined, { timeout: 10_000 })
    const domRead = await page.evaluate('window.__domRead') as string

    // The privileged write must NOT land: the opaque-origin inline bulb is cross-site to the host,
    // so the CSRF guard refuses it (and there is no allow-same-origin to make it same-origin).
    const landed = await pollExists(path.join(hostDir, 'inline bulb-pwned.txt'), 4_000)
    await page.close()

    expect(landed).toBe(false)                 // sandbox + CSRF held
    expect(domRead.startsWith('blocked') || domRead.startsWith('threw')).toBe(true)  // opaque origin blocked DOM read
  }, 30_000)

  it('the host\'s own same-origin page CAN reach /__fs (liveness — the boundary is not over-broad)', async () => {
    const page = await browser.newPage()
    await page.goto(`http://localhost:${host.port}`)
    await page.evaluate(() =>
      fetch('/__fs/write?path=host-legit.txt', { method: 'POST', body: 'ok' }).catch(() => {}),
    )
    const landed = await pollExists(path.join(hostDir, 'host-legit.txt'), 5_000)
    await page.close()
    expect(landed).toBe(true)
  }, 30_000)
})
