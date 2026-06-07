import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as net from 'net'
import * as http from 'http'
import { startServer, type ServerInstance } from '../src/serve/server.js'

/** Reserve an ephemeral port, then release it for the server to bind. */
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

/**
 * Integration tests for the /__fs/read and /__fs/write routes.
 * Focus: binary integrity (no utf-8 mangling), UTF-8 text round-trip,
 * path-traversal rejection, and query-param path handling for write.
 */

let server: ServerInstance
let base: string

// A 256-byte buffer covering every byte value — includes sequences that are
// invalid UTF-8 (0x80, 0xFF, lone continuation bytes), the old failure mode.
const allBytes = new Uint8Array(256)
for (let i = 0; i < 256; i++) allBytes[i] = i

beforeAll(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-fs-'))
  fs.writeFileSync(path.join(base, 'hello.txt'), 'héllo 🌍', 'utf8')
  fs.writeFileSync(path.join(base, 'blob.bin'), allBytes)
  // trusted: these tests exercise the privileged routes themselves; the default-
  // deny (untrusted) behavior is covered in trustGate.test.ts.
  server = await startServer({ getHtml: () => '<html></html>', basePath: base, port: await freePort(), trusted: true })
})

afterAll(() => {
  server?.close()
  fs.rmSync(base, { recursive: true, force: true })
})

const url = (p: string) => `http://127.0.0.1:${server.port}${p}`

async function read(path: string) {
  return fetch(url('/__fs/read'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  })
}

describe('/__fs/read', () => {
  it('returns UTF-8 text decodable to the original string', async () => {
    const resp = await read('hello.txt')
    expect(resp.ok).toBe(true)
    const text = new TextDecoder('utf-8', { fatal: true }).decode(await resp.arrayBuffer())
    expect(text).toBe('héllo 🌍')
  })

  it('returns binary bytes byte-for-byte (no utf-8 corruption)', async () => {
    const resp = await read('blob.bin')
    expect(resp.ok).toBe(true)
    const bytes = new Uint8Array(await resp.arrayBuffer())
    expect(bytes).toEqual(allBytes)
  })

  it('rejects path traversal', async () => {
    const resp = await read('../../../etc/passwd')
    expect(resp.status).toBe(400)
  })

  it('404s a missing file with a JSON error body', async () => {
    const resp = await read('nope.txt')
    expect(resp.ok).toBe(false)
    expect((await resp.json()).error).toBeTruthy()
  })
})

describe('/__fs/write', () => {
  const write = (qs: string, body: BodyInit) =>
    fetch(url('/__fs/write?path=' + qs), { method: 'POST', body })

  it('writes binary bytes back intact', async () => {
    const resp = await write(encodeURIComponent('out.bin'), allBytes)
    expect(resp.ok).toBe(true)
    expect(new Uint8Array(fs.readFileSync(path.join(base, 'out.bin')))).toEqual(allBytes)
  })

  it('writes a string body as UTF-8', async () => {
    const resp = await write(encodeURIComponent('out.txt'), 'café ☕')
    expect(resp.ok).toBe(true)
    expect(fs.readFileSync(path.join(base, 'out.txt'), 'utf8')).toBe('café ☕')
  })

  it('creates parent directories', async () => {
    const resp = await write(encodeURIComponent('nested/deep/x.txt'), 'hi')
    expect(resp.ok).toBe(true)
    expect(fs.readFileSync(path.join(base, 'nested/deep/x.txt'), 'utf8')).toBe('hi')
  })

  it('rejects missing path', async () => {
    const resp = await fetch(url('/__fs/write'), { method: 'POST', body: 'x' })
    expect(resp.status).toBe(400)
  })

  it('rejects path traversal', async () => {
    const resp = await write(encodeURIComponent('../escape.txt'), 'x')
    expect(resp.status).toBe(400)
  })
})

// The privileged routes run with the user's Node/fs rights, so they must be
// reachable only from this machine's own page. fetch() forbids setting Host/
// Origin/Sec-Fetch-* (they're protected header names), so drive raw http to
// forge the headers a DNS-rebinding or cross-site attacker would send.
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

describe('local-only guards', () => {
  const readBody = JSON.stringify({ path: 'hello.txt' })
  const json = { 'Content-Type': 'application/json' }

  it('rejects a spoofed (non-local) Host header — DNS rebinding', async () => {
    expect(await raw('/__fs/read', { ...json, Host: 'evil.com' }, readBody)).toBe(403)
  })

  it('rejects a cross-site request (Sec-Fetch-Site)', async () => {
    expect(await raw('/__fs/read', { ...json, 'Sec-Fetch-Site': 'cross-site' }, readBody)).toBe(403)
  })

  it('rejects a foreign Origin when Sec-Fetch-Site is absent', async () => {
    expect(await raw('/__fs/read', { ...json, Origin: 'http://evil.com' }, readBody)).toBe(403)
  })

  it('allows the page\'s own same-origin call', async () => {
    expect(await raw('/__fs/read', { ...json, 'Sec-Fetch-Site': 'same-origin' }, readBody)).toBe(200)
  })

  it('allows a local Origin', async () => {
    expect(await raw('/__fs/read', { ...json, Origin: `http://127.0.0.1:${server.port}` }, readBody)).toBe(200)
  })
})
