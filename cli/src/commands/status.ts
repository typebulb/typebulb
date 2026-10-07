import { loadEnv } from '../env.js'
import { agentAdapterFactories } from '../agentViewer/registry.js'
import { detectCallerHarness } from '../agentViewer/resolve.js'
import { sessionsWithChildren, sessionChildren, callerScope, matchChildren, sessionStatus, type SessionChildren } from '../../agents/core/server/childReport.js'
import { statusText, overviewText } from '../../agents/core/childStatus.js'
import { childName, childShownState, type ChildRow } from '../../agents/core/events.js'
import type { AgentAdapter } from '../../agents/core/server/adapter.js'

/** The harnesses whose sub-agents `status` and `babysit` read: the caller's own, or every one when
 *  the caller is unknown, kept to those that have children at all. */
export function childAdapters(): { caller: string | undefined; adapters: AgentAdapter[] } {
  const factories = agentAdapterFactories()
  const caller = detectCallerHarness()
  return { caller, adapters: (caller ? [caller] : Object.keys(factories)).map(n => factories[n]!() as AgentAdapter).filter(a => a.listChildren) }
}

/**
 * `typebulb status [agent]` — where a session's sub-agents stand, for the orchestrating agent that
 * spawned them (TB-Agent-Children.md): facts counted from their transcripts, no model call, so it
 * answers at once. Bare, the session's overview; named, one agent's report.
 */
export async function runStatus(query: string | undefined, mode: string | undefined): Promise<void> {
  loadEnv(mode)
  const { caller, adapters: able } = childAdapters()
  if (!able.length) {
    console.error(`Sub-agent status isn't supported for ${caller} sessions.`)
    process.exitCode = 1
    return
  }
  let first: SessionChildren | undefined
  for (const adapter of able) {
    const { sessionId: own, cwd } = callerScope(adapter, process.cwd())
    if (!query) {
      // The caller's own session, never another's for want of agents in it; outside one, the newest.
      const s = own ? sessionChildren(adapter, cwd, own) : sessionsWithChildren(adapter, cwd).next().value
      if (!s?.children.length) { if (own) { console.log('No sub-agents in this session yet.'); return } continue }
      const { reports, files } = await sessionStatus(adapter, cwd, s)
      console.log(overviewText(s.sessionId, reports, files, Date.now()))
      return
    }
    for (const s of sessionsWithChildren(adapter, cwd)) {
      first ??= s
      const hits = matchChildren(s, query)
      if (!hits.length) continue
      if (hits.length > 1) {
        console.error(`Several agents match "${query}"; name one by its id:`)
        for (const c of hits) console.error(`  ${row(c)}`)
        process.exitCode = 1
        return
      }
      console.log(statusText((await sessionStatus(adapter, cwd, s, hits[0]!.id)).reports[0]!, Date.now()))
      return
    }
  }
  if (!first) { console.log('No sub-agents in this project\'s sessions.'); return }
  // The overview folds finished agents into a count, so the ids to pick from are listed here.
  console.error(`No agent matches "${query}". The agents of session ${first.sessionId}:`)
  for (const c of first.children) console.error(`  ${row(c)}`)
  process.exitCode = 1
}

const row = (c: ChildRow) => `${c.id}  ${childShownState(c).padEnd(7)}  ${childName(c)}`
