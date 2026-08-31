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

/** The modal's root is closed (TB-Inference.md Invariant 1), so nothing outside the page can read
 *  it. Force it open at the source, before the modal module is ever fetched: this fixture is the
 *  only vantage point its DOM has. */
let modalRoot: any = null
const attachShadow = Element.prototype.attachShadow
Element.prototype.attachShadow = function (init: any) {
  modalRoot = attachShadow.call(this, { ...init, mode: "open" })
  return modalRoot
}

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
  if (m === "modal") {
    void tb.infer()
    for (let i = 0; i < 200 && !(modalRoot && modalRoot.querySelector(".note")); i++) {
      await new Promise(r => setTimeout(r, 25))
    }
    const root = modalRoot
    const model = root.querySelector(".model")
    return {
      title: root.querySelector("h1").textContent,
      note: root.querySelector(".note").textContent,
      buttons: Array.from(root.querySelectorAll("button")).map((b: any) => b.getAttribute("aria-label") || b.textContent),
      chunks: Array.from(root.querySelectorAll("textarea")).map((t: any) => t.value),
      readOnly: Array.from(root.querySelectorAll("textarea")).every((t: any) => t.readOnly),
      model: model ? model.textContent : null,
    }
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

/** A second probe, this one WITH an infer.md block, so the modal builds its run half. Only the
 *  seed is under test: what the page holds beats the file's chunks (TB-Inference.md, "Data seed").
 *  Nothing runs — /__infer wants a provider, and this server has no --trust either way. */
const inferBulbSource = `---
format: typebulb/v1
name: Infer Seed Probe
---

**code.tsx**

\`\`\`tsx
let modalRoot: any = null
const attachShadow = Element.prototype.attachShadow
Element.prototype.attachShadow = function (init: any) {
  modalRoot = attachShadow.call(this, { ...init, mode: "open" })
  return modalRoot
}

tb.onMessage(async (m: any) => {
  if (m === "set") { await tb.setData(["held A", "held B"]); return true }
  if (m === "modal") {
    void tb.infer()
    for (let i = 0; i < 200 && !(modalRoot && modalRoot.querySelector("textarea")); i++) {
      await new Promise(r => setTimeout(r, 25))
    }
    return {
      title: modalRoot.querySelector("h1").textContent,
      chunks: Array.from(modalRoot.querySelectorAll("textarea")).map((t: any) => t.value),
    }
  }
})
\`\`\`

**index.html**

\`\`\`html
<div id="out">ready</div>
\`\`\`

**data.txt**

\`\`\`txt
from the file
\`\`\`

**infer.md**

\`\`\`md
Echo the data back.
\`\`\`
`

let home: string
let bulb: string
let url: string
let bulb2: string
let url2: string
let browser: Browser
let tab: Page
const kids: ChildProcess[] = []

const sendTo = async (file: string, msg: string) => {
  const r = await runCli(['send', file, msg, '--wait=20000'], { cwd: home, env: nodeRequireEnv() })
  expect(r.code, r.stderr).toBe(0)
  return JSON.parse(r.stdout)
}
const send = (msg: string) => sendTo(bulb, msg)
const send2 = (msg: string) => sendTo(bulb2, msg)

beforeAll(async () => {
  requireDistBuild()
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-runtime-state-'))
  bulb = path.join(home, 'runtime-state-probe.bulb.md')
  fs.writeFileSync(bulb, bulbSource)
  url = await launchBulb(bulb, { cwd: home, env: nodeRequireEnv(), track: kids })
  bulb2 = path.join(home, 'infer-seed-probe.bulb.md')
  fs.writeFileSync(bulb2, inferBulbSource)
  url2 = await launchBulb(bulb2, { cwd: home, env: nodeRequireEnv(), track: kids })
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

/**
 * The Bulb state panel (TB-Inference.md). This probe has no `infer.md` block, so tb.infer() opens
 * the modal with its run half dropped: locally that modal is also the only door to runtime state,
 * and a bulb that just writes the slots would otherwise meet a Run button whose one outcome is a
 * 400. Each case reloads first, so the panel reads a known slot rather than the last test's.
 */
describe('the Bulb state panel', () => {
  it('opens without run affordances on a bulb that cannot infer', async () => {
    await tab.goto(url)
    const r = await send('modal')
    expect(r.title).toBe('Bulb state')
    expect(r.model).toBe(null)         // the model line names a run that cannot happen
    expect(r.buttons).not.toContain('Run')
    expect(r.buttons).toContain('Close')
    // Nothing has overridden the file, so the readout is the file's own chunk: the panel answers
    // what tb.data() answers, and it is a readout, not an editor — Save posts the pair.
    expect(r.chunks).toEqual(['from the file'])
    expect(r.readOnly).toBe(true)
    // Nothing set, so nothing to file — and the panel says which layer the page is on instead.
    expect(r.note).toContain('Nothing set')
    expect(r.buttons).not.toContain('Save to bulb')
  })

  it('names what Save would file once a setter has written a slot', async () => {
    await tab.goto(url)
    await send('set')
    const r = await send('modal')
    expect(r.title).toBe('Bulb state')
    expect(r.chunks).toEqual(['promoted'])            // the slot now, not the file
    // Save posts the runtime pair, never a textarea, so the caption is what makes its payload
    // visible. Only what it writes: insight is unset here, and saying so would name a non-event.
    expect(r.note).toBe('Save writes data.txt (8 chars)')
    expect(r.buttons).toEqual(expect.arrayContaining(['Save to bulb', 'Discard run', 'Copy share URL', 'Close']))
  })
})

/**
 * The confirm view's data seed (TB-Inference.md, "Data seed"): the page's own slot beats the
 * file's chunks, so reopening the modal after a setter shows the chunks the page is actually on.
 * An earlier draft seeded from source only, and "I set 20k of data and the modal still showed the
 * file's" is what that cost.
 */
describe('the modal seeds from what the page holds', () => {
  it('falls through to the file chunks while the slot is empty', async () => {
    await tab.goto(url2)
    const r = await send2('modal')
    expect(r.title).toBe('Run AI inference')
    expect(r.chunks).toEqual(['from the file'])
  })

  it('shows the runtime chunks once a setter has written them', async () => {
    await tab.goto(url2)
    await send2('set')
    const r = await send2('modal')
    expect(r.chunks).toEqual(['held A', 'held B'])
  })
})
