import { describe, it, expect, afterEach } from 'vitest'
import { resolveAgent } from '../src/agentViewer/resolve.js'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * Bare `typebulb agent` resolves which harness to mirror instead of hardcoding claude (TB-Agent-Harness.md,
 * resolve.ts). Step 1 — the caller's env marker — is the pure, decisive part and is what these cover:
 * a pi agent must get pi, a Claude agent claude, off the one universal command. Step 2 (the disk-session
 * signal) touches the real `~/.claude`/`~/.pi` dirs, so it's left to live verification rather than mocked
 * here; step 3 (the machine-install signal) is testable — see below. NOTE: this test process itself inherits CLAUDECODE=1 when run
 * under Claude Code, so each case sets the env explicitly rather than trusting the ambient value.
 */
describe('resolveAgent — caller env marker (step 1)', () => {
  const saved = { c: process.env.CLAUDECODE, p: process.env.PI_CODING_AGENT }
  afterEach(() => {
    if (saved.c === undefined) delete process.env.CLAUDECODE; else process.env.CLAUDECODE = saved.c
    if (saved.p === undefined) delete process.env.PI_CODING_AGENT; else process.env.PI_CODING_AGENT = saved.p
  })

  it('CLAUDECODE=1 ⇒ claude', () => {
    process.env.CLAUDECODE = '1'
    delete process.env.PI_CODING_AGENT
    expect(resolveAgent(process.cwd())).toEqual({ name: 'claude' })
  })

  it('PI_CODING_AGENT=true ⇒ pi (overrides any disk/default fallthrough)', () => {
    delete process.env.CLAUDECODE
    process.env.PI_CODING_AGENT = 'true'
    expect(resolveAgent(process.cwd())).toEqual({ name: 'pi' })
  })

  it('claude wins when both markers are set (first registered)', () => {
    process.env.CLAUDECODE = '1'
    process.env.PI_CODING_AGENT = 'true'
    expect(resolveAgent(process.cwd())).toEqual({ name: 'claude' })
  })
})

/**
 * Step 3 — the machine-install signal (detectsInstalled): a fresh project has no sessions for anything,
 * and before this rung it silently defaulted to claude even when only pi (or both) was installed.
 * detectsInstalled reads the harness home dir via `homedir()` AT CALL TIME, and Node's homedir() reads
 * USERPROFILE (win) / HOME (posix) per call — so pointing both at a temp dir fakes the machine state.
 * Step 2 stays inert: the fresh temp cwd has never had sessions under the REAL home's session dirs
 * (those module-level constants keep the import-time home — fine, they list nothing for this cwd).
 */
describe('resolveAgent — machine-install signal (step 3)', () => {
  const saved = {
    c: process.env.CLAUDECODE, p: process.env.PI_CODING_AGENT,
    up: process.env.USERPROFILE, h: process.env.HOME,
  }
  const restore = (key: string, v: string | undefined) => {
    if (v === undefined) delete process.env[key]; else process.env[key] = v
  }
  const dirs: string[] = []
  const tmp = (prefix: string) => {
    const d = mkdtempSync(join(tmpdir(), prefix))
    dirs.push(d)
    return d
  }
  /** A fresh cwd + a fake home holding the given harness dirs; markers cleared (human terminal). */
  const freshProject = (homeDirs: string[]) => {
    delete process.env.CLAUDECODE
    delete process.env.PI_CODING_AGENT
    const home = tmp('tb-home-')
    for (const d of homeDirs) mkdirSync(join(home, d), { recursive: true })
    process.env.USERPROFILE = home
    process.env.HOME = home
    return tmp('tb-cwd-')
  }
  afterEach(() => {
    restore('CLAUDECODE', saved.c)
    restore('PI_CODING_AGENT', saved.p)
    restore('USERPROFILE', saved.up)
    restore('HOME', saved.h)
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it('only pi installed ⇒ pi (the fresh-project fix)', () => {
    const cwd = freshProject([join('.pi', 'agent')])
    expect(resolveAgent(cwd)).toEqual({ name: 'pi' })
  })

  it('both installed ⇒ ambiguous (the picker, not a silent claude)', () => {
    const cwd = freshProject(['.claude', join('.pi', 'agent')])
    expect(resolveAgent(cwd)).toEqual({ ambiguous: ['claude', 'pi'] })
  })

  it('neither installed ⇒ canonical default (first registered)', () => {
    const cwd = freshProject([])
    expect(resolveAgent(cwd)).toEqual({ name: 'claude' })
  })
})
