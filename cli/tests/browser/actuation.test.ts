import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Browser, Page } from 'playwright'
import type { ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createRequire } from 'module'
import { launchBulb, requireDistBuild, runCli } from './harness/servers.js'

/**
 * Tier B — the actuation verbs, end to end (TB-Interrogation-Actuation.md). Resolution, naming,
 * and the gesture live page-side in the shim, which no node test can execute: only a real browser
 * establishes that a wrapped label names its control (and no longer swallows it), that a dispatched
 * click reaches the app's listener, that the covered/disabled findings hit-test real layout, and
 * that the native-setter-plus-events set defeats an instance-descriptor value tracker (React's
 * dedupe pattern, replicated here verbatim so the default browser run stays offline; the real-React
 * case below rides the net-gated convention, since react arrives from the CDN).
 *
 * Spawns the real CLI (dist build, like the reconnect suite) and drives every probe through
 * `typebulb send` itself, so what's tested is the whole path: CLI → /__send → SSE → shim → reply.
 */

const nodeRequire = createRequire(import.meta.url)
const { chromium } = nodeRequire('playwright') as typeof import('playwright')

const bulbSource = `---
format: typebulb/v1
name: Actuation Probe
---

**code.tsx**

\`\`\`tsx
const $ = (id: string) => document.getElementById(id)!
let clicks = 0
$("new").addEventListener("click", () => { clicks++; $("count").textContent = String(clicks) })
$("save").addEventListener("click", () => { $("count").textContent = "saved" })
$("saveAll").addEventListener("click", () => { $("count").textContent = "saved all" })
$("far").addEventListener("click", () => { $("count").textContent = "far" })
const mute = $("mute") as HTMLInputElement
mute.addEventListener("change", () => { $("count").textContent = "mute:" + mute.checked })
const skill = $("skill") as HTMLSelectElement
skill.addEventListener("change", () => { $("count").textContent = "level:" + skill.value })
const speed = $("speed") as HTMLInputElement
let inputs = 0
speed.addEventListener("input", () => { inputs++ })
speed.addEventListener("change", () => { $("count").textContent = "speed:" + speed.value + ":" + inputs })
// React's value-tracker pattern, verbatim: an instance descriptor shadows the prototype's, so a
// plain assignment records itself and the following input event reads as no-change. Only a write
// through the NATIVE prototype setter leaves the tracker stale and the event observable.
const tracked = $("tracked") as HTMLInputElement
const nativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!
let last = tracked.value
Object.defineProperty(tracked, "value", {
  configurable: true,
  get() { return nativeValue.get!.call(tracked) },
  set(v) { last = String(v); nativeValue.set!.call(tracked, v) },
})
tracked.addEventListener("input", () => {
  if (tracked.value !== last) { last = tracked.value; $("count").textContent = "tracked:" + tracked.value }
})
\`\`\`

**index.html**

\`\`\`html
<h1 id="count">0</h1>
<button id="new">New Game</button>
<button id="pass" disabled>Pass</button>
<button id="save">Save</button>
<button id="saveAll">Save All</button>
<div style="position:relative;width:120px">
  <button id="covered">Covered</button>
  <div id="overlay" style="position:absolute;inset:0"></div>
</div>
<label>strength
  <select id="skill">
    <option value="easiest">easiest</option>
    <option value="medium" selected>medium</option>
    <option value="hard">hard</option>
  </select>
</label>
<label>speed <input id="speed" value="3"></label>
<label>tracked <input id="tracked" value="a"></label>
<label>mute <input id="mute" type="checkbox"></label>
<input id="anon">
<input id="ro" readonly aria-label="frozen" value="x">
<div style="height:9.6px"></div>
<button id="frac" style="display:block;height:22.7px">Fractional</button>
<div style="height:1600px"></div>
<button id="far">Far Away</button>
\`\`\`

**styles.css**

\`\`\`css
html { scroll-behavior: smooth }
\`\`\`
`

