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
$("rescan").addEventListener("click", () => { $("count").textContent = "rescan" })
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
<header>
  <button id="rescan" aria-label="Rescan">↻</button>
  <span>AI badge</span>
</header>
<ul><li>Apple</li><li>Banana</li></ul>
<p>Read the <a href="#">docs</a> now</p>
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

/** A bulb whose code.tsx cannot be parsed. The server still serves a page — with broken code, so it
 *  renders nothing — which is why the reserved reads must name the cause themselves. */
const brokenBulbSource = `---
format: typebulb/v1
name: Broken Probe
---

**code.tsx**

\`\`\`tsx
const unclosed = (
document.getElementById("app")!.textContent = "never runs"
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

describe('a failed compile is stated, not implied (live browser)', () => {
  it('every reserved read names it instead of describing the empty page', async () => {
    const brokenBulb = path.join(home, 'broken-probe.bulb.md')
    fs.writeFileSync(brokenBulb, brokenBulbSource)
    const brokenUrl = await launch(brokenBulb)
    const page = await browser.newPage()
    try {
      await page.goto(brokenUrl)
      await page.waitForFunction(() => (window as any).__TB_COMPILE_ERROR__ !== undefined)
      // Without this the page answers truthfully and uselessly — '(empty page)', 'no canvas in the
      // page' — which reads identically to a bulb that simply draws nothing.
      for (const verb of ['tb:snapshot', 'tb:png']) {
        const r = await sendCli(brokenBulb, verb)
        expect(r.code).not.toBe(0)
        expect(r.stderr + r.stdout).toContain('did not compile')
      }
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

describe('semantic containers descend — the collapse fix (live browser)', () => {
  // The fixture's <header>/<ul>/<p> are the field case (TB-Interrogation-Actuation.md, found
  // defect): every one has an implicit role and a content-derived name, so before the fix each
  // swallowed its subtree as one line and nothing inside was targetable.
  it('a header goes bare and its aria-labelled control is outlined', async () => {
    const r = await sendCli(bulb, 'tb:snapshot')
    expect(r.code).toBe(0)
    expect(r.stdout).toMatch(/^\s*- banner$/m)              // bare: its subtree speaks for itself
    expect(r.stdout).toMatch(/^\s*- button "Rescan"$/m)
    expect(r.stdout).toMatch(/^\s*- text: AI badge$/m)      // interleaved text survives the descent
  })

  it('a leaf container keeps the readable one-line form; its parent list goes bare', async () => {
    const r = await sendCli(bulb, 'tb:snapshot')
    expect(r.stdout).toMatch(/^\s*- listitem "Apple"$/m)
    expect(r.stdout).not.toContain('- text: Apple')          // collapsed, not doubled as a text line
    expect(r.stdout).toMatch(/^\s*- list$/m)
  })

  it('a paragraph with a link keeps its prose around the link line', async () => {
    const r = await sendCli(bulb, 'tb:snapshot')
    expect(r.stdout).toMatch(/^\s*- paragraph$/m)
    expect(r.stdout).toMatch(/^\s*- link "docs"$/m)
    expect(r.stdout).toMatch(/^\s*- text: Read the$/m)
    expect(r.stdout).toMatch(/^\s*- text: now$/m)
  })

  it('a control inside a semantic container is clickable', async () => {
    const r = await sendCli(bulb, 'tb:click button "Rescan"')
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('- heading "rescan" [level=1]')
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

describe('tb:png (live browser)', () => {
  // Sole visible canvas — the hidden scratch sibling must not force the naming form
  // (TB-Interrogation-Pixels.md: resolution counts exactly what the walk sees).
  const canvasBulbSource = `---
format: typebulb/v1
name: Canvas Probe
---

**code.tsx**

