import { describe, it, expect } from 'vitest'
import { findServer } from '../src/commands/lifecycle.js'
import type { BulbServer } from '../src/serve/serverRegistry.js'

/**
 * `findServer` resolves a `[file|pid|agent]` arg to a running server (lifecycle.ts). The case that
 * matters here: the literal token `agent` must resolve to THIS project's mirror harness-agnostically —
 * the symmetry with bare `typebulb agent` / `stop --agent`. Before this, an agent that launched via
 * auto-detect (never learning it was claude vs pi) had no working `wait`/`logs` command: `wait agent`
 * fell through to a file-path match and errored (Kimi 2.7 typed exactly that and gave up on verifying
 * its embed). A specific harness name still resolves its own mirror; a pid and a file path still win.
 */
const here = '/proj/app'
const other = '/proj/other'
const mk = (o: Partial<BulbServer>): BulbServer =>
  ({ pid: 1, port: 0, url: 'http://localhost/x', file: 'agent:pi', startedAt: 1, ...o })

describe('findServer — the literal `agent` token', () => {
  it('resolves `agent` to this cwd\'s mirror, whatever the harness', () => {
    const servers = [
      mk({ pid: 10, agent: 'claude', cwd: other }),
      mk({ pid: 11, agent: 'pi', cwd: here }),
    ]
    expect(findServer(servers, 'agent', here)?.pid).toBe(11)   // pi mirror for THIS project
  })

  it('resolves `agent` even when the only mirror is another harness', () => {
    const servers = [mk({ pid: 12, agent: 'claude', cwd: here })]
    expect(findServer(servers, 'agent', here)?.pid).toBe(12)
  })

  it('prefers the cwd mirror over an earlier cross-project one', () => {
    const servers = [
      mk({ pid: 20, agent: 'pi', cwd: other }),   // earlier in the registry, wrong project
      mk({ pid: 21, agent: 'pi', cwd: here }),
    ]
    expect(findServer(servers, 'agent', here)?.pid).toBe(21)
  })

  it('returns undefined when no mirror is running (a bulb-only registry)', () => {
    const servers = [mk({ pid: 30, file: '/proj/app/a.bulb.md', cwd: here })]
    expect(findServer(servers, 'agent', here)).toBeUndefined()
  })

  it('refuses to silently target another project\'s mirror — `agent` (no cwd match ⇒ undefined, not mirrors[0])', () => {
    const servers = [mk({ pid: 60, agent: 'pi', cwd: other })]   // a mirror, but for the WRONG project
    expect(findServer(servers, 'agent', here)).toBeUndefined()
  })

  it('refuses to silently target another project\'s mirror — a named harness too', () => {
    const servers = [mk({ pid: 61, agent: 'claude', cwd: other })]
    expect(findServer(servers, 'claude', here)).toBeUndefined()
  })

  it('still resolves a specific harness name to its own mirror', () => {
    const servers = [
      mk({ pid: 40, agent: 'claude', cwd: here }),
      mk({ pid: 41, agent: 'pi', cwd: here }),
    ]
    expect(findServer(servers, 'pi', here)?.pid).toBe(41)
    expect(findServer(servers, 'claude', here)?.pid).toBe(40)
  })

  it('a pid and a file path still resolve as before', () => {
    const servers = [
      mk({ pid: 50, agent: 'pi', cwd: here }),
      mk({ pid: 51, file: '/proj/app/a.bulb.md', cwd: here }),
    ]
    expect(findServer(servers, '51', here)?.pid).toBe(51)              // digits ⇒ pid
    expect(findServer(servers, '/proj/app/a.bulb.md', here)?.pid).toBe(51)  // file path
  })
})

/**
 * When BOTH a pi and a claude mirror run for the same project (the moment pi support let a cwd have two
 * mirrors), `agent` must resolve to the CALLER's own harness — a Claude Code wait renders into and must
 * watch the claude mirror, never the pi one. The pre-fix "first cwd match" picked whichever started
 * first (the pi mirror), so a Claude `wait agent` watched the pi log and missed its own embed render —
 * timing out against the wrong target (TB-Wait.md). This is the real-world
 * `C:\Code\chat` shape: a pi mirror started before a claude one.
 */
describe('findServer — `agent` disambiguated by the caller\'s harness', () => {
  const twoMirrors = [
    mk({ pid: 32672, agent: 'pi', cwd: here }),       // started first (earlier in the registry)
    mk({ pid: 38784, agent: 'claude', cwd: here }),   // started later
  ]

  it('a Claude caller gets the claude mirror, not the older pi one', () => {
    expect(findServer(twoMirrors, 'agent', here, 'claude')?.pid).toBe(38784)
  })

  it('a pi caller gets the pi mirror', () => {
    expect(findServer(twoMirrors, 'agent', here, 'pi')?.pid).toBe(32672)
  })

  it('an unmarked caller (a human) falls back to first-in-cwd', () => {
    expect(findServer(twoMirrors, 'agent', here)?.pid).toBe(32672)
  })

  it('a caller whose harness has no mirror here falls back to the cwd mirror', () => {
    const onlyPi = [mk({ pid: 70, agent: 'pi', cwd: here })]
    expect(findServer(onlyPi, 'agent', here, 'claude')?.pid).toBe(70)
  })
})
