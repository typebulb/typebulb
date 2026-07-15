import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as http from 'http'
import * as net from 'net'
import * as path from 'path'
import * as fs from 'fs/promises'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { pushBulb } from '../src/commands/push.js'
import type { PullTarget } from '../src/commands/pull.js'
import { parseArgs } from '../src/args.js'

/**
 * `typebulb push` (TB-Push-Pull.md) — the raw-markdown PUT twin. What matters on the wire:
 * the Bearer token, If-Unmodified-Since from the file's mtime (omitted under --force), and the
 * post-push mtime stamp to the server's updatedAt (mtime IS the last-synced marker, Invariant 5).
 */

const MARKDOWN = '---\nformat: typebulb/v1\nname: Birds\n---\n\n**code.tsx**\n\n```tsx\nconsole.log(1)\n```\n'
const UPDATED_AT = Date.parse('2026-07-15T12:00:00.000Z')

let server: http.Server
let port: number
let tmp: string
let lastReq: { method?: string; auth?: string; ius?: string; body?: string } = {}

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
  tmp = await mkdtemp(path.join(tmpdir(), 'tb-push-'))
  server = http.createServer((req, res) => {
    let body = ''
    req.on('data', d => { body += d })
    req.on('end', () => {
      lastReq = { method: req.method, auth: req.headers.authorization, ius: req.headers['if-unmodified-since'] as string | undefined, body }
      if (req.url === '/u/ben/birds.md') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ id: 'x', updatedAt: UPDATED_AT, created: false, serverStripped: false }))
      } else if (req.url === '/u/ben/stale.md') {
        res.writeHead(409, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Remote changed — pull first, or push --force' }))
      } else {
        res.writeHead(401); res.end('Login required')
      }
    })
  })
  await new Promise<void>(r => server.listen(port, '127.0.0.1', r))
})

afterAll(() => { server?.close() })

const target = (slug: string, destFile: string): PullTarget =>
  ({ origin: `http://127.0.0.1:${port}`, userSlug: 'ben', slug, dest: destFile })

async function freshFile(name: string): Promise<string> {
  const d = path.join(tmp, name)
  await fs.writeFile(d, MARKDOWN)
  return d
}

describe('parseArgs: push', () => {
  it('captures the target and --force', () => {
    const a = parseArgs(['push', 'typebulbs/u/ben/birds.bulb.md', '--force'])
    expect(a.subcommand).toBe('push')
    expect(a.file).toBe('typebulbs/u/ben/birds.bulb.md')
    expect(a.force).toBe(true)
  })
})

describe('pushBulb', () => {
  it('PUTs the file bytes with the Bearer token and mtime as If-Unmodified-Since', async () => {
    const d = await freshFile('send.bulb.md')
    const { mtime } = await fs.stat(d)
    const out = await pushBulb(target('birds', d), { token: 'tb_abc' })
    expect(out).toEqual({ kind: 'pushed', created: false, serverStripped: false, updatedAt: UPDATED_AT })
    expect(lastReq.method).toBe('PUT')
    expect(lastReq.auth).toBe('Bearer tb_abc')
    expect(lastReq.body).toBe(MARKDOWN)
    expect(lastReq.ius).toBe(mtime.toUTCString())
  })

  it('stamps the file mtime to the server updatedAt after a push', async () => {
    const d = await freshFile('stamp.bulb.md')
    await pushBulb(target('birds', d), { token: 'tb_abc' })
    expect((await fs.stat(d)).mtime.getTime()).toBe(UPDATED_AT)
  })

  it('--force omits If-Unmodified-Since', async () => {
    const d = await freshFile('forced.bulb.md')
    await pushBulb(target('birds', d), { token: 'tb_abc', force: true })
    expect(lastReq.ius).toBeUndefined()
  })

  it('maps 409 to a conflict outcome carrying the server message', async () => {
    const d = await freshFile('stale.bulb.md')
    const out = await pushBulb(target('stale', d), { token: 'tb_abc' })
    expect(out).toEqual({ kind: 'conflict', message: 'Remote changed — pull first, or push --force' })
    expect((await fs.stat(d)).mtime.getTime()).not.toBe(UPDATED_AT)   // no stamp on failure
  })

  it('maps a 401 to http-error', async () => {
    const d = await freshFile('denied.bulb.md')
    expect(await pushBulb(target('secret', d), { token: 'tb_bad' })).toEqual({ kind: 'http-error', status: 401, message: 'Login required' })
  })
})
