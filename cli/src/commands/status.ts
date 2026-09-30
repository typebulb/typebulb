import { loadEnv } from '../env.js'
import { agentAdapterFactories } from '../agentViewer/registry.js'
import { detectCallerHarness } from '../agentViewer/resolve.js'
import { sessionsWithChildren, matchChildren, childReport, type SessionChildren } from '../../agents/core/server/childReport.js'
import { childName, type ChildRow } from '../../agents/core/events.js'
import { formatDuration } from '../../agents/core/format.js'
import type { AgentAdapter } from '../../agents/core/server/adapter.js'

/**
 * `typebulb status [agent]` — a sub-agent's Status report for the orchestrating agent that spawned it
 * (TB-Agent-Children.md): what it was asked, where each subtask stands, its tests, anything to decide,
 * and the files it edited. The same text the mirror's Copy Status gives, with no mirror page open, so
 * an orchestrator can look at a child without waking it. Bare, it lists the agents it can name.
 */
export async function runStatus(query: string | undefined, mode: string | undefined): Promise<void> {
  loadEnv(mode)
  const cwd = process.cwd()
  const factories = agentAdapterFactories()
  const caller = detectCallerHarness()
  const able = (caller ? [caller] : Object.keys(factories)).map(n => factories[n]!() as AgentAdapter).filter(a => a.listChildren && a.childBriefs)
  if (!able.length) {
    console.error(`Sub-agent status isn't supported for ${caller} sessions.`)
    process.exitCode = 1
    return
  }
  const found = able.map(adapter => ({ adapter, sessions: sessionsWithChildren(adapter, cwd) })).filter(h => h.sessions.length)
  if (!found.length) {
    console.log('No sub-agents in this project\'s sessions.')
    return
  }
  if (!query) {
    const { sessions } = found[0]!
    printList(sessions[0]!)
    return
  }
  for (const { adapter, sessions } of found) {
    const hits = matchChildren(sessions, query)
    if (!hits.length) continue
    if (hits.length > 1) {
      console.error(`Several agents match "${query}"; name one by its id:`)
      for (const c of hits) console.error(`  ${row(c)}`)
      process.exitCode = 1
      return
    }
    const { text, error } = await childReport(adapter, cwd, hits[0]!)
    console.log(text)
    if (error) console.error(`\n(partly unjudged: ${error})`)
    return
  }
  console.error(`No agent matches "${query}". Run \`typebulb status\` to list them.`)
  process.exitCode = 1
}

// One agent per line, oldest first, a nested agent indented under the one that spawned it.
function printList(s: SessionChildren) {
  const kids = [...s.children].sort((a, b) => a.mtime - b.mtime)
  console.log(`Sub-agents of session ${s.sessionId}:`)
  for (const c of kids) console.log(`  ${'  '.repeat(Math.max(0, c.depth - 1))}${row(c)}`)
  console.log('\nRun `typebulb status <id>` for one agent\'s report.')
}

const row = (c: ChildRow) => {
  const ran = c.started ? formatDuration((c.state === 'running' ? Date.now() : c.mtime) - c.started) : ''
  const state = c.failing && c.state !== 'stopped' ? 'failing' : c.state
  return `${c.id}  ${state.padEnd(7)}  ${ran.padStart(6)}  ${childName(c)}`
}