// >400 outline lines, target beyond the cap: the cap bounds what's printed, not what's resolvable.
// Rows are buttons, not list items — a list whose name equals its text collapses to one line.
const deepBulbSource = `---
format: typebulb/v1
name: Deep Outline Probe
---

**code.tsx**

\`\`\`tsx
const list = document.getElementById("list")!
for (let i = 0; i < 450; i++) {
  const b = document.createElement("button")
  b.textContent = "row " + i
  list.appendChild(b)
}
const btn = document.createElement("button")
btn.textContent = "Deep Target"
btn.addEventListener("click", () => { document.querySelector("h1")!.textContent = "deep:clicked" })
document.body.appendChild(btn)
\`\`\`

**index.html**

\`\`\`html
<h1>deep:idle</h1>
<div id="list"></div>
\`\`\`
`

// The arrival wake, end to end: armed before any page exists, fired by the user opening the link.
const wakeBulbSource = `---
format: typebulb/v1
name: Wake Probe
---

**code.tsx**

\`\`\`tsx
document.getElementById("app")!.textContent = "hi"
\`\`\`

**index.html**

\`\`\`html
<div id="app"></div>
\`\`\`
`

let browser: Browser
let tab: Page
let home: string
let bulb: string
let url: string
let env: NodeJS.ProcessEnv
const running: ChildProcess[] = []

const launch = (file: string) => launchBulb(file, { cwd: home, env, track: running })
/** `typebulb send` against the real bin; the reply owns stdout, delivery/errors stderr. */
const sendCli = (file: string, message: string) => runCli(['send', file, message, '--wait=15000'], { cwd: home, env })

beforeAll(async () => {
  requireDistBuild()
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-actuation-'))
  env = { ...process.env, TYPEBULB_SERVERS_DIR: path.join(home, 'servers') }
  bulb = path.join(home, 'actuation-probe.bulb.md')
  fs.writeFileSync(bulb, bulbSource)
  url = await launch(bulb)
  browser = await chromium.launch()
  tab = await browser.newPage()
  await tab.goto(url)
  await tab.waitForFunction(() => document.getElementById('count')?.textContent === '0')
}, 120_000)

