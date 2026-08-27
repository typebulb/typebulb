import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Browser, Page } from 'playwright'
import type { ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createRequire } from 'module'
import { launchBulb, requireDistBuild, runCli } from './harness/servers.js'

/**
 * Tier B — tb.setData and the `#tb=` fragment, end to end (TB-State.md). The node route
 * tests already pin the codec and both routes; what only a real browser establishes is the shim's
 * glue: that the globals move before the await resolves, that the address bar ends up holding the
 * run (and stops holding one that no longer fits), and that a reload of that URL restores it
 * through `__tbBoot` ahead of the bulb's synchronous startup reads.
 *
 * Spawns the real CLI (dist build) and drives every probe through `typebulb send`, like the
 * actuation suite, so the whole path is under test: CLI → /__send → SSE → shim → /__tb-encode.
 */

const nodeRequire = createRequire(import.meta.url)
const { chromium } = nodeRequire('playwright') as typeof import('playwright')

const bulbSource = `---
format: typebulb/v1
name: Runtime State Probe
---

**code.tsx**

\`\`\`tsx
/** Deterministic high-entropy filler — repetitive text deflates under the ceiling. */
const noise = (n: number) => {
  let s = 123456789
  const out: string[] = []
  for (let i = 0; i < n; i++) { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; out.push(String.fromCharCode(33 + (s >>> 0) % 90)) }
  return out.join("")
}

const read = () => ({ data: tb.data(0), insight: tb.insight(), hash: location.hash })
document.getElementById("out")!.textContent = tb.data(0)

tb.onMessage(async (m: any) => {
  if (m === "read") return read()
  if (m === "set") {
    const url = await tb.setData("promoted")
    return { url: url ?? null, ...read() }
  }
  if (m === "both") {
    const [u1, u2] = await Promise.all([tb.setData("paired"), tb.setInsight({ from: "runtime" })])
    return { same: u1 === u2, ...read() }
  }
  if (m === "midflight") {
    // The second write lands while the first encode is already on the wire, so it cannot ride it.
    const first = tb.setData("stale")
    await new Promise(r => setTimeout(r, 0))
    const second = await tb.setInsight({ from: "late" })
    return { first: (await first) ?? null, second: second ?? null, ...read() }
  }
  if (m === "big") {
    const url = await tb.setData(noise(100000))
    return { url: url ?? null, len: (tb.data(0) as string).length, hash: location.hash }
  }
})
\`\`\`

**index.html**

\`\`\`html
<div id="out"></div>
\`\`\`

**data.txt**

\`\`\`txt
from the file
\`\`\`

**insight.json**

\`\`\`json
{ "source": "file" }
\`\`\`
`

const nodeRequireEnv = () => ({ ...process.env, TYPEBULB_SERVERS_DIR: path.join(home, 'servers') })

let home: string
let bulb: string
let url: string
let browser: Browser
let tab: Page
const kids: ChildProcess[] = []

const send = async (msg: string) => {
  const r = await runCli(['send', bulb, msg, '--wait=20000'], { cwd: home, env: nodeRequireEnv() })
  expect(r.code, r.stderr).toBe(0)
  return JSON.parse(r.stdout)
}

beforeAll(async () => {
  requireDistBuild()
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-runtime-state-'))
  bulb = path.join(home, 'runtime-state-probe.bulb.md')
  fs.writeFileSync(bulb, bulbSource)
  url = await launchBulb(bulb, { cwd: home, env: nodeRequireEnv(), track: kids })
  browser = await chromium.launch()
  tab = await browser.newPage()
  await tab.goto(url)
  await tab.waitForFunction(() => document.getElementById('out')?.textContent === 'from the file')
}, 120_000)

afterAll(async () => {
  await browser?.close()
  for (const k of kids) { try { k.kill() } catch { /* already gone */ } }
  try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* best effort */ }
})

describe('tb.setData', () => {
  it('swaps the run, hands back a link, and leaves the untouched slot on the file', async () => {
    const r = await send('set')
    expect(r.data).toBe('promoted')                 // globals moved before the await resolved
    expect(r.url).toContain('#tb=1:')
    expect(r.hash.startsWith('#tb=1:')).toBe(true)  // and the address bar holds the run
    // Nobody set insight, so it stays the file's block rather than being carried along empty.
    expect(r.insight).toEqual({ source: 'file' })
  })

  it('restores that run on a reload of the link', async () => {
    const { url: shared } = await send('set')
    await tab.goto(shared)
    // Read through the CLI, not the DOM: this asserts tb.data() itself was restored ahead of the
    // bulb's startup reads, which is what __tbBoot exists for.
    const r = await send('read')
    expect(r.data).toBe('promoted')
    expect(r.insight).toEqual({ source: 'file' })
  })

  it('coalesces two setters in one tick into a single encode', async () => {
    const r = await send('both')
    // Two encodes would have produced two different fragments (data-only, then the pair), so one
    // shared URL is the observable proof that the pair was deflated and written once.
    expect(r.same).toBe(true)
    expect(r.data).toBe('paired')
    expect(r.insight).toEqual({ from: 'runtime' })
    expect(r.hash.startsWith('#tb=1:')).toBe(true)
  })

  it('clears the fragment when the new state is too large to carry', async () => {
    await send('set')                                // a fragment is present...
    const r = await send('big')
    expect(r.url).toBeNull()                         // ...the oversized set reports no link...
    expect(r.len).toBe(100000)                       // ...but the run still swapped...
    expect(r.hash).toBe('')                          // ...and the stale fragment is gone.
  })

  it('re-encodes a write that lands after the request is already on the wire', async () => {
    // The coalescing window closes when the body is read, not when the response comes back. A
    // write after that cannot ride the request carrying it, so it has to queue its own: otherwise
    // the page moves and the address bar keeps addressing the run before it (Invariant 6).
    const r = await send('midflight')
    expect(r.data).toBe('stale')
    expect(r.insight).toEqual({ from: 'late' })
    expect(r.second).not.toBe(r.first)               // the late write got its own link...
    expect(r.second).toContain('#tb=1:')
    expect(r.hash).toBe(new URL(r.second).hash)      // ...and it is the one in the address bar.
  })
})
