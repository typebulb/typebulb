import { loadEnv } from '../env.js'
import { agentAdapterFactories } from '../agentViewer/registry.js'
import { detectCallerHarness } from '../agentViewer/resolve.js'
import { sessionsWithChildren, matchChildren, sessionStatus } from '../../agents/core/server/childReport.js'
import { statusText, overviewText } from '../../agents/core/childStatus.js'
import { childName, type ChildRow } from '../../agents/core/events.js'
import type { AgentAdapter } from '../../agents/core/server/adapter.js'

/**
 * `typebulb status [agent]` — where a session's sub-agents stand, for the orchestrating agent that
 * spawned them (TB-Agent-Children.md): facts counted from their transcripts, no model call, so it
 * answers at once. Bare, the session's overview; named, one agent's report.
 */
export async function runStatus(query: string | undefined, mode: string | undefined): Promise<void> {
  loadEnv(mode)
  const cwd = process.cwd()
  const factories = agentAdapterFactories()
  const caller = detectCallerHarness()
  const able = (caller ? [caller] : Object.keys(factories)).map(n => factories[n]!() as AgentAdapter).filter(a => a.listChildren)
  if (!able.length) {
    console.error(`Sub-agent status isn't supported for ${caller} sessions.`)
    process.exitCode = 1
    return
  }
  let any = false
  for (const adapter of able) for (const s of sessionsWithChildren(adapter, cwd)) {
    any = true
    if (!query) {
      const { reports, files } = await sessionStatus(adapter, cwd, s)
      console.log(overviewText(s.sessionId, reports, files, Date.now()))
      return
    }
    const hits = matchChildren(s, query)
    if (!hits.length) continue
    if (hits.length > 1) {
      console.error(`Several agents match "${query}"; name one by its id:`)
      for (const c of hits) console.error(`  ${row(c)}`)
      process.exitCode = 1
      return
    }
    console.log(statusText((await sessionStatus(adapter, cwd, s)).reports.find(r => r.id === hits[0]!.id)!, Date.now()))
    return
  }
  if (!any) { console.log('No sub-agents in this project\'s sessions.'); return }
  console.error(`No agent matches "${query}". Run \`typebulb status\` to list them.`)
  process.exitCode = 1
}

const row = (c: ChildRow) => `${c.id}  ${(c.failing && c.state !== 'stopped' ? 'failing' : c.state).padEnd(7)}  ${childName(c)}`
