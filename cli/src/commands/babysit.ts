import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { loadEnv } from '../env.js'
import { agentAdapterFactories } from '../agentViewer/registry.js'
import { detectCallerHarness } from '../agentViewer/resolve.js'
import { typebulbHome } from '../serve/paths.js'
import { sessionToWatch, sessionChildren, sessionStatus } from '../../agents/core/server/childReport.js'
import { babysitEvents } from '../../agents/core/childStatus.js'
import type { AgentAdapter } from '../../agents/core/server/adapter.js'

const POLL_MS = 10_000
// Housekeeping, as `wait`'s cap is: an orphan whose parent is gone should not watch for ever.
const GIVE_UP_MS = 12 * 60 * 60_000
const TOOL = 'typebulb_babysit'

/**
 * `typebulb babysit` — watch the calling session's sub-agents and stay silent until one needs the
 * parent (TB-Agent-Children.md): an idle stall, a background call outliving its agent, a failure
 * streak, several agents waiting at once. Then print what, one line each, and exit 0, which run in
 * the background is the parent's wake-up; it handles that and runs it again. A condition fires once
 * while it lasts and again if it clears and comes back: what has fired is kept per session, so a
 * re-armed babysit resumes rather than repeating itself.
 *
 * A harness whose agents a process exit cannot wake (Codex) wakes through its own host instead
 * (`adapter.wake`, TB-Agent-Codex.md § Waking through the app server): only for the caller's own
 * session, checked reachable before arming, and an event counts as fired only once the host accepts
 * the turn, so a failed delivery fires again on the next run.
 *
 * Exit 0: delivered. 1: cannot babysit here (or one already is). 2: gave up after the cap. 3: the
 * session has ended, so nobody is left to wake. 4: an event was found but its wake was refused.
 */
export async function runBabysit(mode: string | undefined): Promise<void> {
  loadEnv(mode)
  const cwd = process.cwd()
  const factories = agentAdapterFactories()
  const caller = detectCallerHarness()
  const adapters = (caller ? [caller] : Object.keys(factories)).map(n => factories[n]!() as AgentAdapter).filter(a => a.listChildren)
  // A harness that starts turns must know whose: never the newest session as a stand-in.
  const target = adapters.map(adapter => ({ adapter, sessionId: adapter.wake ? adapter.callerSessionId?.(cwd) : sessionToWatch(adapter, cwd) })).find(t => t.sessionId)
  if (!target?.sessionId) return fail(!adapters.length ? `Babysitting sub-agents isn't supported for ${caller} sessions.`
    : adapters.some(a => a.wake) ? "Can't babysit: your own session couldn't be identified in this project, and a wake goes to no other."
    : 'No session to babysit in this project.')
  const { adapter, sessionId } = target
  if (adapter.wake) {
    const route = await adapter.wakeRoute!(sessionId)
    if (route.error) return fail(`Can't babysit: ${route.error}.`)
  }

  const dir = join(typebulbHome(), 'babysit')
  const stateFile = join(dir, `${sessionId}.json`)
  if (!takeLock(join(dir, `${sessionId}.lock`))) return fail('A babysit is already watching this session.')
  let fired: string[] = []
  try { fired = JSON.parse(readFileSync(stateFile, 'utf8')) as string[] } catch {}
  const save = (keys: string[]) => { try { writeFileSync(stateFile, JSON.stringify(keys)) } catch {} }
  console.error(`Babysitting the sub-agents of session ${sessionId}: this exits with a line when one needs attention.`)

  const deadline = Date.now() + GIVE_UP_MS
  while (Date.now() < deadline) {
    if (adapter.sessionEnded?.(sessionId, cwd)) end(3, 'The session this babysits has ended.')
    const { reports } = await sessionStatus(adapter, cwd, sessionChildren(adapter, cwd, sessionId))
    const events = babysitEvents(reports, Date.now())
    const fresh = [...events].filter(([key]) => !fired.includes(key))
    // A condition that has cleared leaves the list, so its return fires again.
    if (!fresh.length) { fired = [...events.keys()]; save(fired) }
    else {
      const text = fresh.map(([, t]) => t).join('\n')
      if (adapter.wake) {
        // When it was seen and when the host took it, apart: a slow wake is then placeable.
        console.error(`detected ${new Date().toISOString()}`)
        try { await adapter.wake(sessionId, TOOL, text) } catch (e) {
          // Undelivered: left unfired, so the next run tries it again.
          save([...events.keys()].filter(k => !fresh.some(([f]) => f === k)))
          console.log(text)
          end(4, `Not delivered: ${e instanceof Error ? e.message : e}`)
        }
        console.error(`accepted ${new Date().toISOString()}`)
      }
      save([...events.keys()])
      console.log(text)
      end(0)
    }
    await new Promise(r => setTimeout(r, POLL_MS))
  }
  // A harness woken through its host would otherwise just go quiet: say so, so it can re-arm.
  if (adapter.wake) await adapter.wake(sessionId, TOOL, 'typebulb babysit stopped after 12 hours with nothing to report; run it again to keep watching.').catch(() => {})
  end(2, 'Nothing needed attention; gave up.')
}

function fail(message: string) {
  console.error(message)
  process.exitCode = 1
}

function end(code: number, message?: string): never {
  if (message) console.error(message)
  process.exit(code)
}

// One babysit per session, so two cannot consume each other's events. A lock whose process is gone
// is stale and taken over; the lock goes when this process exits, however it exits.
function takeLock(file: string): boolean {
  try {
    const pid = Number(readFileSync(file, 'utf8'))
    if (pid && pid !== process.pid) { process.kill(pid, 0); return false }
  } catch {}
  try {
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, String(process.pid))
    process.on('exit', () => { try { if (Number(readFileSync(file, 'utf8')) === process.pid) rmSync(file) } catch {} })
  } catch {}
  return true
}
