import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, readdir, writeFile, appendFile } from 'fs/promises'
import { tmpdir } from 'os'
import * as path from 'path'
import { spawn, type ChildProcess } from 'child_process'
import * as http from 'http'
import { registerServer, type BulbServer } from '../src/serve/serverRegistry.js'
import { runLogs, runStop, runStopScope, runWait } from '../src/commands/lifecycle.js'
import { VERSION } from '../src/version.js'

// `runStopScope` really SIGTERMs each matched pid, so the test registers pids that are safe to kill —
// never `process.pid` (that would kill the runner). We spawn idle node children for real pids, then
// assert each scope reaps exactly the right set AND leaves the rest alive. `bulbs`/`agent` scope to
// process.cwd(), so the "this project" entries are registered under it. Children are reaped in afterEach
// so this test can't itself leak the orphans it's about.

const isAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true }
  catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

const until = async (pred: () => boolean, ms = 3000): Promise<boolean> => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (pred()) return true
    await new Promise(r => setTimeout(r, 25))
  }
  return pred()
}

function spawnSleeper(): ChildProcess {
  const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  c.unref()
  return c
}

// A bulb runs in its page, so a wait on a page-driven run's completion tag can never fire once the
// tab is gone — the four-minute park of TB-Page-Lifecycle.md's incident 4. `wait` ends itself on the
// departure instead, with the same exit 3 a dead server gives. The rule is keyed on a departure THIS
// wait saw arrive, which is what lets it carry no exemption for the one wait that is armed AT zero
// pages (`--match "[page] connected"`), and the second case here is that exemption being unnecessary.
describe('runWait ends when the bulb\'s last page goes (TB-Page-Lifecycle.md, incident 4)', () => {
  let dir: string
  const kids: ChildProcess[] = []

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'tb-wait-'))
    process.env.TYPEBULB_SERVERS_DIR = dir
  })
  afterEach(async () => {
    delete process.env.TYPEBULB_SERVERS_DIR
    for (const k of kids) { try { if (k.pid) process.kill(k.pid) } catch { /* already gone */ } }
    kids.length = 0
    await rm(dir, { recursive: true, force: true })
  })

  /** A live bulb server whose log already holds a run and an OLD departure — the history a
   *  `--match` first run scans from 0, and must not mistake for its own observation. */
  const armed = async (): Promise<{ file: string; log: string }> => {
    const child = spawnSleeper(); kids.push(child)
    const file = path.join(process.cwd(), 'waited.bulb.md')
    await registerServer({ pid: child.pid!, port: 20301, url: 'http://127.0.0.1:20301', file, cwd: process.cwd(), startedAt: 1, version: VERSION })
    const log = path.join(dir, `${child.pid}.log`)
    await writeFile(log, '── run 1 ── 00:00:00\nstarted\n[page] disconnected\n')
    return { file, log }
  }

  const waitFor = async (file: string, match: string, timeoutSec: number) => {
    const errs: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const err = vi.spyOn(console, 'error').mockImplementation((m?: unknown) => { errs.push(String(m)) })
    const exit = vi.spyOn(process, 'exit').mockImplementation(((c?: number) => { throw new Error(`exit ${c}`) }) as never)
    try { await runWait(file, { match, timeoutSec }); return { code: 'no exit', errs } }
    catch (e) { return { code: (e as Error).message, errs } }
    finally { exit.mockRestore(); err.mockRestore(); log.mockRestore() }
  }

  it('exits 3 when the page departs mid-wait', async () => {
    const { file, log } = await armed()
    const running = waitFor(file, '=== done ===', 10)
    setTimeout(() => { void appendFile(log, 'step 1\n[page] disconnected\n') }, 700)
    const { code, errs } = await running
    expect(code).toBe('exit 3')
    expect(errs.join('\n')).toContain('closed while waiting')
  })

  it('does not cut off a wait armed AT zero pages on the departure it is armed to reverse', async () => {
    // The history written above ends in a departure, and this wait scans from offset 0 to catch an
    // arrival that landed before it attached. Firing there would break the one documented recipe for
    // a bulb with no page (TB-VSCode-Browser.md): share the link, wake on `[page] connected`.
    const { file } = await armed()
    const { code } = await waitFor(file, '[page] connected', 1)
    expect(code).toBe('exit 2')
  })
})

