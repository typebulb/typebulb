import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as net from 'net'
import * as http from 'http'
import { startServer, type ServerInstance } from '../src/serve/server.js'

/**
 * Tier A — decision-function test for the privileged-endpoint CSRF guard
 * (TB-Security-Tests.md). It proves the server's *ruling* on a forged
 * `Sec-Fetch-Site` header: this is the same-site CSRF finding from
 * TB-Security-Attacks.md, at the layer the node test can reach.
 *
 * SCOPE CAVEAT (TB-Security-Tests.md Invariant 2): `fetch()` forbids setting
 * `Sec-Fetch-Site`, so — like fsRoutes.test.ts — we drive raw http to forge it.
 * That proves the route would 403 *if* the browser sent `same-site`; it does NOT
 * prove a browser stamps a cross-port localhost request `same-site`, nor that the
 * `no-cors`/`text-plain` send dodges preflight. That end-to-end claim is Tier B
 * (cli/tests/browser/csrfFs.test.ts). This test is necessary, not sufficient.
 *
 * RED on the current guard: csrfGuard only blocks `Sec-Fetch-Site: cross-site`
 * and accepts any local Origin, so a `same-site` (cross-port localhost) request
 * to a privileged endpoint returns 200. The fix tightens the guard to same-origin;
 * this file then goes GREEN with the same-origin liveness case still passing.
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
let base: string

beforeAll(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-csrf-'))
  fs.writeFileSync(path.join(base, 'hello.txt'), 'hi', 'utf8')
  // trusted: the victim is a Trusted bulb — the only tier where the privileged
  // endpoints are open, and so the only tier this CSRF can target.
  server = await startServer({ getHtml: () => '<html></html>', basePath: base, port: await freePort(), trusted: true })
})

afterAll(() => {
  server?.close()
  fs.rmSync(base, { recursive: true, force: true })
})

const url = (p: string) => `http://127.0.0.1:${server.port}${p}`

/** Drive raw http so we can forge the protected `Sec-Fetch-Site` / `Origin`
 *  headers a cross-origin caller would carry (fetch() refuses to set them). */
function raw(p: string, headers: Record<string, string>, body = ''): Promise<number> {
  return new Promise((resolve, reject) => {
    const u = new URL(url(p))
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST', headers },
      res => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)) },
    )
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

describe('privileged-endpoint CSRF guard', () => {
  const readBody = JSON.stringify({ path: 'hello.txt' })
  const json = { 'Content-Type': 'application/json' }
  // A sibling bulb / dev server / page on a *different localhost port* is the
  // attacker. Different port ⇒ a different origin, but the same registrable
  // domain ⇒ the browser labels the request `same-site`, not `cross-site`.
  const siblingPort = { 'Sec-Fetch-Site': 'same-site' }
  const siblingOrigin = { Origin: 'http://localhost:59999' }

  it('blocks a same-site (cross-port localhost) request to /__fs — the CSRF fix', async () => {
    expect(await raw('/__fs/read', { ...json, ...siblingPort }, readBody)).toBe(403)
  })

  it('blocks a sibling local Origin when Sec-Fetch-Site is absent', async () => {
    expect(await raw('/__fs/read', { ...json, ...siblingOrigin }, readBody)).toBe(403)
  })

  // Liveness (TB-Security-Apps.md cross-reference): the fix must not break the
  // legitimate caller — a bulb's own page reaching its own privileged endpoint.
  it('still allows the page\'s own same-origin call', async () => {
    expect(await raw('/__fs/read', { ...json, 'Sec-Fetch-Site': 'same-origin' }, readBody)).toBe(200)
  })

  it('still allows the server\'s own exact Origin', async () => {
    expect(await raw('/__fs/read', { ...json, Origin: `http://127.0.0.1:${server.port}` }, readBody)).toBe(200)
  })
})
