import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as http from 'http'
import * as net from 'net'
import * as path from 'path'
import * as fs from 'fs/promises'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { createHash } from 'crypto'
import { parsePullTarget, pullBulb, type PullTarget } from '../src/commands/pull.js'
import { parseArgs } from '../src/args.js'
import { parseBulbUrlText } from '../agents/core/client/util.js'

/**
 * `typebulb pull` (TB-Push-Pull.md) — the URL/path ↔ identity mapping (Invariant 4: the path IS
 * the identity) and the stateless conflict guard (Invariant 5: refuse a differing local file,
 * --force is the only resolution). The wire is the public raw-markdown GET
 * (/u/<user>/<slug>.md — worker-served on typebulb.com, aliased by the API server), stubbed here.
 */

const ORIGIN = 'https://typebulb.com'
const CWD = path.resolve('/proj')
const dest = (user: string, slug: string) => path.join(CWD, 'typebulbs', 'u', user, `${slug}.bulb.md`)

describe('parsePullTarget', () => {
  it('parses a bulb page URL, host from the URL', () => {
    expect(parsePullTarget('https://typebulb.com/u/ben/birds', CWD, ORIGIN)).toEqual({
      origin: 'https://typebulb.com', userSlug: 'ben', slug: 'birds', dest: dest('ben', 'birds'),
    })
  })

  it('ignores trailing page-variant segments (/full)', () => {
    expect(parsePullTarget('https://typebulb.com/u/samples/bach/full', CWD, ORIGIN).slug).toBe('bach')
  })

  it('accepts the raw API .md URL', () => {
    const t = parsePullTarget('http://localhost:5999/api/scripts/u/ben/birds.md', CWD, ORIGIN)
    expect(t).toEqual({ origin: 'http://localhost:5999', userSlug: 'ben', slug: 'birds', dest: dest('ben', 'birds') })
  })

  it('rejects a non-bulb URL', () => {
    expect(() => parsePullTarget('https://typebulb.com/faq', CWD, ORIGIN)).toThrow(/Not a bulb URL/)
  })

  it('parses a conventional local file, host from the default origin', () => {
    const t = parsePullTarget(path.join('typebulbs', 'u', 'ben', 'birds.bulb.md'), CWD, 'http://localhost:5999')
    expect(t).toEqual({ origin: 'http://localhost:5999', userSlug: 'ben', slug: 'birds', dest: dest('ben', 'birds') })
  })

  it('rejects a local file outside the typebulbs/u/<user>/ convention — the path is the identity', () => {
    expect(() => parsePullTarget('birds.bulb.md', CWD, ORIGIN)).toThrow(/conventional bulb path/)
    expect(() => parsePullTarget(path.join('typebulbs', 'birds.bulb.md'), CWD, ORIGIN)).toThrow(/conventional bulb path/)
  })
})

describe('parseArgs: pull', () => {
  it('captures the target and --force', () => {
    const a = parseArgs(['pull', 'https://typebulb.com/u/ben/birds', '--force'])
    expect(a.subcommand).toBe('pull')
    expect(a.file).toBe('https://typebulb.com/u/ben/birds')
    expect(a.force).toBe(true)
  })
})

// The launcher's paste-to-pull gesture (TB-Push-Pull.md, Mirror surface): parsePullTarget's URL
// branch, browser-side and lenient — a paste needn't carry a protocol, and a non-URL must fall
// through to the ordinary name filter rather than throw.
describe('parseBulbUrlText', () => {
  it('parses the page URL variants', () => {
    expect(parseBulbUrlText('https://typebulb.com/u/ben/birds')).toEqual({ user: 'ben', slug: 'birds' })
    expect(parseBulbUrlText('https://typebulb.com/u/ben/birds/full')).toEqual({ user: 'ben', slug: 'birds' })
    expect(parseBulbUrlText('https://typebulb.com/u/ben/birds/full/some/route#x')).toEqual({ user: 'ben', slug: 'birds' })
    expect(parseBulbUrlText('https://typebulb.com/u/ben/birds.md')).toEqual({ user: 'ben', slug: 'birds' })
    expect(parseBulbUrlText('http://localhost:5999/api/scripts/u/ben/birds.md')).toEqual({ user: 'ben', slug: 'birds' })
  })
  it('accepts a protocol-less paste', () => {
    expect(parseBulbUrlText('typebulb.com/u/ben/birds/full')).toEqual({ user: 'ben', slug: 'birds' })
    expect(parseBulbUrlText('localhost:5999/u/ben/birds')).toEqual({ user: 'ben', slug: 'birds' })
  })
  it('stays a name filter for everything else', () => {
    expect(parseBulbUrlText('birds')).toBeUndefined()
    expect(parseBulbUrlText('foo.bulb.md')).toBeUndefined()
    expect(parseBulbUrlText('https://typebulb.com/faq')).toBeUndefined()
    expect(parseBulbUrlText('typebulb.com/u/ben')).toBeUndefined()
  })
})

