import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as net from 'net'
import { startServer, type ServerInstance } from '../src/serve/server.js'

/**
 * Default-deny contract (TB-Trust.md, Invariant 1): a server
 * started without `trusted` must hard-deny the three privileged endpoints
 * (/__fs, /__api, /__ai) regardless of how the request arrives — the server-side
 * half of the gate, independent of the sandboxed-frame origin isolation. Benign
 * routes (the page, the CDN proxy) stay open.
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
const url = (p: string) => `http://127.0.0.1:${server.port}${p}`

beforeAll(async () => {
  // No `trusted` → the default (false): the secure-by-default launch.
  server = await startServer({
    getHtml: () => '<html>ok</html>',
    basePath: process.cwd(),
    port: await freePort(),
    trustHint: 'npx typebulb --trust x.bulb.md',
  })
})

afterAll(() => server?.close())

describe('untrusted launch denies the privileged endpoints', () => {
  it('403s /__fs/read', async () => {
    const r = await fetch(url('/__fs/read'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: 'x' }),
    })
    expect(r.status).toBe(403)
  })

  it('403s /__fs/write', async () => {
    const r = await fetch(url('/__fs/write?path=x'), { method: 'POST', body: 'data' })
    expect(r.status).toBe(403)
  })

  it('403s /__api/:name (even the built-in log)', async () => {
    const r = await fetch(url('/__api/log'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ args: ['hi'] }),
    })
    expect(r.status).toBe(403)
  })

  it('403s /__ai', async () => {
    const r = await fetch(url('/__ai'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(r.status).toBe(403)
  })

  it('names --trust in the denial body', async () => {
    const r = await fetch(url('/__fs/read'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: 'x' }),
    })
    expect(await r.text()).toContain('--trust')
  })

  it('still serves the bulb page', async () => {
    const r = await fetch(url('/'))
    expect(r.status).toBe(200)
  })
})
