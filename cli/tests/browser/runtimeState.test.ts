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

// The setters hand back nothing, so "one encode or two" is observed on the wire instead.
let encodes = 0
const origFetch = window.fetch
window.fetch = ((...args: any[]) => {
  if (String(args[0]).indexOf("/__tb-encode") >= 0) encodes++
  return origFetch.apply(window, args as any)
}) as typeof fetch

const read = async () => ({
  data: tb.data(0), insight: tb.insight(), hash: location.hash, url: await tb.url(), encodes
})
document.getElementById("out")!.textContent = tb.data(0)

tb.onMessage(async (m: any) => {
  if (m === "read") return await read()
  if (m === "set") {
    encodes = 0
    await tb.setData("promoted")
    return await read()
  }
  if (m === "both") {
    encodes = 0
    await Promise.all([tb.setData("paired"), tb.setInsight({ from: "runtime" })])
    return await read()
  }
  if (m === "midflight") {
    // The second write lands while the first encode is already on the wire, so it cannot ride it.
    encodes = 0
    const first = tb.setData("stale")
    await new Promise(r => setTimeout(r, 0))
    await tb.setInsight({ from: "late" })
    await first
    return await read()
  }
  if (m === "big") {
    encodes = 0
    await tb.setData(noise(100000))
    return { len: (tb.data(0) as string).length, ...(await read()) }
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
  it('swaps the run, writes the address bar, and leaves the untouched slot on the file', async () => {
    const r = await send('set')
    expect(r.data).toBe('promoted')                 // globals moved before the await resolved
    expect(r.hash.startsWith('#tb=1:')).toBe(true)  // and the address bar holds the run...
    expect(r.url).toContain(r.hash)                 // ...which is how a bulb reads the link back
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
    // Two encodes would have written two fragments: data-only, then the pair.
    expect(r.encodes).toBe(1)
    expect(r.data).toBe('paired')
    expect(r.insight).toEqual({ from: 'runtime' })
    expect(r.hash.startsWith('#tb=1:')).toBe(true)
  })

  it('clears the fragment when the new state is too large to carry', async () => {
    await send('set')                                // a fragment is present...
    const r = await send('big')
    expect(r.len).toBe(100000)                       // ...the oversized set still swaps the run...
    expect(r.hash).toBe('')                          // ...and the stale fragment is gone.
    expect(r.url).not.toContain('#tb=')              // Nothing left to share, and nothing claiming to be.
  })

  it('re-encodes a write that lands after the request is already on the wire', async () => {
    // The coalescing window closes when the body is read, not when the response comes back. A
    // write after that cannot ride the request carrying it, so it has to queue its own: otherwise
    // the page moves and the address bar keeps addressing the run before it (Invariant 6).
    const r = await send('midflight')
    expect(r.encodes).toBe(2)
    expect(r.data).toBe('stale')
    expect(r.insight).toEqual({ from: 'late' })
    // The second encode is the one the address bar kept: reloading it restores the pair, not the
    // data-only state that was already on the wire when the late write landed.
    await tab.goto(r.url)
    const after = await send('read')
    expect(after.data).toBe('stale')
    expect(after.insight).toEqual({ from: 'late' })
  })
})