// --- pullBulb against a stub of the raw-markdown GET ---

const MARKDOWN = '---\nformat: typebulb/v1\nname: Birds\n---\n\n**code.tsx**\n\n```tsx\nconsole.log(1)\n```\n'
const LAST_MODIFIED = 'Wed, 15 Jul 2026 03:00:00 GMT'
const md5 = (s: string) => createHash('md5').update(s).digest('hex')

let server: http.Server
let port: number
let tmp: string
let lastAuth: string | undefined

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const p = (srv.address() as net.AddressInfo).port
      srv.close(() => resolve(p))
    })
  })
}

beforeAll(async () => {
  port = await freePort()
  tmp = await mkdtemp(path.join(tmpdir(), 'tb-pull-'))
  server = http.createServer((req, res) => {
    lastAuth = req.headers.authorization
    if (req.url === '/u/ben/birds.md') {
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Last-Modified': LAST_MODIFIED })
      res.end(MARKDOWN)
    } else if (req.url === '/u/ben/pix.md') {
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Last-Modified': LAST_MODIFIED })
      res.end(MARKDOWN)
    } else if (req.url === '/u/ben/pix/assets') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify([
        { path: 'a.png', size: 3, md5: md5('AAA') },
        { path: 'sub/b.png', size: 3, md5: md5('BBB') },
      ]))
    } else if (req.url === '/u/ben/pix/assets/a.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' }); res.end('AAA')
    } else if (req.url === '/u/ben/pix/assets/sub/b.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' }); res.end('BBB')
    } else if (req.url === '/u/ben/secret.md') {
      res.writeHead(401); res.end('Login required')
    } else if (req.url === '/u/ben/spa-fallback.md') {
      // An SPA host answering an unhandled path with its HTML shell — a 200 that is NOT a bulb.
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<!DOCTYPE html><html></html>')
    } else {
      res.writeHead(404); res.end('{"error":"Not found"}')
    }
  })
  await new Promise<void>(r => server.listen(port, '127.0.0.1', r))
})

afterAll(() => { server?.close() })

const target = (slug: string, destFile: string): PullTarget =>
  ({ origin: `http://127.0.0.1:${port}`, userSlug: 'ben', slug, dest: destFile })

