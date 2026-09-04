import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as net from 'net'
import * as http from 'http'
import { startServer, type ServerInstance } from '../src/serve/server.js'
import { bulbDataDir } from '../src/pipeline.js'
import { installServerTb } from '../src/serve/serverTb.js'

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

// TB-FS.md Containment: paths resolve against the bulb's folder (fsBase) and are fenced there —
// `../` is denied even inside the project.
describe('data-folder resolution (fsBase)', () => {
  let dataServer: ServerInstance
  let project: string

  beforeAll(async () => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-fsbase-'))
    fs.mkdirSync(path.join(project, 'typebulbs', 'other'), { recursive: true })
    fs.writeFileSync(path.join(project, 'typebulbs', 'other', 'sibling.txt'), 'sibling', 'utf8')
    dataServer = await startServer({
      getHtml: () => '<html></html>',
      basePath: project,
      fsBase: path.join(project, 'typebulbs', 'foo'),
      port: await freePort(),
      trusted: true,
    })
  })

  afterAll(() => {
    dataServer?.close()
    fs.rmSync(project, { recursive: true, force: true })
  })

  const durl = (p: string) => `http://127.0.0.1:${dataServer.port}${p}`
  const dread = (p: string) =>
    fetch(durl('/__fs/read'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: p }) })

  it('writes a relative path into the data folder (created on demand)', async () => {
    const resp = await fetch(durl('/__fs/write?path=' + encodeURIComponent('results.json')), { method: 'POST', body: '{"ok":1}' })
    expect(resp.ok).toBe(true)
    expect(fs.readFileSync(path.join(project, 'typebulbs', 'foo', 'results.json'), 'utf8')).toBe('{"ok":1}')
  })

  it('denies a ../ sibling — the fence is the bulb\'s folder, not the project', async () => {
    const resp = await dread('../other/sibling.txt')
    expect(resp.status).toBe(400)
  })

  const dlist = (p: string) =>
    fetch(durl('/__fs/list'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: p }) })

  it('lists a folder\'s immediate children with kind and mtime', async () => {
    fs.mkdirSync(path.join(project, 'typebulbs', 'foo', 'batches', 'pilot'), { recursive: true })
    const resp = await dlist('batches')
    expect(resp.ok).toBe(true)
    const entries = await resp.json() as Array<{ name: string; dir: boolean; mtime: number }>
    expect(entries).toEqual([expect.objectContaining({ name: 'pilot', dir: true })])
    expect(entries[0].mtime).toBeGreaterThan(0)
  })

  it('400s a missing folder on list, like a missing file on read', async () => {
    const resp = await dlist('nope')
    expect(resp.status).toBe(400)
  })

  const dremove = (p: string) =>
    fetch(durl('/__fs/remove'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: p }) })

  it('removes a file, and a folder with its contents', async () => {
    const foo = path.join(project, 'typebulbs', 'foo')
    fs.mkdirSync(path.join(foo, 'runs', 'a'), { recursive: true })
    fs.writeFileSync(path.join(foo, 'runs', 'a', 'x.json'), '{}', 'utf8')
    fs.writeFileSync(path.join(foo, 'stale.txt'), 'x', 'utf8')
    expect((await dremove('stale.txt')).ok).toBe(true)
    expect(fs.existsSync(path.join(foo, 'stale.txt'))).toBe(false)
    expect((await dremove('runs')).ok).toBe(true)
    expect(fs.existsSync(path.join(foo, 'runs'))).toBe(false)
  })

  it('400s a missing path on remove, and refuses the bulb\'s folder itself and ../', async () => {
    expect((await dremove('nope')).status).toBe(400)
    expect((await dremove('.')).status).toBe(400)
    expect(fs.existsSync(path.join(project, 'typebulbs', 'foo'))).toBe(true)
    expect((await dremove('../other')).status).toBe(400)
    expect(fs.existsSync(path.join(project, 'typebulbs', 'other', 'sibling.txt'))).toBe(true)
  })
})

// TB-FS.md: the bulb's folder is the sibling dir named for the filename stem.
describe('bulbDataDir', () => {
  it('derives the sibling folder from the filename stem', () => {
    expect(bulbDataDir(path.join('typebulbs', 'probe.bulb.md'))).toBe(path.resolve('typebulbs', 'probe'))
  })
})

// TB-FS.md "tb.fs in server.ts": the server-side mirror shares the routes' core (tbFs.ts) — same
// resolution, same fence, same on-write parent creation, same non-UTF-8 read error.
describe('server-side tb.fs (shared core)', () => {
  let project: string
  let bulbDir: string
  const tb = () => (globalThis as { tb?: any }).tb

  beforeAll(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-servertb-'))
    bulbDir = path.join(project, 'typebulbs', 'probe')   // not yet created
    installServerTb(bulbDir)
  })

  afterAll(() => {
    fs.rmSync(project, { recursive: true, force: true })
  })

  it('write creates the parent chain on demand and read round-trips', async () => {
    expect(await tb().fs.write('transcripts/x.md', 'héllo')).toBe(true)
    expect(fs.readFileSync(path.join(bulbDir, 'transcripts', 'x.md'), 'utf8')).toBe('héllo')
    expect(await tb().fs.read('transcripts/x.md')).toBe('héllo')
    expect((await tb().fs.list('transcripts')).map((e: { name: string; dir: boolean }) => [e.name, e.dir])).toEqual([['x.md', false]])
  })

  it('readBytes returns raw bytes; read rejects non-UTF-8 like the browser shim', async () => {
    await tb().fs.write('blob.bin', allBytes)
    expect(await tb().fs.readBytes('blob.bin')).toEqual(allBytes)
    await expect(tb().fs.read('blob.bin')).rejects.toThrow(/readBytes/)
  })

  it('denies leaving the bulb\'s folder — same fence as the /__fs routes', async () => {
    await expect(tb().fs.read('../sibling.txt')).rejects.toThrow(/traversal/)
  })

  it('remove drops a file or a folder tree; the bulb\'s folder itself is refused', async () => {
    expect(await tb().fs.remove('blob.bin')).toBe(true)
    expect(fs.existsSync(path.join(bulbDir, 'blob.bin'))).toBe(false)
    expect(await tb().fs.remove('transcripts')).toBe(true)
    expect(fs.existsSync(path.join(bulbDir, 'transcripts'))).toBe(false)
    await expect(tb().fs.remove('.')).rejects.toThrow(/folder itself/)
    await expect(tb().fs.remove('transcripts')).rejects.toThrow()
  })
})
