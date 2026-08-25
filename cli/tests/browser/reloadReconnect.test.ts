import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Browser } from 'playwright'
import type { ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createRequire } from 'module'
import { launchBulb, runCli, requireDistBuild } from './harness/servers.js'
import { serverModulePath } from '../../src/pipeline.js'

/**
 * Tier B — the tab survives its server being replaced (TB-CLI.md, "A replace keeps the user's tab").
 * Only a real browser establishes this: the claim is entirely about `EventSource` behaviour after its
 * connection drops, which node cannot stand in for. It is also the exact failure that cost an agent a
 * session — the page stayed open on the right URL while the CLI reported a clean replace, but the shim
 * closed the stream on the first error, leaving a zombie tab: stale render, no hot reload, and
 * invisible to `typebulb send`, which counts open streams.
 *
 * Spawns the real CLI twice, because the fidelity is the point. An in-process `startServer` +
 * `close()` cannot reproduce a replace: `close()` stops the listener but leaves the established SSE
 * socket open, so the page never sees a drop and never reconnects — a false green. A real replace
 * kills the predecessor's *process*, which is what destroys the socket. Spawning also exercises the
 * parts that only exist end to end: the port block reclaiming the same slot, and two distinct server
 * instances carrying different boot ids.
 *
 * Runs against `dist/` (the published bin), so it needs a build — asserted up front rather than
 * failing obscurely. `TYPEBULB_SERVERS_DIR` redirects the registry *and* the port blocks into a temp
 * home, so the suite never touches the developer's real one.
 *
 * Verified red→green: restoring `es.onerror = () => es.close()` in bulb/shim.ts leaves the marker in
 * place and the old body on screen — the test fails on exactly the regression it exists for.
 */

const nodeRequire = createRequire(import.meta.url)
const { chromium } = nodeRequire('playwright') as typeof import('playwright')

const bulbSource = (body: string) => `---
format: typebulb/v1
name: Reconnect
---

**code.tsx**

\`\`\`tsx
document.getElementById("app")!.textContent = ${JSON.stringify(body)}
document.title = ${JSON.stringify(body)}
\`\`\`

**index.html**

\`\`\`html
<div id="app"></div>
\`\`\`
`

describe('a replaced server keeps the open tab (live browser)', () => {
  let browser: Browser | undefined
  let home: string
  let bulb: string
  const running: ChildProcess[] = []

  beforeAll(() => {
    requireDistBuild()
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-reconnect-'))
    bulb = path.join(home, 'reconnect.bulb.md')
    fs.writeFileSync(bulb, bulbSource('first'))
  })

  afterAll(async () => {
    await browser?.close()
    for (const child of running) child.kill()
    // The servers hold files under the temp home (log, `.typebulb` cache) until they actually exit,
    // and on Windows that keeps the directory busy — wait for the kill to land, retry, and let a
    // stubborn lock go rather than failing the suite on teardown.
    await new Promise(r => setTimeout(r, 500))
    try {
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch { /* a temp dir the OS will reap */ }
  })

  const launch = () => launchBulb(bulb, {
    cwd: home,
    env: { ...process.env, TYPEBULB_SERVERS_DIR: path.join(home, 'servers') },
    track: running,
  })

  it('reconnects to the successor on the same port and reloads itself', async () => {
    const url = await launch()

    browser = await chromium.launch()
    const tab = await browser.newPage()
    await tab.goto(url)
    await tab.waitForFunction(() => document.title === 'first')
    // Survives a reload only if the document is re-fetched — this is what a zombie tab keeps.
    await tab.evaluate(() => { (window as unknown as { __alive?: boolean }).__alive = true })

    // The replace: new content, and a launch that stops the predecessor and reclaims its port.
    fs.writeFileSync(bulb, bulbSource('second'))
    const replacedUrl = await launch()
    expect(replacedUrl).toBe(url)   // the sticky slot — the tab is still pointed at a live server

    // No user action from here: the page's own EventSource must notice, reconnect, and reload.
    // waitForFunction, not a poll — the navigation we're waiting for destroys the execution context
    // an `evaluate` is running in, so polling races the very thing it's watching for.
    const reloaded = await tab.waitForFunction(
      () => document.title === 'second' && (window as unknown as { __alive?: boolean }).__alive === undefined,
      undefined,
      { timeout: 45_000 },
    ).then(() => true, () => false)

    expect(reloaded).toBe(true)
  }, 120_000)
})

// One CLI-opened page (TB-VSCode-Browser.md): a tab opened on the relay's `#tb-relay` URL yields
// when it ARRIVES to find a page already attached — `window.close()` where the browser lets a script
// close the tab (one it opened, or one with no history), else replacing itself with the note the
// `close` event's reason names, so the bulb no longer runs there (TB-Page-Lifecycle.md, One
// departure event). Only the newcomer yields; the page already here is never taken away.
// Real-browser only: the close rule and the navigation are the browser's, and node can stand in for
// neither. Verified red→green: with the shim's `close` listener removed, both tabs stay, both running.
describe('a relay-opened tab yields on arrival (live browser)', () => {
  let browser: Browser | undefined
  let home: string
  const running: ChildProcess[] = []

  beforeAll(() => {
    requireDistBuild()
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-yield-'))
    fs.writeFileSync(path.join(home, 'yield.bulb.md'), bulbSource('yield'))
  })

  afterAll(async () => {
    await browser?.close()
    for (const child of running) child.kill()
    await new Promise(r => setTimeout(r, 500))
    try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) } catch { /* a temp dir the OS will reap */ }
  })

  it('closes itself when script-opened, parks when the browser refuses the close', async () => {
    const url = await launchBulb(path.join(home, 'yield.bulb.md'), {
      cwd: home, env: { ...process.env, TYPEBULB_SERVERS_DIR: path.join(home, 'servers') }, track: running,
    })
    browser = await chromium.launch()
    const ctx = await browser.newContext()

    // The page already here, and it stays: only a newcomer yields, so it must arrive first.
    const user = await ctx.newPage()
    await user.goto(url)
    await user.waitForFunction(() => document.title === 'yield')

    // The relay's own shape: a tab a page of ours window.open'ed. It yields by closing.
    const opener = await ctx.newPage()
    const [relayed] = await Promise.all([
      ctx.waitForEvent('page'),
      opener.evaluate((u: string) => { window.open(u, '_blank') }, url + '#tb-relay'),
    ])
    await relayed.waitForEvent('close', { timeout: 15_000 })
    expect(relayed.isClosed()).toBe(true)
    expect(user.isClosed()).toBe(false)

    // A tab with history that no script opened: the browser refuses the close, so it parks.
    const stuck = await ctx.newPage()
    await stuck.goto(url + '/?first')
    await stuck.goto(url + '/#tb-relay')
    // The note travels with the reason, as a blob document: one that needed the server could not
    // cover a stop, where the server is the thing leaving.
    await stuck.waitForURL(/^blob:/, { timeout: 15_000 })
    expect(await stuck.textContent('body')).toContain('already open in another tab')
    expect(user.isClosed()).toBe(false)
  }, 120_000)
})

