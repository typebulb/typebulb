import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as net from 'net'
import * as http from 'http'
import { startServer, type ServerInstance } from '../src/serve/server.js'

/**
 * Path-traversal probe for serveStaticDir (the `/local/<name>/` --replace route and
 * the agent mirror's bundled-asset route). Unlike /__fs (path in the JSON body, tested
 * in fsRoutes.test.ts), this route takes the path from the URL pathname and runs
 * decodeURIComponent before resolvePath — so it must survive %2e%2e%2f, Windows `\`,
 * and drive-letter absolutes. This is an ungated GET route (no trust gate, no CSRF),
 * so a leak here is broadly reachable. Raw http throughout: fetch()/URL normalize `..`
 * segments client-side, which would hide the very escapes we mean to forge.
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
let root: string       // parent: holds the secret
let assetsDir: string  // the served dir (a subdir of root)

const MOUNT = '/assets/'
const SECRET = 'TOPSECRET-do-not-leak'

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-static-'))
  assetsDir = path.join(root, 'assets')
  fs.mkdirSync(assetsDir)
  fs.writeFileSync(path.join(assetsDir, 'app.js'), 'export const ok = 1\n', 'utf8')
  // The forbidden quarry: one level above the served dir.
  fs.writeFileSync(path.join(root, 'secret.txt'), SECRET, 'utf8')
  server = await startServer({
    getHtml: () => '<html></html>',
    basePath: root,
    port: await freePort(),
    staticAssets: { mount: MOUNT, dir: assetsDir },
  })
})

afterAll(() => {
  server?.close()
  fs.rmSync(root, { recursive: true, force: true })
})

/** Raw GET: send `rawPath` verbatim (no URL/fetch normalization). */
function rawGet(rawPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port: server.port, path: rawPath, method: 'GET' },
      res => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', c => (body += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

describe('serveStaticDir control', () => {
  it('serves a real in-dir asset (proves the route is live)', async () => {
    const r = await rawGet(`${MOUNT}app.js`)
    expect(r.status).toBe(200)
    expect(r.body).toContain('export const ok')
  })
})

describe('serveStaticDir refuses traversal out of the served dir', () => {
  // Every one of these, if it leaked, would return SECRET. The assertion is on the
  // *bytes*, not just the status, per the harness rule: observe the real side effect.
  const escapes = [
    `${MOUNT}..%2fsecret.txt`,
    `${MOUNT}..%2F..%2Fsecret.txt`,
    `${MOUNT}%2e%2e%2fsecret.txt`,
    `${MOUNT}%2e%2e/secret.txt`,
    `${MOUNT}..%5csecret.txt`,           // Windows backslash, encoded
    `${MOUNT}..%5Csecret.txt`,
    `${MOUNT}..\\secret.txt`,            // raw backslash in the path
    `${MOUNT}../secret.txt`,             // raw dots (raw http won't normalize)
  ]
  for (const p of escapes) {
    it(`does not leak via ${p}`, async () => {
      const r = await rawGet(p)
      expect(r.body).not.toContain(SECRET)
    })
  }

  it('does not leak a drive-letter absolute path', async () => {
    // decodeURIComponent → C:\...secret.txt ; path.resolve treats it as absolute → outside base.
    const abs = path.join(root, 'secret.txt')
    const encoded = MOUNT + encodeURIComponent(abs)
    const r = await rawGet(encoded)
    expect(r.body).not.toContain(SECRET)
  })

  it('does not leak via a double-encoded escape', async () => {
    const r = await rawGet(`${MOUNT}%252e%252e%252fsecret.txt`)
    expect(r.body).not.toContain(SECRET)
  })
})
