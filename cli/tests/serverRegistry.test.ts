import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readdir } from 'fs/promises'
import { tmpdir } from 'os'
import * as path from 'path'
import { listBulbServers, registerServer, stopBulbServer, bulbServerCommand } from '../src/serve/serverRegistry.js'

// A pid that cannot be alive: well above any real-world pid space, so process.kill(_, 0)
// reports ESRCH (dead) on every platform.
const DEAD_PID = 2_000_000_000

describe('serverRegistry', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'tb-servers-'))
    process.env.TYPEBULB_SERVERS_DIR = dir
  })

  afterEach(async () => {
    delete process.env.TYPEBULB_SERVERS_DIR
    await rm(dir, { recursive: true, force: true })
  })

  it('lists only live servers and prunes dead entries on read', async () => {
    await registerServer({ pid: process.pid, port: 3000, url: 'http://localhost:3000', file: '/a.bulb.md', startedAt: 1 })
    await registerServer({ pid: DEAD_PID, port: 3001, url: 'http://localhost:3001', file: '/b.bulb.md', startedAt: 2 })

    const live = await listBulbServers()
    expect(live.map(s => s.pid)).toEqual([process.pid])

    // The dead entry's file is gone from disk (pruned), the live one remains.
    expect(await readdir(dir)).toEqual([`${process.pid}.json`])
  })

  it('sorts live servers oldest-first', async () => {
    // Two distinct, genuinely-live pids: this process and its parent (the test runner).
    // Registered newer-first to prove the sort, not insertion order, drives the result.
    await registerServer({ pid: process.pid, port: 3000, url: 'u', file: '/newer.bulb.md', startedAt: 200 })
    await registerServer({ pid: process.ppid, port: 3001, url: 'u', file: '/older.bulb.md', startedAt: 100 })

    const live = await listBulbServers()
    expect(live.map(s => s.file)).toEqual(['/older.bulb.md', '/newer.bulb.md'])
  })

  it('stopBulbServer removes the entry and tolerates an already-dead pid', async () => {
    await registerServer({ pid: DEAD_PID, port: 3001, url: 'u', file: '/b.bulb.md', startedAt: 2 })
    await expect(stopBulbServer(DEAD_PID)).resolves.toBeUndefined()
    expect(await readdir(dir)).toEqual([])
  })

  it('listBulbServers returns [] when the registry dir does not exist', async () => {
    await rm(dir, { recursive: true, force: true })
    expect(await listBulbServers()).toEqual([])
  })

  // Self-exclusion (Specs/Typebulb-CLI-Agent-Viewer.md): the cwd-scoped list — what a launcher's
  // running-server menu shows — must drop an agent viewer, identified by its `agent` field (a viewer
  // has no project path). The global list keeps it, so the one-viewer-per-project dedup and
  // `stop claude` can still find it.
  it('cwd-scoped list drops an agent viewer (by its `agent` field) but the global list keeps it', async () => {
    const project = path.join(dir, 'proj')
    const userBulb = path.join(project, 'my.bulb.md')
    await registerServer({ pid: process.pid, port: 3000, url: 'http://localhost:3000', file: 'agent:claude', cwd: project, startedAt: 1, agent: 'claude' })
    await registerServer({ pid: process.ppid, port: 3001, url: 'http://localhost:3001', file: userBulb, cwd: project, startedAt: 2 })

    // Scoped to the project (the menu): only the user bulb — the viewer is excluded by `agent`.
    const scoped = await listBulbServers(project)
    expect(scoped.map(s => s.file)).toEqual([userBulb])

    // Global (no cwd): both survive, so `agent:claude` idempotency / `stop claude` can target it.
    const global = await listBulbServers()
    expect(global.map(s => s.agent ?? s.file).sort()).toEqual(['claude', userBulb].sort())
  })
})

describe('bulbServerCommand — the child is pinned to this package, not unpinned npx', () => {
  it('runs the current node on this package own bin, never `npx typebulb`', () => {
    const { command, args } = bulbServerCommand('/x.bulb.md')
    expect(command).toBe(process.execPath)              // the same node, not a PATH lookup
    expect(command).not.toBe('npx')
    expect(args[0].endsWith('index.js')).toBe(true)     // the bin sibling of serverRegistry's module
    expect(args).toContain('/x.bulb.md')
    expect(args).not.toContain('typebulb')              // no bare package name handed to npx
  })

  it('passes --trust only when trusted, --no-open only when open is false', () => {
    expect(bulbServerCommand('/x.bulb.md').args).not.toContain('--trust')
    expect(bulbServerCommand('/x.bulb.md', { trust: true }).args).toContain('--trust')
    expect(bulbServerCommand('/x.bulb.md', { open: true }).args).not.toContain('--no-open')
    expect(bulbServerCommand('/x.bulb.md', { open: false }).args).toContain('--no-open')
  })
})
