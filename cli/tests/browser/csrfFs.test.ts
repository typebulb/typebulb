import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Browser } from 'playwright'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import { startTypebulb, startStaticPage } from './harness/servers.js'
import type { ServerInstance } from '../../src/serve/server.js'

/**
 * Tier B — live exploit for the same-site CSRF finding (TB-Security-Tests.md,
 * TB-Security-Attacks.md). Where the Tier A test forges `Sec-Fetch-Site` and so can
 * only prove the server's *ruling*, this proves the *attack*: a REAL browser, a REAL
 * second origin, a REAL cross-origin `fetch`. It is the only layer that establishes
 * the two browser facts the node test cannot —
 *   1. Chromium stamps a cross-port localhost request `Sec-Fetch-Site: same-site`
 *      (not `cross-site`), so the current guard waves it through, and
 *   2. a `no-cors` + `text/plain` POST dodges preflight, so the write side-effect lands.
 *
 * Playwright is driven as a LIBRARY from inside vitest (not its own runner): the
 * victim boots via the runtime's `startServer`, whose `typebulb/*` self-imports only
 * resolve in vitest's context (no dist build). Reaping stays in vitest's afterAll.
 *
 * Before the fix: pwned.txt appears under the victim's basePath. After tightening the
 * guard from same-site to same-origin, the file never gets written (the test polls for it).
 */

const here = path.dirname(fileURLToPath(import.meta.url))

// Load Playwright through node's own require, bypassing Vite/vitest transform — it's a
// native module, not source to bundle; resolves from the runtime package's node_modules.
const nodeRequire = createRequire(import.meta.url)
const { chromium } = nodeRequire('playwright') as typeof import('playwright')

/** Wait up to `ms` for a file to appear. The no-cors response is opaque (and COEP
 *  aborts the browser's read of it), so the fetch result is NOT a reliable signal —
 *  the filesystem side-effect is. Returns true as soon as the write lands. */
async function pollExists(file: string, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return true
    await new Promise(r => setTimeout(r, 50))
  }
  return false
}

let browser: Browser
let victim: ServerInstance
let attacker: { origin: string; close: () => void }
let victimDir: string

beforeAll(async () => {
  browser = await chromium.launch()
  victimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-victim-'))
  victim = await startTypebulb({ basePath: victimDir, trusted: true })
  const html = fs
    .readFileSync(path.join(here, 'fixtures/attack-csrf-fs.html'), 'utf8')
    .replaceAll('__VICTIM_ORIGIN__', `http://localhost:${victim.port}`)
  attacker = await startStaticPage(html)
}, 60_000)

afterAll(async () => {
  await browser?.close()
  victim?.close()
  attacker?.close()
  if (victimDir) fs.rmSync(victimDir, { recursive: true, force: true })
})

describe('same-site CSRF to a Trusted bulb (live browser)', () => {
  it('a sibling localhost origin writes the victim\'s filesystem', async () => {
    const page = await browser.newPage()
    // Loading the attacker page fires the no-cors POST at the victim's /__fs/write.
    await page.goto(attacker.origin)
    // The write itself is the observable — watch the victim's filesystem, not the
    // fetch result (opaque / ERR_ABORTED under COEP).
    const landed = await pollExists(path.join(victimDir, 'pwned.txt'), 5_000)
    await page.close()

    // SECURE expectation: the cross-origin write is refused, so the file never appears.
    // RED before the fix — the same-site request passes the guard and the file lands.
    // GREEN after tightening the guard to same-origin.
    expect(landed).toBe(false)
  }, 30_000)

  // Liveness (over-restriction guard, real-browser grade): the fix tightens to
  // same-origin, so the bulb's OWN page must still reach its own /__fs. This stays
  // green across the fix — it is the legitimate path the restriction must not break.
  it('the victim\'s own page still reaches its own /__fs (same-origin liveness)', async () => {
    const page = await browser.newPage()
    await page.goto(`http://localhost:${victim.port}`)
    // A same-origin fetch from the bulb's own page — Sec-Fetch-Site: same-origin.
    await page.evaluate(() =>
      fetch('/__fs/write?path=legit.txt', { method: 'POST', body: 'ok' }).catch(() => {}),
    )
    const landed = await pollExists(path.join(victimDir, 'legit.txt'), 5_000)
    await page.close()
    expect(landed).toBe(true)
  }, 30_000)
})