/**
 * The acceptance test for the close half (TB-Page-Lifecycle.md, invariant 7): the sequence an agent
 * actually types, with the pages counted from the browser. Three earlier fixes were called done off
 * a green node suite while the real sequence still ran two copies of the bulb at once.
 */
describe('a stop leaves nothing of the bulb running (live browser)', () => {
  let browser: Browser | undefined
  let home: string
  let bulb: string
  const running: ChildProcess[] = []

  beforeAll(() => {
    requireDistBuild()
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-stop-'))
    bulb = path.join(home, 'stopped.bulb.md')
    fs.writeFileSync(bulb, bulbSource('running'))
  })

  afterAll(async () => {
    await browser?.close()
    for (const child of running) child.kill()
    await new Promise(r => setTimeout(r, 500))
    try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) } catch { /* a temp dir the OS will reap */ }
  })

  const env = () => ({ ...process.env, TYPEBULB_SERVERS_DIR: path.join(home, 'servers') })
  const launch = () => launchBulb(bulb, { cwd: home, env: env(), track: running })

  it('takes the page off the bulb, exits, and a relaunch leaves exactly one page running it', async () => {
    const url = await launch()
    const server = running[running.length - 1]

    browser = await chromium.launch()
    const ctx = await browser.newContext()
    const tab = await ctx.newPage()
    await tab.goto(url)
    await tab.waitForFunction(() => document.title === 'running')

    const stop = await runCli(['stop', bulb], { cwd: home, env: env() })
    // The status line carries the observation behind it, not just the intention.
    expect(stop.stdout + stop.stderr).toContain('closed 1 page')

    // Nothing of the bulb runs here any more: the tab is off it (closed, or on the note).
    await tab.waitForURL(/^blob:|^about:blank/, { timeout: 15_000 }).catch(() => { /* it may have closed */ })
    expect(tab.isClosed() || !tab.url().startsWith(url)).toBe(true)
    // And the owner is gone, not merely told: `stop` waits for the process before it reports.
    expect(await new Promise(r => (server.exitCode !== null ? r(true) : server.once('exit', () => r(true))))).toBe(true)

    // The reset, in full: stop then a plain relaunch, with the pages counted from the browser.
    const again = await launch()
    expect(again).toBe(url)                                   // the sticky slot, unmoved by any of this
    const fresh = await ctx.newPage()
    await fresh.goto(again)
    await fresh.waitForFunction(() => document.title === 'running')
    const onTheBulb = ctx.pages().filter(p => !p.isClosed() && p.url().startsWith(again))
    expect(onTheBulb).toHaveLength(1)
  }, 180_000)

  // Invariant 3's day-one test, and it lives here rather than in a node suite on purpose: the claim
  // is that a deliberate stop runs the stopped *process's* own cleanup on Windows, where a signal is
  // `TerminateProcess` and runs none of it. Only a spawned real server can show that, and the temp
  // server module is the step that leaves a mark on disk.
  it('runs the stopped process own cleanup — the temp server module is gone', async () => {
    const served = path.join(home, 'served.bulb.md')
    const fence = '```'
    fs.writeFileSync(served, bulbSource('served')
      + `\n**server.ts**\n\n${fence}ts\nexport async function ping() { return 'pong' }\n${fence}\n`)
    await launchBulb(served, { cwd: home, env: env(), track: running, args: ['--trust'] })
    const temp = serverModulePath(served)
    expect(fs.existsSync(temp)).toBe(true)

    await runCli(['stop', served], { cwd: home, env: env() })
    expect(fs.existsSync(temp)).toBe(false)
  }, 120_000)
})
