import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Browser } from 'playwright'
import type { ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createRequire } from 'module'
import { launchBulb, requireDistBuild } from './harness/servers.js'

/**
 * Scroll restoration on the CLI tier (specs/Scroll-Restoration.md § The CLI tier). Only a real
 * browser can establish this: the claim is that native restoration gives up at `load` and the
 * engine covers the tail, so the bulb under test renders its tall content 800ms AFTER load, the
 * exact class native restore abandons (measured: clamped at 0 permanently without the engine).
 * Spawns the real bin so the page is the served one, head script and all. The same tab then
 * navigates to the URL afresh, which must land at the top: restoration is a reload/traversal
 * behavior, never a fresh navigation's (invariant 2).
 */

const nodeRequire = createRequire(import.meta.url)
const { chromium } = nodeRequire('playwright') as typeof import('playwright')

const bulbSource = `---
format: typebulb/v1
name: Late Tall
---

**code.tsx**

\`\`\`tsx
window.addEventListener('load', () => {
  setTimeout(() => {
    const app = document.getElementById("app")!
    app.style.height = "6000px"
    app.textContent = "tall"
    document.title = "tall"
  }, 800)
})
\`\`\`

**index.html**

\`\`\`html
<div id="app"></div>
\`\`\`
`

describe('a reloaded local bulb comes back at its offset (live browser)', () => {
  let browser: Browser | undefined
  let home: string
  let bulb: string
  const running: ChildProcess[] = []

  beforeAll(() => {
    requireDistBuild()
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-scroll-'))
    bulb = path.join(home, 'late-tall.bulb.md')
    fs.writeFileSync(bulb, bulbSource)
  })

  afterAll(async () => {
    await browser?.close()
    for (const child of running) child.kill()
    await new Promise(r => setTimeout(r, 500))
    try {
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch { /* a temp dir the OS will reap */ }
  })

  it('restores after reload for content that renders after load, and not on a fresh navigation', async () => {
    const url = await launchBulb(bulb, {
      cwd: home,
      env: { ...process.env, TYPEBULB_SERVERS_DIR: path.join(home, 'servers') },
      track: running,
    })

    browser = await chromium.launch()
    const tab = await browser.newPage()
    await tab.goto(url)
    await tab.waitForFunction(() => document.title === 'tall')
    await tab.evaluate(() => window.scrollTo(0, 2500))
    await tab.waitForFunction(() => window.scrollY >= 2490)
    await tab.waitForTimeout(400)   // the throttled save lands

    await tab.reload()
    await tab.waitForFunction(() => document.title === 'tall')
    // The engine re-applies until the document is tall enough; native restoration alone stays at 0
    await tab.waitForFunction(() => Math.abs(window.scrollY - 2500) <= 2, undefined, { timeout: 5000 })

    // The same URL, navigated to afresh, lands where the URL says
    await tab.goto(url)
    await tab.waitForFunction(() => document.title === 'tall')
    await tab.waitForTimeout(2000)   // past the engine's tail, had it wrongly armed
    expect(await tab.evaluate(() => window.scrollY)).toBe(0)
  }, 120_000)
})
