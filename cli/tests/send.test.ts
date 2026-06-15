import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { EventEmitter } from 'events'
import * as net from 'net'
import * as http from 'http'
import { startServer, type ServerInstance } from '../src/serve/server.js'

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
})

afterAll(() => server?.close())

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