\`\`\`tsx
const c = document.getElementById("art") as HTMLCanvasElement
c.width = 2; c.height = 2
const g = c.getContext("2d")!
g.fillStyle = "#ff0000"
g.fillRect(0, 0, 2, 2)
document.getElementById("s")!.textContent = "drawn"
\`\`\`

**index.html**

\`\`\`html
<h1 id="s">idle</h1>
<canvas id="art"></canvas>
<canvas id="scratch" hidden></canvas>
\`\`\`
`

  const twoCanvasBulbSource = `---
format: typebulb/v1
name: Layers Probe
---

**code.tsx**

\`\`\`tsx
const paint = (id: string, color: string) => {
  const c = document.getElementById(id) as HTMLCanvasElement
  c.width = 1; c.height = 1
  const g = c.getContext("2d")!
  g.fillStyle = color
  g.fillRect(0, 0, 1, 1)
}
paint("base", "#ff0000")
paint("overlay", "#0000ff")
document.getElementById("s")!.textContent = "drawn"
\`\`\`

**index.html**

\`\`\`html
<h1 id="s">idle</h1>
<canvas id="base" aria-label="base"></canvas>
<canvas id="overlay" aria-label="overlay"></canvas>
\`\`\`
`

  // Same server, different host: localhost's page drawing 127.0.0.1's image taints the canvas
  // without any network dependency — the cheapest real cross-origin draw a test can make.
  const taintBulbSource = `---
format: typebulb/v1
name: Taint Probe
---

**code.tsx**

\`\`\`tsx
const img = new Image()
img.onload = () => {
  const c = document.getElementById("t") as HTMLCanvasElement
  c.width = 1; c.height = 1
  c.getContext("2d")!.drawImage(img, 0, 0)
  document.getElementById("s")!.textContent = "tainted"
}
img.src = location.origin.replace("localhost", "127.0.0.1") + "/assets/dot.png"
\`\`\`

**index.html**

\`\`\`html
<h1 id="s">idle</h1>
<canvas id="t"></canvas>
\`\`\`
`

  // An untouched transparent canvas over a known page background: the whole frame must come back
  // as that background, not as transparent-reading-white (TB-Interrogation-Pixels.md, backdrop).
  const backdropBulbSource = `---
format: typebulb/v1
name: Backdrop Probe
---

**code.tsx**

\`\`\`tsx
const c = document.getElementById("art") as HTMLCanvasElement
c.width = 2; c.height = 2
c.getContext("2d")!
document.getElementById("s")!.textContent = "drawn"
\`\`\`

**index.html**

\`\`\`html
<h1 id="s">idle</h1>
<canvas id="art"></canvas>
\`\`\`

**styles.css**

\`\`\`css
body { background: #00ff00; }
\`\`\`
`

  // The chart-library shape: the author owns the wrapper, the library owns the canvas. A second
  // canvas forces the naming form, so the wrapper is the only way in.
  const wrapperBulbSource = `---
format: typebulb/v1
name: Wrapper Probe
---

**code.tsx**

\`\`\`tsx
const paint = (id: string, color: string) => {
  const c = document.getElementById(id) as HTMLCanvasElement
  c.width = 1; c.height = 1
  const g = c.getContext("2d")!
  g.fillStyle = color
  g.fillRect(0, 0, 1, 1)
}
paint("inner", "#0000ff")
paint("other", "#ff0000")
document.getElementById("s")!.textContent = "drawn"
\`\`\`

**index.html**

\`\`\`html
<h1 id="s">idle</h1>
<div role="img" aria-label="chart"><canvas id="inner"></canvas><canvas id="scratch" hidden></canvas></div>
<canvas id="other" aria-label="other"></canvas>
<div aria-label="legend">no role, so no line</div>
\`\`\`
`

  // The two layers the walk must get right: a canvas's OWN background (it paints behind the bitmap,
  // so it is the nearest layer under the pixels), and a translucent ancestor (stopping there would
  // paint a half-transparent backdrop and hand back a PNG that still composites on white).
  const layerBulbSource = `---
format: typebulb/v1
name: Layer Probe
---

**code.tsx**

\`\`\`tsx
for (const id of ["own", "veiled"]) {
  const c = document.getElementById(id) as HTMLCanvasElement
  c.width = 2; c.height = 2
  c.getContext("2d")!
}
document.getElementById("s")!.textContent = "drawn"
\`\`\`

**index.html**

\`\`\`html
<h1 id="s">idle</h1>
<canvas id="own" aria-label="own"></canvas>
<div class="veil" role="img" aria-label="veiled"><canvas id="veiled"></canvas></div>
\`\`\`

**styles.css**

\`\`\`css
#own { background: #0000ff; }
.veil { background: rgba(0, 255, 0, 0.5); }
\`\`\`
`

  /** Decode a written PNG back through the browser and return its (0,0) RGBA. */
  const pixelAt = (page: Page, pngPath: string) => {
    const b64 = fs.readFileSync(pngPath).toString('base64')
    return page.evaluate(async (data: string) => {
      const img = new Image()
      img.src = 'data:image/png;base64,' + data
      await img.decode()
      const c = document.createElement('canvas')
      c.width = img.width; c.height = img.height
      const g = c.getContext('2d')!
      g.drawImage(img, 0, 0)
      return Array.from(g.getImageData(0, 0, 1, 1).data)
    }, b64)
  }

  it('reads the sole visible canvas back — known pixels, no name, no probe handler', async () => {
    const canvasBulb = path.join(home, 'canvas-probe.bulb.md')
    fs.writeFileSync(canvasBulb, canvasBulbSource)
    const canvasUrl = await launch(canvasBulb)
    const page = await browser.newPage()
    try {
      await page.goto(canvasUrl)
      await page.waitForFunction(() => document.getElementById('s')?.textContent === 'drawn')
      const r = await sendCli(canvasBulb, 'tb:png')
      expect(r.code).toBe(0)
      const out = r.stdout.trim()
      expect(out.endsWith('.png')).toBe(true)
      expect(await pixelAt(page, out)).toEqual([255, 0, 0, 255])
      expect(r.stderr).toContain('canvas 2×2')
    } finally {
      await page.close()
    }
  }, 60_000)

  it('no canvas in the page is an error saying so', async () => {
    const r = await sendCli(bulb, 'tb:png')
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain('no canvas in the page')
  })

  it('two canvases are an ambiguity error listing names; a name resolves', async () => {
    const layersBulb = path.join(home, 'layers-probe.bulb.md')
    fs.writeFileSync(layersBulb, twoCanvasBulbSource)
    const layersUrl = await launch(layersBulb)
    const page = await browser.newPage()
    try {
      await page.goto(layersUrl)
      await page.waitForFunction(() => document.getElementById('s')?.textContent === 'drawn')
      const bare = await sendCli(layersBulb, 'tb:png')
      expect(bare.code).not.toBe(0)
      expect(bare.stderr).toContain('2 canvases here')
      expect(bare.stderr).toContain('"base"')
      expect(bare.stderr).toContain('"overlay"')
      const named = await sendCli(layersBulb, 'tb:png "overlay"')
      expect(named.code).toBe(0)
      expect(await pixelAt(page, named.stdout.trim())).toEqual([0, 0, 255, 255])
    } finally {
      await page.close()
    }
  }, 60_000)

  it('a tainted canvas is a finding naming the cause, never empty output', async () => {
    const taintBulb = path.join(home, 'taint-probe.bulb.md')
    fs.writeFileSync(taintBulb, taintBulbSource)
    // A real 1×1 PNG in the bulb's assets/, fetched via 127.0.0.1 so the draw is cross-origin.
    const assetsDir = path.join(home, 'taint-probe', 'assets')
    fs.mkdirSync(assetsDir, { recursive: true })
    fs.writeFileSync(path.join(assetsDir, 'dot.png'),
      Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
    const taintUrl = await launch(taintBulb)
    const page = await browser.newPage()
    try {
      await page.goto(taintUrl)
      await page.waitForFunction(() => document.getElementById('s')?.textContent === 'tainted')
      const r = await sendCli(taintBulb, 'tb:png')
      expect(r.code).not.toBe(0)
      expect(r.stderr).toContain('tainted by a cross-origin draw')
      expect(r.stdout.trim()).toBe('')
    } finally {
      await page.close()
    }
  }, 60_000)

  it('composites the page backdrop, so a transparent canvas is not a white frame', async () => {
    const backdropBulb = path.join(home, 'backdrop-probe.bulb.md')
    fs.writeFileSync(backdropBulb, backdropBulbSource)
    const backdropUrl = await launch(backdropBulb)
    const page = await browser.newPage()
    try {
      await page.goto(backdropUrl)
      await page.waitForFunction(() => document.getElementById('s')?.textContent === 'drawn')
      const r = await sendCli(backdropBulb, 'tb:png')
      expect(r.code).toBe(0)
      expect(await pixelAt(page, r.stdout.trim())).toEqual([0, 255, 0, 255])
    } finally {
      await page.close()
    }
  }, 60_000)

  it('a named container resolves to the single canvas inside it', async () => {
    const wrapperBulb = path.join(home, 'wrapper-probe.bulb.md')
    fs.writeFileSync(wrapperBulb, wrapperBulbSource)
    const wrapperUrl = await launch(wrapperBulb)
    const page = await browser.newPage()
    try {
      await page.goto(wrapperUrl)
      await page.waitForFunction(() => document.getElementById('s')?.textContent === 'drawn')
      const r = await sendCli(wrapperBulb, 'tb:png "chart"')
      expect(r.code).toBe(0)
      expect(await pixelAt(page, r.stdout.trim())).toEqual([0, 0, 255, 255])
      // The descent is stated, not silent — and a hidden scratch sibling inside the wrapper must
      // not force an ambiguity the sole-canvas form wouldn't (the counting rule follows the walk).
      expect(r.stderr).toContain('inside "chart"')
    } finally {
      await page.close()
    }
  }, 60_000)

  // A label the author DID write, on an element with no role: the outline has no line for it, and
  // the error must name that cause rather than list the names they didn't write.
  it('names why a labelled element is untargetable instead of reporting an absence', async () => {
    const wrapperBulb = path.join(home, 'wrapper-probe.bulb.md')
    const wrapperUrl = await launch(wrapperBulb)
    const page = await browser.newPage()
    try {
      await page.goto(wrapperUrl)
      await page.waitForFunction(() => document.getElementById('s')?.textContent === 'drawn')
      const r = await sendCli(wrapperBulb, 'tb:png "legend"')
      expect(r.code).not.toBe(0)
      expect(r.stderr).toContain('has no role')
      expect(r.stderr).toContain('role="img"')
    } finally {
      await page.close()
    }
  }, 60_000)

  it('composites the canvas own background, and never stops at a translucent layer', async () => {
    const layerBulb = path.join(home, 'layer-probe.bulb.md')
    fs.writeFileSync(layerBulb, layerBulbSource)
    const layerUrl = await launch(layerBulb)
    const page = await browser.newPage()
    try {
      await page.goto(layerUrl)
      await page.waitForFunction(() => document.getElementById('s')?.textContent === 'drawn')
      // `canvas { background }` paints behind the bitmap — the nearest layer, so the walk starts at
      // the canvas itself, not its parent.
      const own = await sendCli(layerBulb, 'tb:png "own"')
      expect(own.code).toBe(0)
      expect(await pixelAt(page, own.stdout.trim())).toEqual([0, 0, 255, 255])
      // A half-transparent ancestor is a layer, not the bottom: whatever the composite ends up
      // looking like, the ONE thing it must guarantee is a frame with no alpha left in it.
      const veiled = await sendCli(layerBulb, 'tb:png "veiled"')
      expect(veiled.code).toBe(0)
      expect((await pixelAt(page, veiled.stdout.trim()))[3]).toBe(255)
      expect(veiled.stderr).toContain('rgba(0, 255, 0, 0.5)')
    } finally {
      await page.close()
    }
  }, 60_000)
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