describe('pullBulb', () => {
  it('writes a new file (dirs created) and reports created', async () => {
    const d = path.join(tmp, 'new', 'typebulbs', 'u', 'ben', 'birds.bulb.md')
    expect(await pullBulb(target('birds', d))).toEqual({ kind: 'written', dest: d, created: true })
    expect(await fs.readFile(d, 'utf-8')).toBe(MARKDOWN)
  })

  it('is up-to-date on identical content, CRLF-insensitively', async () => {
    const d = path.join(tmp, 'same.bulb.md')
    await fs.writeFile(d, MARKDOWN.replace(/\n/g, '\r\n'))
    expect(await pullBulb(target('birds', d))).toEqual({ kind: 'up-to-date', dest: d })
    // the CRLF local copy is left alone
    expect(await fs.readFile(d, 'utf-8')).toContain('\r\n')
  })

  it('is up-to-date on EQUIVALENT content — loose authored formatting vs the canonical remote', async () => {
    const d = path.join(tmp, 'loose.bulb.md')
    // Same blocks, extra trailing blank lines outside any block.
    await fs.writeFile(d, MARKDOWN + '\n\n')
    expect(await pullBulb(target('birds', d))).toEqual({ kind: 'up-to-date', dest: d })
  })

  it('is up-to-date when only a local server.ts block differs — CLI-only, never on the remote', async () => {
    const d = path.join(tmp, 'server.bulb.md')
    await fs.writeFile(d, MARKDOWN + '\n**server.ts**\n\n```ts\nexport async function ping() { return 1 }\n```\n')
    expect(await pullBulb(target('birds', d))).toEqual({ kind: 'up-to-date', dest: d })
  })

  it('refuses a differing local file with both timestamps (no --force)', async () => {
    const d = path.join(tmp, 'edited.bulb.md')
    await fs.writeFile(d, MARKDOWN.replace('console.log(1)', 'console.log(2)  // local edit'))
    const out = await pullBulb(target('birds', d))
    expect(out.kind).toBe('conflict')
    if (out.kind === 'conflict') {
      expect(out.localMtime).toBeInstanceOf(Date)
      expect(out.remoteLastModified).toBe(LAST_MODIFIED)
    }
    expect(await fs.readFile(d, 'utf-8')).toContain('local edit')   // untouched
  })

  it('--force overwrites the differing file', async () => {
    const d = path.join(tmp, 'forced.bulb.md')
    await fs.writeFile(d, 'local stuff')
    expect(await pullBulb(target('birds', d), { force: true })).toEqual({ kind: 'written', dest: d, created: false })
    expect(await fs.readFile(d, 'utf-8')).toBe(MARKDOWN)
  })

  it('reports 404 and 401 as http-error outcomes', async () => {
    expect(await pullBulb(target('nope', path.join(tmp, 'x.bulb.md')))).toEqual({ kind: 'http-error', status: 404 })
    expect(await pullBulb(target('secret', path.join(tmp, 'y.bulb.md')))).toEqual({ kind: 'http-error', status: 401 })
  })

  it('refuses a 200 that is not markdown (SPA fallback) — nothing written', async () => {
    const d = path.join(tmp, 'spa.bulb.md')
    expect(await pullBulb(target('spa-fallback', d))).toEqual({ kind: 'not-markdown', contentType: 'text/html; charset=utf-8' })
    await expect(fs.access(d)).rejects.toThrow()
  })

  it('sends TYPEBULB_TOKEN as a Bearer header when provided, none otherwise', async () => {
    await pullBulb(target('birds', path.join(tmp, 'auth.bulb.md')), { token: 'tb_abc', force: true })
    expect(lastAuth).toBe('Bearer tb_abc')
    await pullBulb(target('birds', path.join(tmp, 'auth.bulb.md')), { force: true })
    expect(lastAuth).toBeUndefined()
  })
})

// --- the assets leg: assets follow every gesture that moves a bulb (TB-Assets.md) ---

describe('pullBulb — assets leg', () => {
  const proj = () => path.join(tmp, 'pix', 'typebulbs', 'u', 'ben')
  const bulb = () => path.join(proj(), 'pix.bulb.md')
  const asset = (...p: string[]) => path.join(proj(), 'pix', 'assets', ...p)

  it('downloads the folder beside the file', async () => {
    const out = await pullBulb(target('pix', bulb()))
    expect(out).toEqual({ kind: 'written', dest: bulb(), created: true, assets: { downloaded: 2, unchanged: 0, errors: [] } })
    expect(await fs.readFile(asset('a.png'), 'utf-8')).toBe('AAA')
    expect(await fs.readFile(asset('sub', 'b.png'), 'utf-8')).toBe('BBB')
  })

  it('a re-pull skips identical assets by md5', async () => {
    expect(await pullBulb(target('pix', bulb()))).toEqual(
      { kind: 'up-to-date', dest: bulb(), assets: { downloaded: 0, unchanged: 2, errors: [] } })
  })

  it('refuses a differing local asset without --force — nothing moved, text included', async () => {
    const d = path.join(tmp, 'pix-conflict', 'typebulbs', 'u', 'ben', 'pix.bulb.md')
    const a = path.join(tmp, 'pix-conflict', 'typebulbs', 'u', 'ben', 'pix', 'assets', 'a.png')
    await fs.mkdir(path.dirname(a), { recursive: true })
    await fs.writeFile(a, 'LOCAL')
    expect(await pullBulb(target('pix', d))).toEqual({ kind: 'asset-conflict', dest: d, paths: ['a.png'] })
    await expect(fs.access(d)).rejects.toThrow()
    expect(await fs.readFile(a, 'utf-8')).toBe('LOCAL')

    const forced = await pullBulb(target('pix', d), { force: true })
    expect(forced.kind).toBe('written')
    expect(await fs.readFile(a, 'utf-8')).toBe('AAA')
  })

  it('a bulb with no manifest pulls text-only (assets field absent)', async () => {
    const out = await pullBulb(target('birds', path.join(tmp, 'noassets.bulb.md')), { force: true })
    expect(out.kind).toBe('written')
    expect((out as { assets?: unknown }).assets).toBeUndefined()
  })
})
