import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { EventEmitter } from 'events'
import { Readable } from 'stream'
import * as net from 'net'
import * as http from 'http'
import * as path from 'path'
import { mkdtemp, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { startServer, type ServerInstance } from '../src/serve/server.js'
import { RELOAD_SETTLE_MS } from '../src/serve/pages.js'
import { parseArgs } from '../src/args.js'
import { runSend } from '../src/commands/send.js'
import { registerServer, unregisterServer, relayOpen } from '../src/serve/serverRegistry.js'
import { canvasPngPath } from '../src/serve/paths.js'

/**
 * `typebulb send` → `/__send` (TB-CLI.md). The endpoint fans the posted body out over the server's
 * page set — the SSE streams the shim's `tb.onMessage` reads, and the same set it reports as the
 * connected-page count (TB-Page-Lifecycle.md, invariant 6) — so every page here is a real stream.
 * It's data-in/trust-free but CSRF-guarded like `/__log`: the CLI (no Origin) passes; a
 * cross-site/same-site browser POST is refused, so no other page can inject into the bulb.
 */

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo
      srv.close(() => resolve(port))
    })
  })
}

let server: ServerInstance

beforeAll(async () => {
  server = await startServer({ getHtml: () => '<html></html>', basePath: '.', port: await freePort(), sendChannel: true })
  // Isolate the cross-project registry so runSend's target lookup can't see (or disturb) the
  // developer's real running servers.
  process.env.TYPEBULB_SERVERS_DIR = await mkdtemp(path.join(tmpdir(), 'tb-send-'))
})

afterAll(() => {
  server?.close()
  delete process.env.TYPEBULB_SERVERS_DIR
})

const url = (p: string) => `http://127.0.0.1:${server.port}${p}`

/** Spy both console streams: runSend prints the one reply via log, status/errors via error. */
const capture = () => {
  const out: string[] = []
  const errs: string[] = []
  const logSpy = vi.spyOn(console, 'log').mockImplementation((m?: unknown) => { out.push(String(m)) })
  const errSpy = vi.spyOn(console, 'error').mockImplementation((m?: unknown) => { errs.push(String(m)) })
  return { out, errs, restore: () => { logSpy.mockRestore(); errSpy.mockRestore() } }
}

/** Raw http so we can forge `Sec-Fetch-Site` (fetch() refuses to set it). */
function raw(p: string, headers: Record<string, string>, body = ''): Promise<number> {
  return new Promise((resolve, reject) => {
    const u = new URL(url(p))
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers },
      res => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)) },
    )
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