describe('runStopScope — the batch reaps', () => {
  let dir: string
  let savedClaude: string | undefined, savedPi: string | undefined
  const kids: ChildProcess[] = []
  const here = process.cwd()
  const other = path.resolve(here, '..', 'tb-other-project')

  // A mirror + a bulb for THIS project, and a mirror + a bulb for ANOTHER project — the four-way set
  // that distinguishes all three scopes. Returns the pids by role for the assertions.
  async function registerFour() {
    const hereView = spawnSleeper(), hereBulb = spawnSleeper(), otherView = spawnSleeper(), otherBulb = spawnSleeper()
    kids.push(hereView, hereBulb, otherView, otherBulb)
    const reg = (pid: number, extra: Partial<BulbServer>) =>
      registerServer({ pid, port: 0, url: `http://localhost/${pid}`, file: extra.file ?? 'agent:claude', startedAt: pid, ...extra })
    await reg(hereView.pid!, { agent: 'claude', cwd: here })
    await reg(hereBulb.pid!, { file: path.join(here, 'a.bulb.md'), cwd: here })
    await reg(otherView.pid!, { agent: 'claude', cwd: other })
    await reg(otherBulb.pid!, { file: path.join(other, 'b.bulb.md'), cwd: other })
    return { hereView: hereView.pid!, hereBulb: hereBulb.pid!, otherView: otherView.pid!, otherBulb: otherBulb.pid! }
  }

  // A second mirror for THIS project under the OTHER harness (pi) — registerFour's hereView is claude,
  // so this is the sibling that `--agent` scoping must spare for an agent caller but reap for a human.
  async function registerPiHere(): Promise<number> {
    const c = spawnSleeper(); kids.push(c)
    await registerServer({ pid: c.pid!, port: 0, url: `http://localhost/${c.pid}`, file: 'agent:pi', startedAt: c.pid!, agent: 'pi', cwd: here })
    return c.pid!
  }

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'tb-reap-'))
    process.env.TYPEBULB_SERVERS_DIR = dir
    // `--agent` scopes to the caller's harness via env markers; clear both so the base state is an
    // unmarked human (reap-all), and a test that wants an agent caller sets its marker explicitly.
    savedClaude = process.env.CLAUDECODE; savedPi = process.env.PI_CODING_AGENT
    delete process.env.CLAUDECODE; delete process.env.PI_CODING_AGENT
  })

  afterEach(async () => {
    delete process.env.TYPEBULB_SERVERS_DIR
    if (savedClaude === undefined) delete process.env.CLAUDECODE; else process.env.CLAUDECODE = savedClaude
    if (savedPi === undefined) delete process.env.PI_CODING_AGENT; else process.env.PI_CODING_AGENT = savedPi
    for (const k of kids) { try { if (k.pid) process.kill(k.pid) } catch { /* already gone */ } }
    kids.length = 0
    await rm(dir, { recursive: true, force: true })
  })

  it('--bulbs stops this project\'s bulbs only — mirror and other projects survive', async () => {
    const p = await registerFour()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await runStopScope('bulbs')
    log.mockRestore()
    expect(await until(() => !isAlive(p.hereBulb))).toBe(true)            // this project's bulb died
    expect(isAlive(p.hereView) && isAlive(p.otherView) && isAlive(p.otherBulb)).toBe(true) // the rest live
  })

  it('--agent stops this project\'s mirror only — its bulbs and other projects survive', async () => {
    const p = await registerFour()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await runStopScope('agent')
    log.mockRestore()
    expect(await until(() => !isAlive(p.hereView))).toBe(true)            // this project's mirror died
    expect(isAlive(p.hereBulb) && isAlive(p.otherView) && isAlive(p.otherBulb)).toBe(true) // the rest live
  })

  it('--agent from an agent caller reaps only its own harness mirror — the sibling harness survives', async () => {
    const p = await registerFour()
    const piHere = await registerPiHere()
    process.env.CLAUDECODE = '1'                                          // the caller is Claude Code
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await runStopScope('agent')
    log.mockRestore()
    expect(await until(() => !isAlive(p.hereView))).toBe(true)            // the caller's (claude) mirror died
    expect(isAlive(piHere)).toBe(true)                                    // the sibling (pi) mirror survives
    expect(isAlive(p.hereBulb) && isAlive(p.otherView) && isAlive(p.otherBulb)).toBe(true) // bulbs + other project live
  })

  it('--agent from an unmarked human reaps every mirror in the project', async () => {
    const p = await registerFour()
    const piHere = await registerPiHere()                                // beforeEach cleared the markers ⇒ human
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await runStopScope('agent')
    log.mockRestore()
    expect(await until(() => !isAlive(p.hereView) && !isAlive(piHere))).toBe(true) // both mirrors died
    expect(isAlive(p.hereBulb) && isAlive(p.otherView) && isAlive(p.otherBulb)).toBe(true) // bulbs + other project live
  })

  it('--global reaps every bulb and mirror across all projects, and empties the registry', async () => {
    const p = await registerFour()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await runStopScope('global')
    log.mockRestore()
    expect(await readdir(dir)).toEqual([])
    expect(await until(() =>
      !isAlive(p.hereView) && !isAlive(p.hereBulb) && !isAlive(p.otherView) && !isAlive(p.otherBulb))).toBe(true)
  })

  it('--global reports nothing to do on an empty registry', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await runStopScope('global')
    expect(log).toHaveBeenCalledWith('No running bulb servers.')
    log.mockRestore()
  })
})

