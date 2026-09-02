import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, rm, readdir, writeFile, chmod } from 'fs/promises'
import { tmpdir } from 'os'
import * as path from 'path'
import { spawn } from 'child_process'
import * as http from 'http'
import { listBulbServers, registerServer, stopBulbServer, bulbServerCommand, agentViewerCommand, findProjectViewer, readWaitCursor, writeWaitCursor, serversForBulb, stopServersForBulb, clearServerLog, readServerLog, serverLogPath, runMarker, sliceRunLog, type BulbServer } from '../src/serve/serverRegistry.js'
import { resolvePort, assignedPortFor, findAvailablePort, lastRunTimes } from '../src/serve/portBlocks.js'
import { runWeb } from '../src/run/web.js'
import { parseArgs } from '../src/args.js'
import { VERSION } from '../src/version.js'

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

  // The stamp lives in registerServer so NO launch path can register unversioned; an explicit
  // version survives, which is how a test fabricates a pre-stamp orphan (TB-CLI.md, lifecycle).
  it('stamps the registering runtime version; an explicit version wins', async () => {
    await registerServer({ pid: process.pid, port: 3000, url: 'u', file: '/a.bulb.md', startedAt: 1 })
    await registerServer({ pid: process.ppid, port: 3001, url: 'u', file: '/b.bulb.md', startedAt: 2, version: '0.44.0' })
    const live = await listBulbServers()
    expect(live.find(s => s.pid === process.pid)?.version).toBe(VERSION)
    expect(live.find(s => s.pid === process.ppid)?.version).toBe('0.44.0')
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

  // Bookkeeping is best-effort (TB-CLI.md, Port allocation): an unwritable home must not kill a
  // server that is already listening — it serves unregistered (logs/wait/send/stop won't see it).
  it('registerServer tolerates an unwritable home instead of throwing', async () => {
    const blocker = path.join(dir, 'blocker')
    await writeFile(blocker, '')                                     // a FILE where the home should be
    process.env.TYPEBULB_SERVERS_DIR = path.join(blocker, 'servers')
    await expect(registerServer({ pid: process.pid, port: 3000, url: 'u', file: '/a.bulb.md', startedAt: 1 })).resolves.toBeUndefined()
  })

  // Port allocation (TB-CLI.md) shares this per-user home. The property that matters is stickiness:
  // a bulb answers on the same port every run, which is what keeps an open tab pointed at a live
  // server across a relaunch. Distinct projects must not overlap, or one project's bulb would
  // silently take another's slot. Assertions go through `assignedPortFor` — the bookkeeping half —
  // so they stay hermetic: `resolvePort` probes real ports, and a developer running any bulb would
  // otherwise fail the suite (which is exactly what happened while writing it).
  describe('port blocks', () => {
    it('gives a bulb the same port on every run, and separates projects into blocks', async () => {
      const projA = path.join(dir, 'a')
      const projB = path.join(dir, 'b')
      // The project dirs must exist: a block whose cwd is gone is reclaimed on sight (that prune is
      // what stops deleted projects hoarding the band), so absent dirs would hand B the same block.
      await mkdir(projA, { recursive: true })
      await mkdir(projB, { recursive: true })
      const bulb1 = path.join(projA, 'one.bulb.md')
      const bulb2 = path.join(projA, 'two.bulb.md')

      const first = (await assignedPortFor({ kind: 'bulb', file: bulb1 }, projA))!
      expect(await assignedPortFor({ kind: 'bulb', file: bulb1 }, projA)).toBe(first)

      // A second bulb in the same project takes a different slot in the same block.
      // Bulbs count up from +1, so the two are consecutive and the units read as "app 1, app 2".
      const other = (await assignedPortFor({ kind: 'bulb', file: bulb2 }, projA))!
      expect(other).toBe(first + 1)
      expect(first % 100).toBe(1)

      // A different project gets its own block entirely.
      const elsewhere = (await assignedPortFor({ kind: 'bulb', file: path.join(projB, 'one.bulb.md') }, projB))!
      expect(Math.floor(elsewhere / 100)).not.toBe(Math.floor(first / 100))
    })

    it('gives the project its home port and keeps a second harness clear of app numbering', async () => {
      const proj = path.join(dir, 'proj')
      await mkdir(proj, { recursive: true })
      const claude = (await assignedPortFor({ kind: 'mirror', agent: 'claude' }, proj))!
      const pi = (await assignedPortFor({ kind: 'mirror', agent: 'pi' }, proj))!
      const bulb = (await assignedPortFor({ kind: 'bulb', file: path.join(proj, 'x.bulb.md') }, proj))!

      // The first harness owns +0 (the block base); the second counts down from the far end, leaving
      // the first bulb on +1 either way.
      expect(claude % 100).toBe(0)
      expect(pi % 100).toBe(99)
      expect(bulb).toBe(claude + 1)
      // Sticky, like a bulb's: `typebulb agent` lands on the same URL all week.
      expect(await assignedPortFor({ kind: 'mirror', agent: 'claude' }, proj)).toBe(claude)
    })

    it('honours an explicit port, and still records the run', async () => {
      const proj = path.join(dir, 'proj')
      await mkdir(proj, { recursive: true })
      const file = path.join(proj, 'explicit.bulb.md')
      // A port we've just confirmed free, so the strictness check passes and the test stays hermetic.
      const free = await findAvailablePort(45000)
      const t0 = Date.now()
      expect((await resolvePort({ explicit: free, target: { kind: 'bulb', file }, cwd: proj })).port).toBe(free)
      // The launch's "may a tab still be retrying?" read (TB-CLI.md hand-over) must see this run too.
      expect((await lastRunTimes(proj))(file)).toBeGreaterThanOrEqual(t0)
    })

    it('reports when a bulb last ran, and 0 before any run', async () => {
      const proj = path.join(dir, 'lr')
      await mkdir(proj, { recursive: true })
      const bulb = path.join(proj, 'x.bulb.md')
      // Read-only: asking must not claim a block for a project that has run nothing.
      expect((await lastRunTimes(proj))(bulb)).toBe(0)
      const t0 = Date.now()
      await assignedPortFor({ kind: 'bulb', file: bulb }, proj)   // a run's bookkeeping
      expect((await lastRunTimes(proj))(bulb)).toBeGreaterThanOrEqual(t0)
    })

    // The Codex-sandbox shape: the home READS fine but refuses writes. A held slot still answers
    // (its write is only the LRU refresh) and a new bulb still gets an offset — degraded stickiness,
    // never a crash; canBind arbitrates any cross-run drift (TB-CLI.md, Port allocation).
    it('keeps answering when the block file is read-only (sandboxed home)', async () => {
      const proj = path.join(dir, 'sandboxed')
      await mkdir(proj, { recursive: true })
      const bulb = path.join(proj, 'one.bulb.md')
      const held = (await assignedPortFor({ kind: 'bulb', file: bulb }, proj))!
      // typebulbHome() is the PARENT of TYPEBULB_SERVERS_DIR, so blocks/ sits beside the temp dir.
      const blockFile = path.join(dir, '..', 'blocks', `${held - (held % 100)}.json`)
      await chmod(blockFile, 0o444)
      try {
        expect(await assignedPortFor({ kind: 'bulb', file: bulb }, proj)).toBe(held)
        const fresh = (await assignedPortFor({ kind: 'bulb', file: path.join(proj, 'two.bulb.md') }, proj))!
        expect(fresh).toBe(held + 1)   // computed though unpersisted
      } finally {
        await chmod(blockFile, 0o666)
      }
    })

    // A keep is a promise about the bind, so it is kept or the launch aborts (TB-Page-Lifecycle.md).
    // Keyed off the replace instead of the page, the abort could never fire on the mirror's launch
    // path, which stops the predecessor in the host process. Real ports, so it sits by the allocator.
    it('aborts rather than spill off the slot a page may be waiting at', async () => {
      const proj = path.join(dir, 'promised')
      await mkdir(proj, { recursive: true })
      const bulb = path.join(proj, 'kept.bulb.md')
      await writeFile(bulb, '---\nformat: typebulb/v1\nname: Kept\n---\n')
      // Claiming the slot is also the "this bulb has run" record the launch reads — exactly what the
      // host's pre-spawn `assignedPortFor` leaves behind for its child to find.
      const slot = (await assignedPortFor({ kind: 'bulb', file: bulb }, proj))!
      const squatter = http.createServer()
      await new Promise<void>(r => squatter.listen(slot, '127.0.0.1', r))

      const cwd0 = process.cwd()
      const errs: string[] = []
      const errSpy = vi.spyOn(console, 'error').mockImplementation((m?: unknown) => { errs.push(String(m)) })
      const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`) }) as never)
      process.chdir(proj)   // runWeb reads the project from process.cwd(), as a launched run does
      try {
        await expect(runWeb(bulb, parseArgs([bulb, '--no-open']), '', undefined)).rejects.toThrow('exit 1')
        expect(errs.join('\n')).toContain(`Port ${slot} is this bulb's`)
      } finally {
        process.chdir(cwd0)
        exit.mockRestore(); errSpy.mockRestore()
        await new Promise<void>(r => squatter.close(() => r()))
      }
    }, 20000)
  })

  // Self-exclusion (TB-Agent-Mirror.md): the cwd-scoped list — what a launcher's
  // running-server menu shows — must drop an agent mirror, identified by its `agent` field (a mirror
  // has no project path). The global list keeps it, so the one-mirror-per-project dedup and
  // `stop claude` can still find it.
  it('cwd-scoped list drops an agent mirror (by its `agent` field) but the global list keeps it', async () => {
    const project = path.join(dir, 'proj')
    const userBulb = path.join(project, 'my.bulb.md')
    await registerServer({ pid: process.pid, port: 3000, url: 'http://localhost:3000', file: 'agent:claude', cwd: project, startedAt: 1, agent: 'claude' })
    await registerServer({ pid: process.ppid, port: 3001, url: 'http://localhost:3001', file: userBulb, cwd: project, startedAt: 2 })

    // Scoped to the project (the menu): only the user bulb — the mirror is excluded by `agent`.
    const scoped = await listBulbServers(project)
    expect(scoped.map(s => s.file)).toEqual([userBulb])

    // Global (no cwd): both survive, so `agent:claude` idempotency / `stop claude` can target it.
    const global = await listBulbServers()
    expect(global.map(s => s.agent ?? s.file).sort()).toEqual(['claude', userBulb].sort())
  })

  // The wait cursor (TB-Wait.md): the wake channel's consumer
  // offset. Round-trips per pid; anything unreadable degrades to undefined (⇒ the caller's no-cursor
  // default: log-start for a filtered wait, EOF snapshot for a bare one), never throws.
  it('wait cursor round-trips per pid and degrades to undefined when absent or invalid', async () => {
    expect(readWaitCursor(process.pid)).toBeUndefined()        // never written
    writeWaitCursor(process.pid, 1234)
    expect(readWaitCursor(process.pid)).toBe(1234)
    writeWaitCursor(process.pid, 0)                            // zero is a valid position
    expect(readWaitCursor(process.pid)).toBe(0)
    writeWaitCursor(DEAD_PID, -5)                              // junk in ⇒ undefined out
    expect(readWaitCursor(DEAD_PID)).toBeUndefined()
  })

  // Per-`--match` keying (TB-Wait.md): each pattern is its own consumer group,
  // so one waiter's exit can't move another pattern's offset. The empty key is the bare-wait baseline.
  it('wait cursors are keyed per --match and isolated from each other', async () => {
    writeWaitCursor(process.pid, 100, '[inline A')
    writeWaitCursor(process.pid, 200, '[inline B')
    writeWaitCursor(process.pid, 50)                          // bare baseline (empty key)
    expect(readWaitCursor(process.pid, '[inline A')).toBe(100)
    expect(readWaitCursor(process.pid, '[inline B')).toBe(200) // writing A left B untouched
    expect(readWaitCursor(process.pid)).toBe(50)
    expect(readWaitCursor(process.pid, '[inline C')).toBeUndefined()  // unseen pattern ⇒ caller falls back
  })

  // Regression: the prune once parsed `<pid>.wait.json` as a registry entry (a bare `.json` suffix
  // test), found no pid, and unlinked it as garbage — every registry read ate the cursor, so `wait`
  // never resumed. A live server's sidecars must survive the prune untouched.
  it('a live server\'s wait cursor survives a registry read', async () => {
    await registerServer({ pid: process.pid, port: 3000, url: 'u', file: '/a.bulb.md', startedAt: 1 })
    writeWaitCursor(process.pid, 777)
    await listBulbServers()
    expect(readWaitCursor(process.pid)).toBe(777)
  })

  it('the cursor is reaped with its server — on stop and on the liveness prune', async () => {
    await registerServer({ pid: DEAD_PID, port: 3001, url: 'u', file: '/b.bulb.md', startedAt: 2 })
    writeWaitCursor(DEAD_PID, 42)
    await listBulbServers()                                    // prune sweeps the dead entry + sidecars
    expect(readWaitCursor(DEAD_PID)).toBeUndefined()

    await registerServer({ pid: DEAD_PID, port: 3001, url: 'u', file: '/b.bulb.md', startedAt: 2 })
    writeWaitCursor(DEAD_PID, 42)
    await stopBulbServer(DEAD_PID)
    expect(readWaitCursor(DEAD_PID)).toBeUndefined()
  })

  // `typebulb logs --clear` (TB-CLI.md): the mid-session reset hot reload can't do. Truncates the
  // log, and a reader holding a pre-clear offset resyncs to 0 (the size-cap guard) rather than missing
  // the next run.
  it('clearServerLog truncates the log, and readServerLog resyncs a stale offset to 0', async () => {
    await writeFile(serverLogPath(process.pid), 'run 1 output\n')
    const staleOffset = readServerLog(process.pid).offset           // a reader caught up to here
    expect(readServerLog(process.pid).text).toBe('run 1 output\n')

    clearServerLog(process.pid)
    expect(readServerLog(process.pid).text).toBe('')

    await writeFile(serverLogPath(process.pid), 'run 2\n')           // the next, clean run
    expect(readServerLog(process.pid, staleOffset).text).toBe('run 2\n')   // offset > length ⇒ from 0
  })

  // `typebulb logs --run` (TB-CLI.md): slice the append-across-reloads log to one run, delimited by
  // the `runMarker` the runner emits at startup + each successful reload.
  it('sliceRunLog slices to one run, supports latest, and degrades when absent', () => {
    // Capture each marker once — runMarker stamps a wall-clock time, so re-calling it could differ.
    const [m1, m2, m3] = [runMarker(1), runMarker(2), runMarker(3)]
    const log = [
      m1, 'boot line', 'run-1 output',
      m2, 'run-2 output A', 'run-2 output B',
      m3, 'run-3 output',
    ].join('\n')

    expect(sliceRunLog(log, 1).split('\n')).toEqual([m1, 'boot line', 'run-1 output'])
    expect(sliceRunLog(log, 2).split('\n')).toEqual([m2, 'run-2 output A', 'run-2 output B'])
    expect(sliceRunLog(log, 'latest').split('\n')).toEqual([m3, 'run-3 output'])
    expect(sliceRunLog(log, 9)).toBe('')                          // a run absent from the (trimmed) log
    // No markers (pre-feature / never reloaded): whole text for latest, nothing for a specific id.
    expect(sliceRunLog('raw\nlines', 'latest')).toBe('raw\nlines')
    expect(sliceRunLog('raw\nlines', 1)).toBe('')
  })

  // One server per bulb file (TB-CLI.md "a launch replaces, never stacks"): the pure filter
  // behind the replace — canonical-path match, mirrors exempt, the calling process exempt.
  it('serversForBulb matches by canonical path, exempting mirrors and the calling process', () => {
    const file = path.join(dir, 'a.bulb.md')
    const entry = (over: Partial<BulbServer>): BulbServer => ({ pid: DEAD_PID, port: 1, url: 'u', file, startedAt: 1, ...over })
    const list = [
      entry({}),                                          // the doomed predecessor
      entry({ file: path.join(dir, 'b.bulb.md') }),       // a different bulb — untouched
      entry({ file: 'agent:claude', agent: 'claude' }),   // a mirror — exempt (its own reuse dedup)
      entry({ pid: process.pid }),                        // the calling process — never stops itself
    ]
    expect(serversForBulb(list, file)).toEqual([list[0]])
    // Case-insensitive volumes: a different casing of the same path is the same bulb.
    if (process.platform === 'win32') {
      expect(serversForBulb([entry({})], file.toUpperCase())).toEqual([entry({})])
    }
  })

  it('stopServersForBulb stops the live server for the file and leaves the rest', async () => {
    // A real, harmless child to be the doomed predecessor — stopping it must not touch the
    // test runner (process.pid is exempt) or the other bulb's server.
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' })
    try {
      const victim = path.join(dir, 'game.bulb.md')
      await registerServer({ pid: child.pid!, port: 3002, url: 'u', file: victim, startedAt: 1 })
      await registerServer({ pid: process.pid, port: 3000, url: 'u', file: path.join(dir, 'other.bulb.md'), startedAt: 2 })

      const stopped = await stopServersForBulb(victim)
      expect(stopped.map(s => s.pid)).toEqual([child.pid])
      expect((await listBulbServers()).map(s => s.pid)).toEqual([process.pid])
    } finally {
      child.kill()                                        // reap even on assertion failure
    }
  })

  // A replace is the same verb, and the reuse port is what decides the predecessor's pages
  // (TB-Page-Lifecycle.md): kept on the address we are about to take, closed on any other, since we
  // will never answer there. The disposition is the whole point, so the stub owner records it.
  describe('the replace predicate — which port decides the predecessor\'s pages', () => {
    /** An owner that answers `/__stop` and then exits, as a real one does. */
    async function stubOwner(pid: number) {
      const seen: Array<{ pages?: string }> = []
      const srv = http.createServer((req, res) => {
        let body = ''
        req.on('data', (d: Buffer) => { body += d })
        req.on('end', () => {
          seen.push(JSON.parse(body || '{}'))
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ closed: 1, stuck: 0 }))
          try { process.kill(pid) } catch { /* already gone */ }
        })
      })
      await new Promise<void>(r => srv.listen(0, '127.0.0.1', r))
      return { seen, port: (srv.address() as { port: number }).port, close: () => srv.close() }
    }

    const replaceWith = async (reusePort: number | undefined, predecessorPort: number) => {
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' })
      const stub = await stubOwner(child.pid!)
      try {
        const file = path.join(dir, 'replaced.bulb.md')
        await registerServer({ pid: child.pid!, port: predecessorPort, url: `http://127.0.0.1:${stub.port}`, file, startedAt: 1 })
        await stopServersForBulb(file, reusePort)
        return stub.seen
      } finally { stub.close(); child.kill() }
    }

    it('keeps the pages of a predecessor on the port we are about to take', async () => {
      expect(await replaceWith(20101, 20101)).toEqual([{ pages: 'keep' }])
    })

    it('closes the pages of one anywhere else — we would never answer there', async () => {
      expect(await replaceWith(20101, 20144)).toEqual([{ pages: 'close' }])
    })

    it('closes them when there is no assigned slot to promise (an unwritable home)', async () => {
      expect(await replaceWith(undefined, 20101)).toEqual([{ pages: 'close' }])
    })

    it('falls back to the kill when nothing answers, and still deregisters', async () => {
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' })
      try {
        const file = path.join(dir, 'wedged.bulb.md')
        // Port 1 is nothing of ours: the POST fails, so the stop is the kill it falls back to.
        await registerServer({ pid: child.pid!, port: 20101, url: 'http://127.0.0.1:1', file, startedAt: 1 })
        await stopServersForBulb(file, 20101)
        expect(await listBulbServers()).toEqual([])
      } finally { child.kill() }
    })
  })

  // The one-mirror-per-project dedup (TB-Agent-Mirror.md Invariant 2): a mirror is found by its
  // launch cwd + `agent` field, never by file, and a mirror in another project is a false "up".
  it('findProjectViewer matches a mirror by launch cwd, optionally narrowed by agent name', async () => {
    const here = path.join(dir, 'projA')
    const elsewhere = path.join(dir, 'projB')
    await registerServer({ pid: process.pid, port: 3000, url: 'http://localhost:3000', file: 'agent:claude', cwd: here, startedAt: 1, agent: 'claude' })
    await registerServer({ pid: process.ppid, port: 3001, url: 'http://localhost:3001', file: path.join(here, 'a.bulb.md'), cwd: here, startedAt: 2 })

    expect((await findProjectViewer(here))?.agent).toBe('claude')        // any mirror, never the bulb
    expect((await findProjectViewer(here, 'claude'))?.agent).toBe('claude')
    expect(await findProjectViewer(here, 'codex')).toBeUndefined()       // narrowed to an absent agent
    expect(await findProjectViewer(elsewhere)).toBeUndefined()           // another project's cwd
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

  // The env mode rides the relaunch: launchBulbServer inherits the replaced run's mode into these
  // opts, and the command must carry it to the child.
  it('passes --mode with its value, and omits it by default', () => {
    const args = bulbServerCommand('/x.bulb.md', { mode: 'staging' }).args
    expect(args.join(' ')).toContain('--mode staging')
    const bare = bulbServerCommand('/x.bulb.md').args
    expect(bare).not.toContain('--mode')
  })

  it('agentViewerCommand pins the same bin and always passes --no-open', () => {
    const { command, args } = agentViewerCommand('claude')
    expect(command).toBe(process.execPath)
    expect(args[0].endsWith('index.js')).toBe(true)
    expect(args).toContain('agent:claude')
    expect(args).toContain('--no-open')
  })
})
