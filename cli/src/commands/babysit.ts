import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { loadEnv } from '../env.js'
import { typebulbHome } from '../serve/paths.js'
import { isAlive } from '../serve/serverRegistry.js'
import { callerScope, sessionToWatch, sessionChildren, sessionStatus, sessionSlowMs } from '../../agents/core/server/childReport.js'
import { sessionThreads } from '../../agents/core/server/board.js'
import { babysitEvents } from '../../agents/core/childStatus.js'
import { childAdapters } from './status.js'

const POLL_MS = 10_000
// Housekeeping, as `wait`'s cap is: an orphan whose parent is gone should not watch for ever.
const GIVE_UP_MS = 12 * 60 * 60_000
const TOOL = 'typebulb_babysit'

/**
 * `typebulb babysit` — watch the calling session and stay silent until it needs the parent: a
 * sub-agent's idle stall, a call past the slow limit, a background call outliving its agent, a
 * failure streak (TB-Agent-Children.md), an agent past its time box, or the user's answer to an ask
 * (TB-Agent-Board.md). Then print what, one line each, and exit 0, which run in
 * the background is the parent's wake-up; it handles that and runs it again. A `slowMs` set is kept for
 * the session, and each poll reads it afresh, so a later `status --slow` applies. A condition fires once
 * while it lasts and again if it clears and comes back: what has fired is kept per session, so a
 * re-armed babysit resumes rather than repeating itself.
 *
 * A harness whose agents a process exit cannot wake (Codex) wakes through its own host instead
 * (`adapter.wake`, TB-Agent-Codex.md § Waking through the app server): only for the caller's own
 * session, checked reachable before arming, and an event counts as fired only once the host accepts
 * the turn, so a failed delivery fires again on the next run.
 *
 * Exit 0: delivered. 1: cannot babysit here. 2: gave up after the cap. 3: the session has ended, so
 * nobody is left to wake. 4: an event was found but its wake was refused. 5: a newer babysit took
 * this session over.
 */
export async function runBabysit(mode: string | undefined, slowMs?: number): Promise<void> {
  loadEnv(mode)
  const { caller, adapters } = childAdapters()
  // A harness that starts turns must know whose: never the newest session as a stand-in.
  const target = adapters.map(adapter => ({ adapter, ...(adapter.wake ? callerScope : sessionToWatch)(adapter, process.cwd()) })).find(t => t.sessionId)
  if (!target?.sessionId) return fail(!adapters.length ? `Babysit isn't supported for ${caller} sessions.`
    : adapters.some(a => a.wake) ? "Can't babysit: your own session couldn't be identified in this project, and a wake goes to no other."
    : 'No session to babysit in this project.')
  const { adapter, sessionId, cwd } = target
  sessionSlowMs(sessionId, slowMs)
  if (adapter.wake) {
    const route = await adapter.wakeRoute!(sessionId)
    if (route.error) return fail(`Can't babysit: ${route.error}.`)
  }

  const dir = join(typebulbHome(), 'babysit')
  const stateFile = join(dir, `${sessionId}.json`)
  const lockFile = join(dir, `${sessionId}.lock`)
  const replaced = takeLock(lockFile)
  let fired: string[] = []
  try { fired = JSON.parse(readFileSync(stateFile, 'utf8')) as string[] } catch {}
  const save = (keys: string[]) => { try { writeFileSync(stateFile, JSON.stringify(keys)) } catch {} }
  if (replaced) console.error(`Took over from the babysit already watching this session (pid ${replaced}), which stops at its next check.`)
  console.error(`Babysitting session ${sessionId}: this exits with a line when a sub-agent or the user's answer needs you; run it again after handling that.`)

  const deadline = Date.now() + GIVE_UP_MS
  while (Date.now() < deadline) {
    // Checked before any event, so a babysit nobody waits on never consumes one. Only another pid
    // counts: a missing lock is one the filesystem refused, and this one watches unlocked.
    const holder = lockHolder(lockFile)
    if (holder !== undefined && holder !== process.pid) end(5, 'A newer babysit took over this session.')
    if (adapter.sessionEnded?.(sessionId, cwd)) end(3, 'The session this babysits has ended.')
    const s = sessionChildren(adapter, cwd, sessionId)
    const { reports } = await sessionStatus(adapter, cwd, s)
    // The session's tags, read incrementally across polls: an owner's answer on the board wakes it.
    const { threads } = sessionThreads(adapter, cwd, sessionId, s.file, s.children)
    const events = babysitEvents(reports, Date.now(), !!adapter.sessionsWorking?.(cwd)?.has(sessionId), sessionSlowMs(sessionId), threads)
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

// One babysit per session, so two cannot consume each other's events, and the newest wins: it is the
// one its parent is waiting on, where an older one may be an orphan whose exit wakes nobody (CC's
// TaskStop can kill the shell and leave node running). No process ancestry tells an orphan apart:
// under CC's background Bash the shells above node exit or re-parent while the command runs. The
// holder it replaces sees the lock is no longer its own at its next check and exits. The lock goes
// when its holder exits, however it exits. Returns the pid it took over from, if one was alive. A
// filesystem that refuses the lock leaves babysit watching unlocked, as before.
function takeLock(file: string): number | undefined {
  try { mkdirSync(join(file, '..'), { recursive: true }) } catch {}
  const held = lockHolder(file)
  try { writeFileSync(file, String(process.pid)) } catch {}
  process.on('exit', () => { try { if (lockHolder(file) === process.pid) rmSync(file) } catch {} })
  return held && held !== process.pid && isAlive(held) ? held : undefined
}

// The pid a lock names; undefined for a missing or unreadable lock.
function lockHolder(file: string): number | undefined {
  try { return Number(readFileSync(file, 'utf8')) || undefined } catch { return undefined }
}
