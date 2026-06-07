import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, readdir } from 'fs/promises'
import { tmpdir } from 'os'
import * as path from 'path'
import { spawn, type ChildProcess } from 'child_process'
import { registerServer, type BulbServer } from '../src/serve/serverRegistry.js'
import { runStopScope } from '../src/commands/lifecycle.js'

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
  const kids: ChildProcess[] = []
  const here = process.cwd()
  const other = path.resolve(here, '..', 'tb-other-project')

  // A viewer + a bulb for THIS project, and a viewer + a bulb for ANOTHER project — the four-way set
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

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'tb-reap-'))
    process.env.TYPEBULB_SERVERS_DIR = dir
  })

  afterEach(async () => {
    delete process.env.TYPEBULB_SERVERS_DIR
    for (const k of kids) { try { if (k.pid) process.kill(k.pid) } catch { /* already gone */ } }
    kids.length = 0
    await rm(dir, { recursive: true, force: true })
  })

  it('--bulbs stops this project\'s bulbs only — viewer and other projects survive', async () => {
    const p = await registerFour()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await runStopScope('bulbs')
    log.mockRestore()
    expect(await until(() => !isAlive(p.hereBulb))).toBe(true)            // this project's bulb died
    expect(isAlive(p.hereView) && isAlive(p.otherView) && isAlive(p.otherBulb)).toBe(true) // the rest live
  })

  it('--agent stops this project\'s viewer only — its bulbs and other projects survive', async () => {
    const p = await registerFour()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await runStopScope('agent')
    log.mockRestore()
    expect(await until(() => !isAlive(p.hereView))).toBe(true)            // this project's viewer died
    expect(isAlive(p.hereBulb) && isAlive(p.otherView) && isAlive(p.otherBulb)).toBe(true) // the rest live
  })

  it('--global reaps every bulb and viewer across all projects, and empties the registry', async () => {
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