describe('the server listing marks a stale runtime (TB-CLI.md, server lifecycle & the reap)', () => {
  let dir: string
  const here = process.cwd()

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'tb-stale-'))
    process.env.TYPEBULB_SERVERS_DIR = dir
  })

  afterEach(async () => {
    delete process.env.TYPEBULB_SERVERS_DIR
    await rm(dir, { recursive: true, force: true })
  })

  /** The no-arg `logs` listing, captured. Live pids only (the list prunes), so pid/ppid. */
  const listing = async (): Promise<string> => {
    const out: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation((m?: unknown) => { out.push(String(m)) })
    await runLogs(undefined, { follow: false })
    log.mockRestore()
    return out.join('\n')
  }

  it('an unstamped entry presumes stale; a current one is silent', async () => {
    // `version: undefined` defeats the register-time stamp — the fabricated pre-stamp orphan.
    await registerServer({ pid: process.pid, port: 3000, url: 'u', file: path.join(here, 'current.bulb.md'), startedAt: 1 })
    await registerServer({ pid: process.ppid, port: 3001, url: 'u', file: path.join(here, 'old.bulb.md'), startedAt: 2, version: undefined })
    const text = await listing()
    const lineOf = (stem: string) => text.split('\n').find(l => l.includes(`${stem}.bulb.md`)) ?? ''
    expect(lineOf('old')).toContain('STALE runtime (predates the version stamp')
    expect(lineOf('current')).not.toContain('STALE')
  })

  it('an older stamped version is marked with both versions', async () => {
    await registerServer({ pid: process.pid, port: 3000, url: 'u', file: path.join(here, 'aged.bulb.md'), startedAt: 1, version: '0.0.0-alpha' })
    const text = await listing()
    expect(text).toContain('STALE runtime v0.0.0-alpha')
    expect(text).toContain(`this CLI is v${VERSION}`)
  })
})

// "Stopped" asserts an intention, and an intention carries the observation behind it
// (TB-Page-Lifecycle.md, invariant 4): the line says what happened to the pages, and a forced stop
// says it could not tell.
describe('runStop reports what the stop observed', () => {
  let dir: string
  const kids: ChildProcess[] = []

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'tb-stop-'))
    process.env.TYPEBULB_SERVERS_DIR = dir
  })
  afterEach(async () => {
    delete process.env.TYPEBULB_SERVERS_DIR
    for (const k of kids) { try { if (k.pid) process.kill(k.pid) } catch { /* already gone */ } }
    kids.length = 0
    await rm(dir, { recursive: true, force: true })
  })

  /** An owner that answers `/__stop` with a page count and then exits, as a real one does. */
  async function stubOwner(pid: number, answer: { closed: number; stuck: number }) {
    const srv = http.createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(answer))
        try { process.kill(pid) } catch { /* already gone */ }
      })
    })
    await new Promise<void>(r => srv.listen(0, '127.0.0.1', r))
    return { port: (srv.address() as { port: number }).port, close: () => srv.close() }
  }

  const stopAndRead = async (url: string, pid: number, version = VERSION) => {
    const file = path.join(process.cwd(), 'stopped.bulb.md')
    await registerServer({ pid, port: 20101, url, file, cwd: process.cwd(), startedAt: 1, version })
    const out: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation((m?: unknown) => { out.push(String(m)) })
    try { await runStop(file) } finally { log.mockRestore() }
    return out.join('\n')
  }

  it('names the pages it closed', async () => {
    const child = spawnSleeper(); kids.push(child)
    const stub = await stubOwner(child.pid!, { closed: 2, stuck: 0 })
    try {
      expect(await stopAndRead(`http://127.0.0.1:${stub.port}`, child.pid!)).toContain('closed 2 pages')
    } finally { stub.close() }
  })

  it('names the page that would not go', async () => {
    const child = spawnSleeper(); kids.push(child)
    const stub = await stubOwner(child.pid!, { closed: 0, stuck: 1 })
    try {
      expect(await stopAndRead(`http://127.0.0.1:${stub.port}`, child.pid!)).toContain('1 did not close')
    } finally { stub.close() }
  })

  it('says it was forced when nothing answered — the one stop that cannot make the claim', async () => {
    const child = spawnSleeper(); kids.push(child)
    const line = await stopAndRead('http://127.0.0.1:1', child.pid!)
    expect(line).toContain('forced')
    expect(line).toContain('it did not answer')
    expect(line).toContain('may still be open')
    expect(await until(() => !isAlive(child.pid!))).toBe(true)
  })

  // A forced stop names its cause where the registry knows it: a runtime older than this CLI has no
  // stop route to answer with, so "it did not answer" would read as a wedged server (Reporting).
  it('names the runtime skew when that is why nothing answered', async () => {
    const child = spawnSleeper(); kids.push(child)
    const line = await stopAndRead('http://127.0.0.1:1', child.pid!, '0.0.0-alpha')
    expect(line).toContain('its runtime v0.0.0-alpha predates the stop route')
    expect(await until(() => !isAlive(child.pid!))).toBe(true)
  })
})
