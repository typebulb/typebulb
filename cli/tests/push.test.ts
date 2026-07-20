import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as http from 'http'
import * as net from 'net'
import * as path from 'path'
import * as fs from 'fs/promises'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { createHash } from 'crypto'
import { pushBulb, syncAssets, pruneAssets } from '../src/commands/push.js'
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
const assetReqs: { method: string; slug: string; rel?: string; contentType?: string; auth?: string }[] = []
const manifests: Record<string, { path: string; size: number; md5: string }[]> = {}

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
      // Hosted-assets wire for syncAssets (TB-Assets-Push.md): manifest GET + per-file PUT/DELETE.
      const assetWire = req.url?.match(/^\/u\/ben\/([^/]+)\/assets(?:\/(.+))?$/)
      if (assetWire) {
        const [, slug, rel] = assetWire
        assetReqs.push({ method: req.method!, slug, rel, contentType: req.headers['content-type'], auth: req.headers.authorization })
        if (req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(manifests[slug] ?? []))
        } else if (req.method === 'PUT') {
          if (slug === 'overcap') {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: `'${rel}' is 6.0MB — the per-file cap is 5.0MB; host big files yourself and reference them by absolute URL` }))
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ path: rel, size: body.length }))
          }
        } else { res.writeHead(204); res.end() }
        return
      }
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

describe('syncAssets (TB-Assets-Push.md: push carries the folder)', () => {
  const md5 = (s: string) => createHash('md5').update(s).digest('hex')
  const KEYLESS = '---\nformat: typebulb/v1\nname: Birds\n---\n\n**code.tsx**\n\n```tsx\nconsole.log(1)\n```\n'

  /** A keyless bulb (the hosted path) whose own folder's assets/ holds `files` (rel → content). */
  async function hostedBulb(name: string, files: Record<string, string>): Promise<string> {
    const dir = path.join(tmp, name)
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(dir, 'bulb', 'assets', ...rel.split('/'))
      await fs.mkdir(path.dirname(abs), { recursive: true })
      await fs.writeFile(abs, content)
    }
    await fs.mkdir(dir, { recursive: true })
    const file = path.join(dir, 'bulb.bulb.md')
    await fs.writeFile(file, KEYLESS)
    return file
  }

  const sync = (slug: string, file: string) => syncAssets(target(slug, file), { token: 'tb_abc' })

  it('uploads new files with their content type and reports the hosted base', async () => {
    const file = await hostedBulb('s-new', { 'robin.png': 'png-bytes', 'sub/nested.svg': 'svg' })
    expect(await sync('s-new', file)).toEqual({ kind: 'synced', uploaded: 2, unchanged: 0, toDelete: [], base: 'https://assets.typebulb.com/u/ben/s-new/' })
    const puts = assetReqs.filter(r => r.slug === 's-new' && r.method === 'PUT')
    expect(puts.map(p => p.rel).sort()).toEqual(['robin.png', 'sub/nested.svg'])
    expect(puts.find(p => p.rel === 'robin.png')?.contentType).toBe('image/png')
    expect(puts[0]?.auth).toBe('Bearer tb_abc')
  })

  it('skips byte-identical by md5, uploads changed, plans orphan deletes without executing them', async () => {
    const file = await hostedBulb('s-mixed', { 'same.png': 'keep', 'changed.png': 'v2' })
    manifests['s-mixed'] = [
      { path: 'same.png', size: 4, md5: md5('keep') },
      { path: 'changed.png', size: 2, md5: md5('v1') },
      { path: 'gone.png', size: 3, md5: md5('x') },
    ]
    expect(await sync('s-mixed', file)).toEqual({ kind: 'synced', uploaded: 1, unchanged: 1, toDelete: ['gone.png'], base: 'https://assets.typebulb.com/u/ben/s-mixed/' })
    expect(assetReqs.filter(r => r.slug === 's-mixed' && r.method === 'PUT').map(r => r.rel)).toEqual(['changed.png'])
    // add → commit → prune (TB-Assets-Push.md Invariant 5): sync itself never deletes — the old
    // live text may still reference the key until the text PUT commits.
    expect(assetReqs.filter(r => r.slug === 's-mixed' && r.method === 'DELETE')).toEqual([])
    expect(await pruneAssets(target('s-mixed', file), ['gone.png'], { token: 'tb_abc' })).toEqual({ deleted: ['gone.png'] })
    expect(assetReqs.filter(r => r.slug === 's-mixed' && r.method === 'DELETE').map(r => r.rel)).toEqual(['gone.png'])
  })

  it('nothing local, nothing remote → skipped, no writes', async () => {
    const file = await hostedBulb('s-empty', {})
    expect(await sync('s-empty', file)).toEqual({ kind: 'skipped' })
    expect(assetReqs.filter(r => r.slug === 's-empty' && r.method !== 'GET')).toEqual([])
  })

  it('an absent folder touches nothing (consumer copy); an emptied folder plans every key away', async () => {
    const file = await hostedBulb('s-clear', {})
    manifests['s-clear'] = [{ path: 'old.png', size: 1, md5: md5('o') }]
    // No assets/ dir at all — a pulled consumer copy: remote untouched, no wire traffic.
    expect(await sync('s-clear', file)).toEqual({ kind: 'skipped' })
    expect(assetReqs.filter(r => r.slug === 's-clear')).toEqual([])
    // The folder existing (even empty) is the author's manifest: remote = folder.
    await fs.mkdir(path.join(tmp, 's-clear', 'bulb', 'assets'), { recursive: true })
    expect(await sync('s-clear', file)).toMatchObject({ kind: 'synced', uploaded: 0, unchanged: 0, toDelete: ['old.png'] })
  })

  it('a refused upload (quota 400) surfaces as sync-error carrying the server message', async () => {
    const file = await hostedBulb('overcap', { 'big.png': 'x' })
    const r = await sync('overcap', file)
    expect(r.kind).toBe('sync-error')
    if (r.kind === 'sync-error') expect(r.message).toContain("'big.png'")
  })

  it('an unreachable manifest blocks the push only when there is something to sync', async () => {
    // userSlug 'other' misses the mock's asset wire → the manifest request 401s. The folder-less
    // bulb never reaches the wire at all; the one with files does, and the failure refuses.
    const t = (slug: string, dest: string): PullTarget => ({ origin: `http://127.0.0.1:${port}`, userSlug: 'other', slug, dest })
    const empty = await hostedBulb('s-noroute-empty', {})
    expect(await syncAssets(t('s-noroute-empty', empty), { token: 'tb_abc' })).toEqual({ kind: 'skipped' })
    const full = await hostedBulb('s-noroute-full', { 'x.png': 'x' })
    expect((await syncAssets(t('s-noroute-full', full), { token: 'tb_abc' })).kind).toBe('sync-error')
  })
})