afterAll(async () => {
  await browser?.close()
  for (const child of running) child.kill()
  await new Promise(r => setTimeout(r, 500))
  try {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch { /* a temp dir the OS will reap */ }
})

describe('the outline names controls by their labels (live browser)', () => {
  it('label-derived names, value as a facet, and no swallowed wrapped select', async () => {
    const r = await sendCli(bulb, 'tb:snapshot')
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('combobox "strength" [value=medium]')
    expect(r.stdout).toContain('textbox "speed" [value=3]')
    expect(r.stdout).toContain('button "Pass" [disabled]')
    expect(r.stdout).not.toContain('- label')   // associated labels are naming material, not lines
  })
})

describe('the snapshot geometry line (live browser)', () => {
  it('heads the outline: viewport, content, and the overflow verdict', async () => {
    const r = await sendCli(bulb, 'tb:snapshot')
    expect(r.code).toBe(0)
    // The fixture's 1600px spacer overflows any headless viewport.
    expect(r.stdout.split('\n')[0]).toMatch(/^- page: viewport \d+×\d+, content \d+×\d+ — overflows vertically by \d+px/)
  })

  it('a page whose content fits says so', async () => {
    const fitBulb = path.join(home, 'fit-probe.bulb.md')
    fs.writeFileSync(fitBulb, wakeBulbSource)
    const fitUrl = await launch(fitBulb)
    const page = await browser.newPage()
    try {
      await page.goto(fitUrl)
      await page.waitForFunction(() => document.getElementById('app')?.textContent === 'hi')
      const r = await sendCli(fitBulb, 'tb:snapshot')
      expect(r.code).toBe(0)
      expect(r.stdout.split('\n')[0]).toMatch(/^- page: viewport \d+×\d+, content \d+×\d+ — fits/)
    } finally {
      await page.close()
    }
  }, 60_000)
})

describe('tb:click (live browser)', () => {
  it('clicks the named button; the reply is the changed frame', async () => {
    const r = await sendCli(bulb, 'tb:click button "New Game"')
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('- heading "1" [level=1]')
  })

  it('an exact name beats a substring superset', async () => {
    const r = await sendCli(bulb, 'tb:click button "Save"')
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('- heading "saved" [level=1]')
  })

  it('a unique case-insensitive substring resolves', async () => {
    const r = await sendCli(bulb, 'tb:click button "save a"')
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('- heading "saved all" [level=1]')
  })

  it('ambiguity is a reported error, never a guess', async () => {
    const r = await sendCli(bulb, 'tb:click button "Sav"')
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain('2 buttons match "Sav"')
  })

  it('zero matches lists the vocabulary', async () => {
    const r = await sendCli(bulb, 'tb:click button "Missing"')
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain('no button named "Missing"')
    expect(r.stderr).toContain('New Game')
  })

  it('a disabled control is a finding, not a no-op', async () => {
    const r = await sendCli(bulb, 'tb:click button "Pass"')
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain('disabled')
  })

  it('a covered control is a finding naming what owns the click', async () => {
    const r = await sendCli(bulb, 'tb:click button "Covered"')
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain('lands on div#overlay')
  })

  // The one control class the docs route through tb:click rather than tb:set — resting on the
  // browser fact that a synthetic click still runs a checkbox's activation behavior.
  it('toggles a checkbox, and the reply states the [checked] facet', async () => {
    const r = await sendCli(bulb, 'tb:click checkbox "mute"')
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('checkbox "mute" [checked]')
    expect(r.stdout).toContain('- heading "mute:true" [level=1]')
  })

  // The fixture's html has scroll-behavior: smooth — with an honoring (non-instant) scrollIntoView
  // the geometry reads land pre-scroll, the center hit-tests off-viewport, and this errors.
  it('clicks below the fold on a smooth-scrolling page — the hit-test reads settled layout', async () => {
    const r = await sendCli(bulb, 'tb:click button "Far Away"')
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('- heading "far" [level=1]')
  })

  it('resolves a target beyond the outline\'s printed line cap', async () => {
    const deepBulb = path.join(home, 'deep-outline-probe.bulb.md')
    fs.writeFileSync(deepBulb, deepBulbSource)
    const deepUrl = await launch(deepBulb)
    const page = await browser.newPage()
    try {
      await page.goto(deepUrl)
      await page.waitForFunction(() => document.querySelectorAll('button').length === 451)
      const r = await sendCli(deepBulb, 'tb:click button "Deep Target"')
      expect(r.code).toBe(0)
      expect(r.stdout).toContain('- heading "deep:clicked" [level=1]')
      expect(r.stdout).toContain('(truncated)')
    } finally {
      await page.close()
    }
  }, 60_000)
})

describe('tb:set (live browser)', () => {
  it('drives a select by its label, matching the option, firing change', async () => {
    const r = await sendCli(bulb, 'tb:set combobox "strength" = hard')
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('combobox "strength" [value=hard]')
    expect(r.stdout).toContain('- heading "level:hard" [level=1]')
  })

  it('fires input and change through the native setter', async () => {
    const r = await sendCli(bulb, 'tb:set textbox "speed" = 7')
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('- heading "speed:7:1" [level=1]')
  })

  it('defeats an instance value tracker — the React pattern', async () => {
    const r = await sendCli(bulb, 'tb:set textbox "tracked" = zz')
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('- heading "tracked:zz" [level=1]')
  })

  it('readonly is a finding', async () => {
    const r = await sendCli(bulb, 'tb:set textbox "frozen" = q')
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain('readonly')
  })

  it('an unlabeled control is untargetable, and the error coaches the fix', async () => {
    const r = await sendCli(bulb, 'tb:set textbox "nope" = 1')
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain('an aria-label would make them targetable')
  })
})

describe('tb:rect (live browser)', () => {
  it('replies with the control\'s rect and the viewport, and scrolls nothing', async () => {
    const before = await tab.evaluate(() => window.scrollY)
    const r = await sendCli(bulb, 'tb:rect button "Far Away"')
    expect(r.code).toBe(0)
    const rect = JSON.parse(r.stdout)
    expect(rect.width).toBeGreaterThan(0)
    expect(rect.height).toBeGreaterThan(0)
    expect(rect.viewport.height).toBeGreaterThan(0)
    expect(Number.isInteger(rect.x)).toBe(true)
    expect(Number.isInteger(rect.y)).toBe(true)
    expect(await tab.evaluate(() => window.scrollY)).toBe(before)
  })

  it('resolution speaks the actuation grammar', async () => {
    const r = await sendCli(bulb, 'tb:rect button "Missing"')
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain('no button named "Missing"')
  })

  // The fixture's fractional spacer + height make per-field rounding off by one here: edges must
  // round and dimensions derive, so derived sums are alignment-safe (TB-Interrogation.md).
  it('derived edges are the rounded true edges', async () => {
    const r = await sendCli(bulb, 'tb:rect button "Fractional"')
    expect(r.code).toBe(0)
    const rect = JSON.parse(r.stdout)
    const b = await tab.evaluate(() => {
      const el = document.getElementById('frac')!.getBoundingClientRect()
      return { right: el.right, bottom: el.bottom }
    })
    expect(rect.x + rect.width).toBe(Math.round(b.right))
    expect(rect.y + rect.height).toBe(Math.round(b.bottom))
  })
})

describe('the solo precondition (live browser)', () => {
  it('two connected pages refuse the gesture BEFORE it fires anywhere', async () => {
    const before = await tab.evaluate(() => document.getElementById('count')?.textContent)
    const second = await browser.newPage()
    await second.goto(url)
    await second.waitForFunction(() => document.getElementById('count')?.textContent === '0')
    try {
      const r = await sendCli(bulb, 'tb:click button "New Game"')
      expect(r.code).not.toBe(0)
      expect(r.stderr).toContain('exactly one connected page')
    } finally {
      await second.close()
    }
    // Pre-dispatch means neither page acted: the first tab's state is untouched.
    expect(await tab.evaluate(() => document.getElementById('count')?.textContent)).toBe(before)
  })
})

describe('the page-connect wake (live browser)', () => {
  it('a wait armed before any page exists wakes when the link is opened', async () => {
    const wakeBulb = path.join(home, 'wake-probe.bulb.md')
    fs.writeFileSync(wakeBulb, wakeBulbSource)
    const wakeUrl = await launch(wakeBulb)
    // Armed with no page connected; the filtered-from-0 cursor (TB-Wait.md) makes arm order immaterial.
    const waiting = runCli(['wait', wakeBulb, '--match', '[page] connected'], { cwd: home, env })
    const page = await browser.newPage()
    try {
      await page.goto(wakeUrl)
      const r = await waiting
      expect(r.code).toBe(0)
      expect(r.stdout).toContain('[page] connected')
    } finally {
      await page.close()
    }
  }, 60_000)
})

// Real React from the CDN — the tracker the offline case replicates, un-replicated.
describe.runIf(!!process.env.TB_NET_TESTS)('tb:set against real React (net-gated)', () => {
  const reactBulbSource = `---
format: typebulb/v1
name: React Actuation Probe
---

**code.tsx**

\`\`\`tsx
import React, { useState } from "react"
import { createRoot } from "react-dom/client"

function App() {
  const [v, setV] = useState("a")
  return <div><h1>react:{v}</h1><label>rv <input value={v} onChange={e => setV(e.target.value)} /></label></div>
}

createRoot(document.getElementById("root")!).render(<App />)
\`\`\`

**index.html**

\`\`\`html
<div id="root"></div>
\`\`\`

**config.json**

\`\`\`json
{
  "description": "Actuation probe for React's value tracker.",
  "dependencies": {
    "react": "^19.2.7",
    "react-dom": "^19.2.7"
  }
}
\`\`\`
`

  it('a controlled input sees the set — onChange fires and re-renders', async () => {
    const reactBulb = path.join(home, 'react-actuation-probe.bulb.md')
    fs.writeFileSync(reactBulb, reactBulbSource)
    const reactUrl = await launch(reactBulb)
    const page = await browser.newPage()
    try {
      await page.goto(reactUrl)
      await page.waitForFunction(() => document.querySelector('h1')?.textContent === 'react:a', undefined, { timeout: 60_000 })
      const r = await sendCli(reactBulb, 'tb:set textbox "rv" = zz')
      expect(r.code).toBe(0)
      expect(r.stdout).toContain('react:zz')
      expect(r.stdout).toContain('[value=zz]')
    } finally {
      await page.close()
    }
  }, 120_000)
})
