import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { EventEmitter } from 'events'
import * as net from 'net'
import * as http from 'http'
import * as path from 'path'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { startServer, type ServerInstance } from '../src/serve/server.js'
import { parseArgs } from '../src/args.js'
import { runSend } from '../src/commands/send.js'
import { registerServer, unregisterServer } from '../src/serve/serverRegistry.js'

/**
 * `typebulb send` → `/__send` (TB-CLI.md). The endpoint re-emits the posted body on the
 * `messageEmitter` (the SSE fan-out the shim's `tb.onMessage` reads) and returns the connected-page
 * count. It's data-in/trust-free but CSRF-guarded like `/__log`: the CLI (no Origin) passes; a
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
let emitter: EventEmitter

beforeAll(async () => {
  emitter = new EventEmitter()
  emitter.setMaxListeners(0)
  server = await startServer({ getHtml: () => '<html></html>', basePath: '.', port: await freePort(), messageEmitter: emitter })
  // Isolate the cross-project registry so runSend's target lookup can't see (or disturb) the
  // developer's real running servers.
  process.env.TYPEBULB_SERVERS_DIR = await mkdtemp(path.join(tmpdir(), 'tb-send-'))
})

afterAll(() => {
  server?.close()
  delete process.env.TYPEBULB_SERVERS_DIR
})

const url = (p: string) => `http://127.0.0.1:${server.port}${p}`

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
  it('re-emits the posted body to message listeners and reports the count', async () => {
    const received: string[] = []
    const listener = (payload: string) => received.push(payload)
    emitter.on('message', listener)
    try {
      const resp = await fetch(url('/__send'), { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'hello' })
      expect(resp.ok).toBe(true)
      expect(await resp.json()).toEqual({ clients: 1 })
      expect(received).toEqual(['hello'])
    } finally {
      emitter.removeListener('message', listener)
    }
  })

  it('delivers an empty body as a bare trigger', async () => {
    let got: string | undefined
    const listener = (payload: string) => { got = payload }
    emitter.on('message', listener)
    try {
      await fetch(url('/__send'), { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '' })
      expect(got).toBe('')
    } finally {
      emitter.removeListener('message', listener)
    }
  })

  it('reports zero connected pages when nothing is listening', async () => {
    const resp = await fetch(url('/__send'), { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' })
    expect(await resp.json()).toEqual({ clients: 0 })
  })

  it('refuses a same-site (cross-port) browser POST — no foreign page can inject', async () => {
    expect(await raw('/__send', { 'Content-Type': 'text/plain', 'Sec-Fetch-Site': 'same-site' }, 'evil')).toBe(403)
  })

  it('allows the page\'s own same-origin POST', async () => {
    expect(await raw('/__send', { 'Content-Type': 'text/plain', 'Sec-Fetch-Site': 'same-origin' }, 'ok')).toBe(200)
  })

  // The wire's one non-obvious bit: a send is streamed as an SSE `message` event whose data is the
  // payload JSON-*encoded*, so a multi-line value can't break SSE's newline framing (the shim
  // JSON-decodes it back). Open the events SSE, send a multi-line message, assert the framed event.
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
    expect(framed).toContain('data: ' + JSON.stringify('multi\nline'))   // "multi\nline" — one line
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
})

describe('runSend --wait — client-side retry across the reconnect window', () => {
  // Register under ppid, not pid: serversForBulb excludes process.pid (the runner never targets
  // itself), and ppid is alive (isAlive treats EPERM as alive) and distinct. The URL points at our
  // in-test server, so the pid is just the registry key.
  const file = path.resolve('send-wait.bulb.md')
  const captureLog = () => {
    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((m?: unknown) => { lines.push(String(m)) })
    return { lines, restore: () => spy.mockRestore() }
  }

  it('delivers once a page attaches mid-wait (no server-side buffering)', async () => {
    await registerServer({ pid: process.ppid, port: server.port, url: `http://127.0.0.1:${server.port}`, file, startedAt: Date.now() })
    const received: string[] = []
    const listener = (p: string) => received.push(p)
    // No listener at first (the reload gap); the page "re-attaches" ~400ms in.
    const attach = setTimeout(() => emitter.on('message', listener), 400)
    const { lines, restore } = captureLog()
    try {
      await runSend(file, 'go', 2000)
    } finally {
      restore(); clearTimeout(attach); emitter.removeListener('message', listener); await unregisterServer(process.ppid)
    }
    expect(received).toEqual(['go'])              // delivered exactly once
    expect(lines.join('\n')).toContain('Sent to 1 page')
  })

  it('reports no page when the window elapses with nothing attached', async () => {
    await registerServer({ pid: process.ppid, port: server.port, url: `http://127.0.0.1:${server.port}`, file, startedAt: Date.now() })
    const { lines, restore } = captureLog()
    try {
      await runSend(file, 'go', 300)
    } finally {
      restore(); await unregisterServer(process.ppid)
    }
    expect(lines.join('\n')).toContain('No page connected after 0.3s')
  })
})