describe('typebulb send / __send', () => {
  it('delivers the posted body to every connected page and reports the count', async () => {
    await drained()
    const page = await pageClient()
    try {
      const resp = await fetch(url('/__send'), { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'hello' })
      expect(resp.ok).toBe(true)
      expect(await resp.json()).toEqual({ clients: 1 })
      expect(await page.settled(1)).toEqual([{ payload: 'hello' }])   // no ?reply ⇒ no id: fire-and-forget envelope
    } finally {
      page.close()
    }
  })

  it('delivers an empty body as a bare trigger', async () => {
    await drained()
    const page = await pageClient()
    try {
      await fetch(url('/__send'), { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '' })
      expect(await page.settled(1)).toEqual([{ payload: '' }])
    } finally {
      page.close()
    }
  })

  it('reports zero connected pages when nothing is listening', async () => {
    await drained()
    const resp = await fetch(url('/__send'), { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' })
    // `droppedMsAgo` rides along once any page has been here (an earlier case's), which is the
    // point of that field: which nothing this is.
    expect(await resp.json()).toMatchObject({ clients: 0 })
  })

  it('refuses a same-site (cross-port) browser POST — no foreign page can inject', async () => {
    expect(await raw('/__send', { 'Content-Type': 'text/plain', 'Sec-Fetch-Site': 'same-site' }, 'evil')).toBe(403)
  })

  it('allows the page\'s own same-origin POST', async () => {
    expect(await raw('/__send', { 'Content-Type': 'text/plain', 'Sec-Fetch-Site': 'same-origin' }, 'ok')).toBe(200)
  })

  // The wire's one non-obvious bit: a send is streamed as an SSE `message` event whose data is the
  // `{ id?, payload }` envelope JSON-*encoded*, so a multi-line value can't break SSE's newline
  // framing (the shim decodes it back). Open the events SSE, send a multi-line message, assert framing.
  it('streams a send as a line-safe SSE `message` event', async () => {
    const u = new URL(url('/__reload'))
    let req: http.ClientRequest
    const framed = await new Promise<string>((resolve, reject) => {
      let buf = ''
      req = http.get({ hostname: u.hostname, port: u.port, path: u.pathname }, res => {
        res.setEncoding('utf8')
        res.on('data', (d: string) => {
          buf += d
          if (buf.includes('event: message')) resolve(buf)
        })
        res.on('error', reject)
      })
      req.on('error', reject)
      // Send only once the SSE handler is attached (so the emit has a listener to reach).
      setTimeout(() => {
        fetch(url('/__send'), { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'multi\nline' }).catch(reject)
      }, 150)
    })
    req!.destroy()
    expect(framed).toContain('event: message')
    expect(framed).toContain('data: ' + JSON.stringify({ payload: 'multi\nline' }))   // envelope — one line
  })
})

describe('parseArgs: send --wait', () => {
  it('a bare --wait enables the default retry window, message still captured', () => {
    const a = parseArgs(['send', 'x.bulb.md', 'go', '--wait'])
    expect(a.subcommand).toBe('send')
    expect(a.sendMessage).toBe('go')
    expect(a.sendWaitMs).toBe(5000)
  })

  it('--wait=<ms> sets a custom window', () => {
    expect(parseArgs(['send', 'x.bulb.md', '--wait=1200']).sendWaitMs).toBe(1200)
  })

  it('absent --wait leaves sendWaitMs undefined (a single best-effort attempt)', () => {
    expect(parseArgs(['send', 'x.bulb.md', 'go']).sendWaitMs).toBeUndefined()
  })

  it('a bare - is the stdin message, not an unknown option', () => {
    const a = parseArgs(['send', 'x.bulb.md', '-', '--wait'])
    expect(a.sendMessage).toBe('-')
    expect(a.sendWaitMs).toBe(5000)
  })

  it('the bare - is scoped to send — call keeps its --args hint', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(process, 'exit').mockImplementation(((code: number) => { throw new Error(`exit ${code}`) }) as never)
    expect(() => parseArgs(['call', 'x.bulb.md', 'fn', '-'])).toThrow('exit 1')
    vi.restoreAllMocks()
  })
})

describe('runSend --wait — client-side retry across the reconnect window', () => {
  // Register under ppid, not pid: serversForBulb excludes process.pid (the runner never targets
  // itself), and ppid is alive (isAlive treats EPERM as alive) and distinct. The URL points at our
  // in-test server, so the pid is just the registry key.
  const file = path.resolve('send-wait.bulb.md')

  it('delivers once a page attaches mid-wait (no server-side buffering)', async () => {
    await registerServer({ pid: process.ppid, port: server.port, url: `http://127.0.0.1:${server.port}`, file, startedAt: Date.now() })
    await drained()
    // No page at first (the reload gap); one attaches ~400ms in and acks like the shim's page side
    // (no handler returned a value), so the reply hold resolves promptly.
    let page: Awaited<ReturnType<typeof pageClient>> | undefined
    const attach = setTimeout(() => { void pageClient(() => ({})).then(p => { page = p }) }, 400)
    const { errs, restore } = capture()
    try {
      await runSend(file, 'go', 2000)
    } finally {
      restore(); clearTimeout(attach); page?.close(); await unregisterServer(process.ppid)
    }
    expect(page?.received.map(e => e.payload)).toEqual(['go'])   // delivered exactly once
    expect(errs.join('\n')).toContain('Sent to 1 page')
  })

  it('reports no page when the window elapses with nothing attached, and exits 1', async () => {
    await registerServer({ pid: process.ppid, port: server.port, url: `http://127.0.0.1:${server.port}`, file, startedAt: Date.now() })
    const { errs, restore } = capture()
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`) }) as never)
    try {
      // A send that reached no page is a failed send, whatever its message was: the caller chains
      // `send … && wait …`, so exit 0 here is what lets a doomed wait run (TB-Page-Lifecycle.md,
      // invariant 8; incident 4).
      await expect(runSend(file, 'go', 300)).rejects.toThrow('exit 1')
    } finally {
      exit.mockRestore(); restore(); await unregisterServer(process.ppid)
    }
    // The elapsed figure, not the asked window: a page that dropped moments ago (an earlier case's
    // stream) may be reattaching, so the server's ask waits out its settle window first.
    expect(errs.join('\n')).toMatch(/No page connected after \d+\.\ds/)
  })

  it('a PLAIN send asks for a page too, and fails when it reached none', async () => {
    // The incident-4 shape: the user closed the tab, the agent sent without `--wait`, and the send
    // neither asked for a page nor said it had failed. `open=1` now rides every send (the ask lands
    // on `requestPage`, which finds nothing to relay through here and answers `none`), and the
    // verdict is exit 1 — read after the arrival window, never before it.
    await registerServer({ pid: process.ppid, port: server.port, url: `http://127.0.0.1:${server.port}`, file, startedAt: Date.now() })
    const { errs, restore } = capture()
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`) }) as never)
    try {
      await expect(runSend(file, 'go')).rejects.toThrow('exit 1')
    } finally {
      exit.mockRestore(); restore(); await unregisterServer(process.ppid)
    }
    expect(errs.join('\n')).toContain('nothing was delivered')
  })

  it('a plain send delivers to a page that is already attached, unchanged', async () => {
    await registerServer({ pid: process.ppid, port: server.port, url: `http://127.0.0.1:${server.port}`, file, startedAt: Date.now() })
    await drained()
    const p = await pageClient()
    const { errs, restore } = capture()
    try {
      await runSend(file, 'go')
      await p.settled(1)
    } finally { restore(); p.close(); await unregisterServer(process.ppid) }
    expect(p.received.map(e => e.payload)).toEqual(['go'])
    expect(errs.join('\n')).toContain('Sent to 1 page')
  })
})

describe('send <file> - — the message from stdin (TB-Get-Put.md Normalization)', () => {
  const file = path.resolve('send-stdin.bulb.md')
  const BOM = String.fromCharCode(0xfeff)

  it("reads stdin and normalizes it like put's sources", async () => {
    await registerServer({ pid: process.ppid, port: server.port, url: `http://127.0.0.1:${server.port}`, file, startedAt: Date.now() })
    await drained()
    const page = await pageClient()
    const stdin = vi.spyOn(process, 'stdin', 'get')
      .mockReturnValue(Readable.from([Buffer.from(BOM + 'hello there\r\n', 'utf-8')]) as unknown as NodeJS.ReadStream & { fd: 0 })
    const { restore } = capture()
    try {
      await runSend(file, '-')
      await page.settled(1)
    } finally {
      restore(); stdin.mockRestore(); page.close(); await unregisterServer(process.ppid)
    }
    // BOM stripped, CRLF folded, trailing newline trimmed: identical to `send <file> 'hello there'`.
    expect(page.received.map(e => e.payload)).toEqual(['hello there'])
  })
})

describe('the reply leg — a handler return prints on stdout (TB-Interrogation.md)', () => {
  const file = path.resolve('send-reply.bulb.md')
  /** The shim's page side, on a real stream: receive the envelope, POST the reply (null: stay silent). */
  const page = async (reply: (env: Envelope) => { results?: string[]; errors?: string[] } | null) => {
    await drained()
    const p = await pageClient(reply)
    return () => p.close()
  }

  it('prints a structured return as JSON on stdout; the delivery line moves to stderr', async () => {
    await registerServer({ pid: process.ppid, port: server.port, url: `http://127.0.0.1:${server.port}`, file, startedAt: Date.now() })
    const off = await page(() => ({ results: [JSON.stringify({ count: 7, verdict: 'prime' })] }))
    const { out, errs, restore } = capture()
    try {
      await runSend(file, 'selftest', 2000)
    } finally { restore(); off(); await unregisterServer(process.ppid) }
    expect(out).toEqual(['{"count":7,"verdict":"prime"}'])
    expect(errs.join('\n')).toContain('Sent to 1 page')
  })

  it('prints a bare-string reply raw — a snapshot outline stays readable', async () => {
    await registerServer({ pid: process.ppid, port: server.port, url: `http://127.0.0.1:${server.port}`, file, startedAt: Date.now() })
    const off = await page(() => ({ results: [JSON.stringify('- heading "7" [level=1]')] }))
    const { out, restore } = capture()
    try {
      await runSend(file, 'tb:snapshot')   // tb:* implies --wait
    } finally { restore(); off(); await unregisterServer(process.ppid) }
    expect(out).toEqual(['- heading "7" [level=1]'])
  })

  it('rejects two replies — one reply owns stdout', async () => {
    await registerServer({ pid: process.ppid, port: server.port, url: `http://127.0.0.1:${server.port}`, file, startedAt: Date.now() })
    const off = await page(() => ({ results: [JSON.stringify(1), JSON.stringify(2)] }))
    const { out, errs, restore } = capture()
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`) }) as never)
    try {
      await expect(runSend(file, 'selftest', 2000)).rejects.toThrow('exit 1')
    } finally { exit.mockRestore(); restore(); off(); await unregisterServer(process.ppid) }
    expect(out).toEqual([])
    expect(errs.join('\n')).toContain('one reply owns stdout')
  })

  it('a silent page keeps fire-and-forget behavior, with a timeout note on stderr', async () => {
    await registerServer({ pid: process.ppid, port: server.port, url: `http://127.0.0.1:${server.port}`, file, startedAt: Date.now() })
    const off = await page(() => null)
    const { out, errs, restore } = capture()
    try {
      await runSend(file, 'go', 1200)
    } finally { restore(); off(); await unregisterServer(process.ppid) }
    expect(out).toEqual([])
    expect(errs.join('\n')).toContain('no reply within')
  })

  // tb:png's bytes ride the envelope; the CLI owns the file (TB-Interrogation-Pixels.md): decoded
  // to the bulb's ONE stable path under the typebulb home, the path — never base64 — on stdout.
  it('tb:png decodes the reply to the bulb\'s stable path and prints that path', async () => {
    await registerServer({ pid: process.ppid, port: server.port, url: `http://127.0.0.1:${server.port}`, file, startedAt: Date.now() })
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
    const off = await page(() => ({ results: [JSON.stringify({ png: bytes.toString('base64'), width: 2, height: 1 })] }))
    const { out, errs, restore } = capture()
    try {
      await runSend(file, 'tb:png')   // tb:* implies --wait
    } finally { restore(); off(); await unregisterServer(process.ppid) }
    const expected = canvasPngPath(file)
    expect(out).toEqual([expected])
    expect(Buffer.from(await readFile(expected))).toEqual(bytes)
    expect(errs.join('\n')).toContain('canvas 2×1')
  })

  // The frame can't show what the read assumed (TB-Interrogation-Pixels.md): the composited
  // backdrop and a container descent are stated on the delivery line, and only when they happened.
  it('states the backdrop it composited and the container it resolved through', async () => {
    await registerServer({ pid: process.ppid, port: server.port, url: `http://127.0.0.1:${server.port}`, file, startedAt: Date.now() })
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')
    const off = await page(() => ({ results: [JSON.stringify({ png, width: 2, height: 1, backdrop: 'rgb(20, 20, 20)', via: 'chart' })] }))
    const { errs, restore } = capture()
    try {
      await runSend(file, 'tb:png "chart"')
    } finally { restore(); off(); await unregisterServer(process.ppid) }
    expect(errs.join('\n')).toContain('canvas 2×1 → PNG (inside "chart"; backdrop rgb(20, 20, 20))')
  })

  it('a tb:png reply without bytes is an error naming version skew, never a fallback print', async () => {
    await registerServer({ pid: process.ppid, port: server.port, url: `http://127.0.0.1:${server.port}`, file, startedAt: Date.now() })
    const off = await page(() => ({ results: [JSON.stringify('oops')] }))
    const { out, errs, restore } = capture()
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`) }) as never)
    try {
      await expect(runSend(file, 'tb:png')).rejects.toThrow('exit 1')
    } finally { exit.mockRestore(); restore(); off(); await unregisterServer(process.ppid) }
    expect(out).toEqual([])
    expect(errs.join('\n')).toContain('unexpected shape')
  })
})

describe('actuation solo guard — /__send?solo=1 (TB-Interrogation-Actuation.md)', () => {
  const file = path.resolve('send-solo.bulb.md')

  it('refuses BEFORE the emit when two pages are connected — the gesture never fires', async () => {
    await drained()
    const [p1, p2] = [await pageClient(), await pageClient()]
    try {
      const resp = await fetch(url('/__send?reply=1000&solo=1'), { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'tb:click button "x"' })
      expect(await resp.json()).toEqual({ clients: 2, refused: true })
      expect([...p1.received, ...p2.received]).toEqual([])
    } finally {
      p1.close(); p2.close()
    }
  })

  it('dispatches normally to exactly one page', async () => {
    await drained()
    const page = await pageClient(() => ({}))
    try {
      const resp = await fetch(url('/__send?reply=1500&solo=1'), { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'tb:click button "x"' })
      expect(((await resp.json()) as { clients: number }).clients).toBe(1)
      expect(page.received.map(e => e.payload)).toEqual(['tb:click button "x"'])
    } finally {
      page.close()
    }
  })

  it('runSend reports the exactly-one error and exits 1 at two pages', async () => {
    await registerServer({ pid: process.ppid, port: server.port, url: `http://127.0.0.1:${server.port}`, file, startedAt: Date.now() })
    await drained()
    const [p1, p2] = [await pageClient(), await pageClient()]
    const { out, errs, restore } = capture()
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`) }) as never)
    try {
      await expect(runSend(file, 'tb:click button "x"', 2000)).rejects.toThrow('exit 1')
    } finally {
      exit.mockRestore(); restore()
      p1.close(); p2.close()
      await unregisterServer(process.ppid)
    }
    expect(out).toEqual([])
    expect(errs.join('\n')).toContain('exactly one connected page')
  })
})

describe("the page-connect wake line — '[page] connected' (TB-Wait.md)", () => {
  /** Open the events SSE like a page's shim would, resolving once the hello frame arrives. */
  const openSse = () => new Promise<http.ClientRequest>((resolve, reject) => {
    const u = new URL(url('/__reload'))
    const req = http.get({ hostname: u.hostname, port: u.port, path: u.pathname }, res => {
      res.setEncoding('utf8')
      res.on('data', (d: string) => { if (d.includes('event: hello')) resolve(req) })
    })
    req.on('error', reject)
  })

  it('logs once when a page attaches where none was; a second page does not re-fire', async () => {
    // Let earlier tests' aborted streams drain, so the 0→1 edge is real.
    await drained()
    const { out, restore } = capture()
    let a: http.ClientRequest | undefined
    let b: http.ClientRequest | undefined
    try {
      a = await openSse()
      b = await openSse()
    } finally {
      restore(); a?.destroy(); b?.destroy()
    }
    expect(out.filter(l => l.includes('[page] connected'))).toHaveLength(1)
  })

  it("logs '[page] disconnected' once the last page has been gone for the settle window; a reattach in time stays silent", async () => {
    await drained()
    const { out, restore } = capture()
    try {
      // A hot reload's shape: a drop, then back inside the window — no line.
      ;(await openSse()).destroy()
      await new Promise(r => setTimeout(r, 300))
      const b = await openSse()
      await new Promise(r => setTimeout(r, RELOAD_SETTLE_MS + 300))
      expect(out.filter(l => l.includes('[page] disconnected'))).toHaveLength(0)
      // The real departure: the last page gone, nothing back.
      b.destroy()
      await new Promise(r => setTimeout(r, RELOAD_SETTLE_MS + 300))
    } finally { restore() }
    expect(out.filter(l => l.includes('[page] disconnected'))).toHaveLength(1)
  }, 15000)
})

/** Attach a page to a server's events SSE under a given User-Agent (and stream query — the shim's
 *  `?relay=<doc>` for a CLI-opened page); resolves once its `hello` frame lands. */
type Envelope = { id?: number; payload: string }

/**
 * A page as the server sees one: a real `/__reload` stream. The page set is the delivery list AND
 * the count (TB-Page-Lifecycle.md, invariant 6), so an in-process listener would be a page the
 * server never had. `reply` answers a held `--wait` send the way the shim's page side does; `null`
 * stays silent.
 */
function pageClient(
  reply?: (env: Envelope) => { results?: string[]; errors?: string[] } | null,
  opts: { ua?: string; query?: string; base?: string } = {},
): Promise<{ received: Envelope[]; frames: () => string; settled: (n: number) => Promise<Envelope[]>; close: () => void }> {
  return new Promise((resolve, reject) => {
    const u = new URL((opts.base ?? url('')) + '/__reload' + (opts.query ?? ''))
    const received: Envelope[] = []
    let buf = ''
    let cut = 0
    const api = {
      received,
      frames: () => buf,
      settled: async (n: number) => {
        for (let i = 0; i < 80 && received.length < n; i++) await new Promise(r => setTimeout(r, 25))
        return received
      },
      close: () => req.destroy(),
    }
    const req = http.get({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers: { 'User-Agent': opts.ua ?? CHROME_UA } }, res => {
      res.setEncoding('utf8')
      res.on('data', (d: string) => {
        buf += d
        // Whole frames only — an envelope can arrive split across chunks.
        for (let at = buf.indexOf('\n\n', cut); at !== -1; at = buf.indexOf('\n\n', cut)) {
          const frame = buf.slice(cut, at)
          cut = at + 2
          if (!frame.startsWith('event: message')) continue
          const line = frame.split('\n').find(l => l.startsWith('data: '))
          if (!line) continue
          const env = JSON.parse(line.slice(6)) as Envelope
          received.push(env)
          const body = reply?.(env)
          if (body && env.id !== undefined) {
            void fetch((opts.base ?? url('')) + '/__send-reply', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: env.id, results: [], errors: [], ...body }),
            })
          }
        }
        if (buf.includes('event: hello')) resolve(api)
      })
      res.on('error', reject)
    })
    // A declined stream (`close: foreign`) never says hello and ends at once — it must still
    // resolve, or the test that asserts the refusal would hang on it.
    req.on('response', res => res.on('end', () => resolve(api)))
    req.on('error', reject)
  })
}

/** The relay tests' spelling of the same thing: a page with a chosen User-Agent (and, for the
 *  mirror-open cases, on another of our servers), no reply side. */
const attachPage = (userAgent: string, base = url(''), query = '') => pageClient(undefined, { ua: userAgent, base, query })

/** The server's own count, which is what "a page" now means (`/__pages`). */
const pagesAt = async (base: string) => ((await (await fetch(base + '/__pages')).json()) as { pages: number }).pages
const pagesNow = () => pagesAt(url(''))

/** Let earlier tests' aborted streams drain, so the server's page set holds only this test's. */
const drained = async () => { for (let i = 0; i < 40 && (await pagesNow()) > 0; i++) await new Promise(r => setTimeout(r, 50)) }

const VSCODE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Code/1.134.0 Chrome/148.0.7778.280 Electron/42.8.1 Safari/537.36'
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36'
const openVia = (target: string) => fetch(url('/__open'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: target }) })

// One CLI-opened page (TB-VSCode-Browser.md): a page the relay opened announces itself on its stream
// (`?relay=<doc>`), is provisional for RELAY_PROVISIONAL_MS, and is told to go the moment another
// page is attached — whichever page the CLI did NOT open wins; between two of its own, the earlier.
// One departure event carries every reason (TB-Page-Lifecycle.md, invariant 6), so this is the
// `close` event with `yielded`.
describe('one CLI-opened page — a provisional relay page yields (TB-VSCode-Browser.md)', () => {
  const YIELDED = 'event: close\ndata: yielded'
  /** The stream's frames once the server has had a beat to write the verdict. */
  const frames = async (p: { frames: () => string }) => { await new Promise(r => setTimeout(r, 150)); return p.frames() }

  it('stays when it is the only page', async () => {
    await drained()
    const relayed = await attachPage(CHROME_UA, url(''), '?relay=solo')
    try { expect(await frames(relayed)).not.toContain(YIELDED) } finally { relayed.close() }
  })

  it('yields to a page that was already here', async () => {
    await drained()
    const user = await attachPage(CHROME_UA)
    const late = await attachPage(CHROME_UA, url(''), '?relay=late')
    try {
      expect(await frames(late)).toContain(YIELDED)
      expect(user.frames()).not.toContain(YIELDED)
    } finally { late.close(); user.close() }
  })

  // Only the newcomer yields. A page already here is the user's, whatever opened it — a second view
  // arriving beside it must not take it away, which is the 10% case (a hand-made tab with the URL
  // pasted in) and what makes the launcher's own tab durable.
  it('does not yield to a page that arrives after it, and never evicts an unmarked one', async () => {
    await drained()
    // The relaunch shape: the relayed tab lands first, the user's returning tab a beat later.
    const early = await attachPage(CHROME_UA, url(''), '?relay=early')
    const returning = await attachPage(CHROME_UA)
    try {
      expect(await frames(early)).not.toContain(YIELDED)
      expect(returning.frames()).not.toContain(YIELDED)
      expect(await pagesNow()).toBe(2)
    } finally { early.close(); returning.close() }
  })

  // A reconnect is not an arrival: a hot reload's drop-and-reattach would otherwise read as a
  // newcomer and yield the page to whatever else is attached.
  it('exempts a reconnect of a document already seen', async () => {
    await drained()
    const user = await attachPage(CHROME_UA)
    const relayed = await attachPage(CHROME_UA, url(''), '?relay=rejoin')
    await frames(relayed)                      // it yields, as the newcomer
    relayed.close()
    const back = await attachPage(CHROME_UA, url(''), '?relay=rejoin')
    try {
      expect(await frames(back)).not.toContain(YIELDED)
    } finally { back.close(); user.close() }
  })

  it('between two relay pages the earlier stays and the later yields', async () => {
    await drained()
    const first = await attachPage(CHROME_UA, url(''), '?relay=first')
    const second = await attachPage(CHROME_UA, url(''), '?relay=second')
    try {
      expect(await frames(second)).toContain(YIELDED)
      expect(first.frames()).not.toContain(YIELDED)
    } finally { first.close(); second.close() }
  })

  // The note a page lands on when the browser refuses a script the close is the page's own blob
  // document now, built from the `close` event's reason: a served note cannot cover the case where
  // the server is leaving (TB-Page-Lifecycle.md, One departure event), so `/__parked` is gone.
  it('serves no parked route — the note travels with the reason, not from the server', async () => {
    expect((await fetch(url('/__parked'))).status).toBe(404)
  })
})

// The relay (TB-VSCode-Browser.md): `/__open` streams an `open-url` event to exactly one page that
// VS Code's integrated browser renders (told by its User-Agent), so the CLI can land a bulb in-editor;
// its `pages` count is how relayOpen tells a mirror open only externally from no mirror page at all.
// Last in the file: its attach/drop churn would otherwise leave `droppedMsAgo` on the earlier cases.
describe('relay open / __open', () => {
  it('reports no foothold when no attached page is inside VS Code', async () => {
    await drained()
    const page = await attachPage(CHROME_UA)
    try {
      expect(await (await openVia('http://localhost:3398/')).json()).toEqual({ opened: false, pages: 1 })
      expect(page.frames()).not.toContain('event: open-url')
    } finally { page.close() }
  })

  it('streams `open-url` to exactly one in-editor page', async () => {
    await drained()
    const a = await attachPage(VSCODE_UA)
    const b = await attachPage(VSCODE_UA)
    try {
      expect(await (await openVia('http://localhost:3398/')).json()).toEqual({ opened: true, pages: 2 })
      await new Promise(r => setTimeout(r, 100))
      expect([a, b].filter(p => p.frames().includes('event: open-url\ndata: http://localhost:3398/'))).toHaveLength(1)
    } finally { a.close(); b.close() }
  })

  it('refuses a non-local URL', async () => {
    expect((await openVia('https://example.com/')).status).toBe(400)
  })

  const mirrorEntry = () => registerServer({ pid: process.pid, port: server.port, url: url(''), file: 'agent:claude', cwd: process.cwd(), startedAt: Date.now(), agent: 'claude' })

  it('relayOpen asks the project mirror and names it', async () => {
    await drained()
    const page = await attachPage(VSCODE_UA)
    await mirrorEntry()
    try {
      expect(await relayOpen('http://localhost:3398/', process.cwd())).toEqual({ where: 'editor', via: 'the agent mirror' })
      await new Promise(r => setTimeout(r, 100))
      expect(page.frames()).toContain('data: http://localhost:3398/')
    } finally { page.close(); await unregisterServer(process.pid) }
  })

  it('relayOpen follows a mirror open only outside VS Code, and nothing when no mirror page is open', async () => {
    await drained()
    await mirrorEntry()
    try {
      expect(await relayOpen('http://localhost:3398/', process.cwd())).toBeUndefined()
      const page = await attachPage(CHROME_UA)
      try {
        expect(await relayOpen('http://localhost:3398/', process.cwd())).toEqual({ where: 'external' })
        expect(page.frames()).not.toContain('event: open-url')
      } finally { page.close() }
    } finally { await unregisterServer(process.pid) }
  })
})

// Every `send` → `/__send?open=1`: with nobody listening the server asks the project's mirror to open
// the page (requestPage) and then HOLDS for it, so the answer is terminal — a page is attached, or
// there is none — and the sender has no window of its own to get wrong. Each case gets its own bulb
// server, given its first RELOAD_SETTLE_MS to pass (a predecessor's tab may be reattaching).
describe('a send opens the page where the mirror is, and holds for it', () => {
  let mirror: ServerInstance
  const file = path.resolve('send-open.bulb.md')
  const mirrorUrl = () => `http://127.0.0.1:${mirror.port}`
  beforeAll(async () => {
    mirror = await startServer({ getHtml: () => '<html></html>', basePath: '.', port: await freePort(), reloadEmitter: new EventEmitter() })
    await registerServer({ pid: process.pid, port: mirror.port, url: mirrorUrl(), file: 'agent:claude', cwd: process.cwd(), startedAt: Date.now(), agent: 'claude' })
  })
  afterAll(async () => { mirror?.close(); await unregisterServer(process.pid) })

  const freshBulb = async () => {
    const bulb = await startServer({ getHtml: () => '<html></html>', basePath: '.', port: await freePort(), sendChannel: true })
    await new Promise(r => setTimeout(r, RELOAD_SETTLE_MS + 100))
    const send = async () => (await fetch(`http://127.0.0.1:${bulb.port}/__send?reply=1000&open=1`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' })).json()
    return { bulb, send }
  }

  /** The tab the relay's open would have produced, attaching `ms` in — what the hold is holding for. */
  const arrivesIn = (bulb: ServerInstance, ms: number) => {
    const box: { page?: Awaited<ReturnType<typeof pageClient>> } = {}
    const timer = setTimeout(() => {
      void pageClient(() => ({}), { base: `http://127.0.0.1:${bulb.port}` }).then(p => { box.page = p })
    }, ms)
    return { box, stop: () => { clearTimeout(timer); box.page?.close() } }
  }

  it('asks the mirror to open the page once, and holds until it arrives', async () => {
    const { bulb, send } = await freshBulb()
    const mirrorPage = await attachPage(VSCODE_UA, mirrorUrl())
    const arriving = arrivesIn(bulb, 400)
    try {
      // The answer is terminal: the page it opened is here, delivered to, and counted.
      expect(await send()).toMatchObject({ clients: 1, opening: 'editor', via: 'the agent mirror' })
      expect(mirrorPage.frames()).toContain(`data: http://localhost:${bulb.port}`)
      expect(arriving.box.page?.received.map(e => e.payload)).toEqual(['x'])
    } finally { arriving.stop(); mirrorPage.close(); bulb.close() }
  }, 15000)

  it('answers none when no mirror page is open, and never opens an external window for a send', async () => {
    const { bulb, send } = await freshBulb()
    try {
      expect(await send()).toEqual({ clients: 0, opening: 'none' })
    } finally { bulb.close() }
  }, 15000)

  it('two concurrent askers get one open, and both resolve on the same arrival', async () => {
    const { bulb, send } = await freshBulb()
    const mirrorPage = await attachPage(VSCODE_UA, mirrorUrl())
    const arriving = arrivesIn(bulb, 500)
    try {
      // Neither is sent away to ask again: they await the one arrival, and each delivers its own
      // message to it. One `open-url` frame is the invariant — never a second window.
      const outcomes = await Promise.all([send(), send()])
      expect(outcomes.map((o: { clients: number }) => o.clients)).toEqual([1, 1])
      expect(arriving.box.page?.received.map(e => e.payload)).toEqual(['x', 'x'])
      expect(mirrorPage.frames().split('event: open-url').length - 1).toBe(1)
    } finally { arriving.stop(); mirrorPage.close(); bulb.close() }
  }, 15000)

  // Trap 2 (TB-Page-Set.md): the server holds and the sender does NOT retry behind it, so the page
  // that attaches during the hold runs the payload exactly once. The old ordering — count read
  // before the ask, sender polling behind it — is what made a `tb:click` fire in two frames.
  it('a send that opened the page delivers to it exactly once, and says where it opened', async () => {
    const { bulb } = await freshBulb()
    await registerServer({ pid: process.ppid, port: bulb.port, url: `http://127.0.0.1:${bulb.port}`, file, startedAt: Date.now() })
    const mirrorPage = await attachPage(VSCODE_UA, mirrorUrl())
    const arriving = arrivesIn(bulb, 400)
    const { errs, restore } = capture()
    try {
      await runSend(file, 'go', 2000)
    } finally {
      restore(); arriving.stop(); mirrorPage.close(); bulb.close(); await unregisterServer(process.ppid)
    }
    expect(arriving.box.page?.received.map(e => e.payload)).toEqual(['go'])
    expect(errs.join('\n')).toContain('Opened in VS Code via the agent mirror.')
    expect(errs.join('\n')).toContain('Sent to 1 page')
  }, 15000)

  // Trap 3: with a server-side hold, the solo test applies to the count the hold settled on — a
  // zero it was about to leave behind is not a refusal, and it must never dispatch to two.
  it('a solo send holds at zero pages, then dispatches to the one that arrives', async () => {
    const { bulb } = await freshBulb()
    const mirrorPage = await attachPage(VSCODE_UA, mirrorUrl())
    const arriving = arrivesIn(bulb, 400)
    try {
      const resp = await fetch(`http://127.0.0.1:${bulb.port}/__send?reply=1000&solo=1&open=1`, {
        method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'tb:click button "x"',
      })
      expect(await resp.json()).toMatchObject({ clients: 1 })
      expect(arriving.box.page?.received.map(e => e.payload)).toEqual(['tb:click button "x"'])
    } finally { arriving.stop(); mirrorPage.close(); bulb.close() }
  }, 15000)

  it('never fires an actuation into two pages, however they arrive during the hold', async () => {
    const { bulb } = await freshBulb()
    const base = `http://127.0.0.1:${bulb.port}`
    const mirrorPage = await attachPage(VSCODE_UA, mirrorUrl())
    const both: Array<Awaited<ReturnType<typeof pageClient>>> = []
    const timer = setTimeout(() => {
      void Promise.all([pageClient(() => ({}), { base }), pageClient(() => ({}), { base })]).then(ps => both.push(...ps))
    }, 400)
    try {
      await fetch(`${base}/__send?reply=1000&solo=1&open=1`, {
        method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'tb:click button "x"',
      })
      // One page or none — the gesture fired in two frames is the failure this refuses.
      expect(both.flatMap(p => p.received).length).toBeLessThanOrEqual(1)
    } finally { clearTimeout(timer); for (const p of both) p.close(); mirrorPage.close(); bulb.close() }
  }, 15000)
})

// The close half (TB-Page-Lifecycle.md): `/__stop` disposes of the pages, answers with what it
// OBSERVED, and only then hands the process to its owner's cleanup. Its evidence is the stream
// dropping — a page that merely acknowledges is a page that did not go.
describe('the stop verb — /__stop', () => {
  const owner = async (opts: { bulbKey?: string } = {}) => {
    const stops: Array<{ pages: string }> = []
    const srv = await startServer({
      getHtml: () => '<html></html>', basePath: '.', port: await freePort(), sendChannel: true,
      onStop: (o) => { stops.push(o) }, ...opts,
    })
    return { srv, stops, base: `http://127.0.0.1:${srv.port}` }
  }
  const postStop = (base: string, body: unknown = {}) => fetch(base + '/__stop', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  /** A tab that actually goes when told: the close event lands, the tab closes, the stream drops. */
  const goesWhenTold = (page: { frames: () => string; close: () => void }) => (async () => {
    for (let i = 0; i < 200; i++) {
      if (page.frames().includes('event: close')) return page.close()
      await new Promise(r => setTimeout(r, 20))
    }
  })()

  it('tells the pages to go, counts the ones it saw go, and hands over to cleanup', async () => {
    const { srv, stops, base } = await owner()
    const page = await pageClient(undefined, { base })
    const going = goesWhenTold(page)
    try {
      expect(await (await postStop(base)).json()).toEqual({ closed: 1, stuck: 0, exiting: true })
      await going
      expect(page.frames()).toContain('event: close\ndata: stopped')
      await new Promise(r => setTimeout(r, 120))
      expect(stops).toEqual([{ pages: 'close' }])           // the exit runs after the answer
    } finally { page.close(); srv.close() }
  })

  // The trap this drain exists to refuse: a page that acknowledged is not a page that went, so a
  // stream still attached when the wait elapses is reported as one that did not close.
  it('counts a page that stays attached as one that did not close', async () => {
    const { srv, base } = await owner()
    const page = await pageClient(undefined, { base })   // receives the event, never drops its stream
    try {
      expect(await (await postStop(base)).json()).toMatchObject({ closed: 0, stuck: 1 })
    } finally { page.close(); srv.close() }
  }, 10000)

  it('keeps the pages when the caller says so — a replace hands them to its successor', async () => {
    const { srv, stops, base } = await owner()
    const page = await pageClient(undefined, { base })
    try {
      expect(await (await postStop(base, { pages: 'keep' })).json()).toEqual({ closed: 0, stuck: 0, exiting: true })
      await new Promise(r => setTimeout(r, 120))
      expect(page.frames()).not.toContain('event: close')
      expect(stops).toEqual([{ pages: 'keep' }])
    } finally { page.close(); srv.close() }
  })

  // The CSRF guard admits the page's own origin, which is right for a data channel and wrong for a
  // route whose blast radius is the whole server.
  it('refuses a browser caller outright, same-origin included', async () => {
    expect(await raw('/__stop', { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' }, '{}')).toBe(403)
    expect(await raw('/__stop', { 'Content-Type': 'application/json', 'Origin': url('') }, '{}')).toBe(403)
  })
})

// A port is a bulb's long-lived identity but cannot prove itself across a gap (TB-Page-Lifecycle.md,
// invariant 1): the allocator spills a busy slot and recycles a full block's oldest one, so a page
// that has been reaching for this address a long while may find a different bulb here.
describe('bulb identity on the stream', () => {
  it('declines a page announcing another bulb, and never counts it', async () => {
    const srv = await startServer({ getHtml: () => '<html></html>', basePath: '.', port: await freePort(), sendChannel: true, bulbKey: 'aaaa1111' })
    const base = `http://127.0.0.1:${srv.port}`
    const { out, restore } = capture()
    const mine = await pageClient(undefined, { base, query: '?bulb=aaaa1111' })
    const stranger = await pageClient(undefined, { base, query: '?bulb=bbbb2222' })
    // The stranger reaches forever now, so the line must be said once per stranger, not per attempt.
    const retry = await pageClient(undefined, { base, query: '?bulb=bbbb2222' })
    try {
      expect(stranger.frames()).toContain('event: close\ndata: foreign')
      expect(stranger.frames()).not.toContain('event: hello')
      expect(await pagesAt(base)).toBe(1)                  // only the page that belongs here
      expect(out.filter(l => l.includes('[page] closed: foreign'))).toHaveLength(1)
    } finally { restore(); mine.close(); stranger.close(); retry.close(); srv.close() }
  })

  it('accepts a page that announces nothing — an older page, or one served without a key', async () => {
    const srv = await startServer({ getHtml: () => '<html></html>', basePath: '.', port: await freePort(), sendChannel: true, bulbKey: 'aaaa1111' })
    const base = `http://127.0.0.1:${srv.port}`
    const page = await pageClient(undefined, { base })
    try {
      expect(page.frames()).toContain('event: hello')
      expect(await pagesAt(base)).toBe(1)
    } finally { page.close(); srv.close() }
  })
})
