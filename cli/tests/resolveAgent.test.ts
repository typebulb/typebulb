import { describe, it, expect, afterEach } from 'vitest'
import { resolveAgent } from '../src/agentViewer/resolve.js'

/**
 * Bare `typebulb agent` resolves which harness to mirror instead of hardcoding claude (TB-Harness.md,
 * resolve.ts). Step 1 — the caller's env marker — is the pure, decisive part and is what these cover:
 * a pi agent must get pi, a Claude agent claude, off the one universal command. Step 2 (the disk-session
 * signal) touches the real `~/.claude`/`~/.pi` dirs, so it's left to live verification rather than mocked
 * here. NOTE: this test process itself inherits CLAUDECODE=1 when run
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
