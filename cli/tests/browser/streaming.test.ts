import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Browser, Page } from 'playwright'
import type { ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createRequire } from 'module'
import { launchBulb, requireDistBuild, runCli } from './harness/servers.js'

/**
 * Tier B — the NDJSON streaming transport, end to end (TB-Streaming.md). The decoder lives
 * page-side in the shim, which no node test can execute: only a real page establishes that the
 * enveloped chunks decode across the wire, that a mid-stream throw rejects the consumer's
 * `for await` carrying the wire error shape ({message, code, retryable}), that the hybrid call
 * object keeps its mismatch promises (await a stream → array; for-await a single result → one
 * value), and — the "actually save compute" claim — that breaking the loop tears down the
 * server-side generator, observable as its `finally` writing a marker file.
 *
 * Spawns the real CLI (dist build, `--trust` for server.ts) and drives every probe through
 * `typebulb send` itself, so what's tested is the whole path: CLI → SSE → shim → /__api → reply.
 */

const nodeRequire = createRequire(import.meta.url)
const { chromium } = nodeRequire('playwright') as typeof import('playwright')

const bulbSource = `---
format: typebulb/v1
name: Streaming Probe
---

**code.tsx**

\`\`\`tsx
document.getElementById("state")!.textContent = "ready"
tb.onMessage(async (m) => {
  if (m === "chunks") {
    const out: unknown[] = []
    for await (const v of tb.server.count()) out.push(v)
    return out
  }
  if (m === "awaited") return await tb.server.count()      // await a stream → array of chunks
  if (m === "iterated") {                                  // for-await a single result → one value
    const out: unknown[] = []
    for await (const v of tb.server.single()) out.push(v)
    return out
  }
  if (m === "error") {
    const got: unknown[] = []
    try {
      for await (const v of tb.server.fail()) got.push(v)
      return "no throw"
    } catch (e: any) {
      return { got, message: e.message, code: e.code, retryable: e.retryable }
    }
  }
  if (m === "cancel") {
    for await (const v of tb.server.slow()) break
    return "broke"
  }
})
\`\`\`

**index.html**

\`\`\`html
<div id="state">booting</div>
\`\`\`

**server.ts**

\`\`\`ts
export async function* count() {
  yield 1
  yield 2
  yield 3
}

export async function single() {
  return "just one"
}

export async function* fail() {
  yield "first"
  throw new Error("boom mid-stream")
}

// Infinite by design: only a consumer break (→ abort → iterator.return) reaches the finally.
export async function* slow() {
  try {
    for (let i = 0; ; i++) {
      yield i
      await new Promise(r => setTimeout(r, 50))
    }
  } finally {
    await tb.fs.write("teardown-marker.txt", "torn down")
  }
}
\`\`\`
`

/** Wait up to `ms` for a file to appear — teardown lands async, after the abort propagates. */
async function pollExists(file: string, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return true
    await new Promise(r => setTimeout(r, 50))
  }
  return false
}

let browser: Browser
let tab: Page
let home: string
let bulb: string
let env: NodeJS.ProcessEnv
const running: ChildProcess[] = []

/** `typebulb send` against the real bin; the reply owns stdout, delivery/errors stderr. */
const sendCli = (message: string) => runCli(['send', bulb, message, '--wait=15000'], { cwd: home, env })

beforeAll(async () => {
  requireDistBuild()
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-streaming-'))
  env = { ...process.env, TYPEBULB_SERVERS_DIR: path.join(home, 'servers') }
  bulb = path.join(home, 'streaming-probe.bulb.md')
  fs.writeFileSync(bulb, bulbSource)
  const url = await launchBulb(bulb, { cwd: home, env, track: running, args: ['--trust'] })
  browser = await chromium.launch()
  tab = await browser.newPage()
  await tab.goto(url)
  await tab.waitForFunction(() => document.getElementById('state')?.textContent === 'ready')
}, 120_000)

afterAll(async () => {
  await browser?.close()
  for (const child of running) child.kill()
  await new Promise(r => setTimeout(r, 500))
  try {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch { /* a temp dir the OS will reap */ }
})

describe('streamed tb.server.<gen>() (live browser)', () => {
  it('chunks arrive in order through the page-side decoder', async () => {
    const r = await sendCli('chunks')
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual([1, 2, 3])
  })

  it('a mid-stream throw rejects the for-await with the wire error shape, after partial chunks', async () => {
    const r = await sendCli('error')
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual({ got: ['first'], message: 'boom mid-stream', code: 'unknown', retryable: false })
  })
})

describe('the hybrid call object keeps its mismatch promises (live browser)', () => {
  it('awaiting a streamed export resolves with the array of chunks', async () => {
    const r = await sendCli('awaited')
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual([1, 2, 3])
  })

  it('for-awaiting a normal export yields its one result', async () => {
    const r = await sendCli('iterated')
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual(['just one'])
  })
})

describe('breaking the loop tears down the source generator (live browser)', () => {
  it('the server generator\'s finally runs after a consumer break', async () => {
    const r = await sendCli('cancel')
    expect(r.code).toBe(0)
    expect(r.stdout.trim()).toBe('broke')
    // The observable is server-side: abort → iterator.return() → the generator's finally writes.
    // Relative tb.fs paths land in the bulb's stem-named folder (TB-FS.md), not beside the file.
    expect(await pollExists(path.join(home, 'streaming-probe', 'teardown-marker.txt'), 10_000)).toBe(true)
  }, 30_000)
})
