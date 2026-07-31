import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, readdir } from 'fs/promises'
import { tmpdir } from 'os'
import * as path from 'path'
import { spawn, type ChildProcess } from 'child_process'
import { registerServer, type BulbServer } from '../src/serve/serverRegistry.js'
import { runLogs, runStopScope } from '../src/commands/lifecycle.js'
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
