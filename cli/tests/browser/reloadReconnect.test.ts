import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Browser } from 'playwright'
import { spawn, type ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'

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

const runtimeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const bin = path.join(runtimeRoot, 'dist', 'index.js')

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
    expect(fs.existsSync(bin), `${bin} missing — run \`pnpm run build\` before the browser suite`).toBe(true)
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

  /** Launch the bulb the way a terminal does, resolving once it prints the URL it bound. */
  function launch(): Promise<string> {
    return new Promise((resolve, reject) => {
      // --no-watch so the only thing that can reload the page is the replace itself, never a save.
      const child = spawn(process.execPath, [bin, bulb, '--no-open', '--no-watch'], {
        cwd: home,
        env: { ...process.env, TYPEBULB_SERVERS_DIR: path.join(home, 'servers') },
      })
      running.push(child)
      let out = ''
      const onData = (chunk: Buffer) => {
        out += chunk.toString()
        const url = out.match(/http:\/\/localhost:(\d+)/)
        if (url) resolve(url[0])
      }
      child.stdout?.on('data', onData)
      child.stderr?.on('data', onData)
      child.on('exit', code => reject(new Error(`server exited (${code}): ${out}`)))
      setTimeout(() => reject(new Error(`no URL printed: ${out}`)), 60_000)
    })
  }

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
