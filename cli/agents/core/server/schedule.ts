import type { AgentAdapter } from './adapter.js'
import { sessionPlanFacts } from './tagIndex.js'
import { childSchedule, readOutput, type ChildPlanFacts } from './childReport.js'
import { childDigest, laneRuns } from '../childStatus.js'
import { childName, childShownState, type ChildRow } from '../events.js'
import { contextFacts, type AgentFact, type ScheduleFacts } from '../plan.js'

// The schedule's server half (TB-Agent-Schedule.md): the session's plans and context from its own
// transcript, its agents from the child rows, and the checks lane from every shell call, the
// session's own and its children's. No model call; the projection is the caller's, at its own now.

const LANE_WINDOW_MS = 12 * 60 * 60_000
const MAX_POINTS = 400

// `started` is its latest run's: a resumed agent's bar runs from the follow-up, not the first spawn.
const agentFact = (c: ChildRow, f: ChildPlanFacts = {}): AgentFact =>
  ({ id: c.id, name: childName(c), state: childShownState(c), started: f.runStart ?? c.started, ended: c.state === 'running' ? undefined : c.mtime, boxMs: f.boxMs, todos: f.todos })

// Every point is measured; only a few hundred are drawn.
const thin = <T>(xs: T[]) => xs.length <= MAX_POINTS ? xs : xs.filter((_, i) => i % Math.ceil(xs.length / MAX_POINTS) === 0 || i === xs.length - 1)

export function sessionSchedule<E>(adapter: AgentAdapter<E>, cwd: string, file: string | undefined, rows: ChildRow[], live: boolean, now: number): ScheduleFacts {
  const f = sessionPlanFacts(adapter, file)
  const kids = childSchedule(adapter, cwd, rows, live, now)
  const agents = rows.map(c => agentFact(c, kids.facts.get(c.id)))
  const own = laneRuns(childDigest(f.calls).calls, now, live, live, readOutput).map(r => ({ ...r, who: 'orchestrator' }))
  const lanes = [...own, ...kids.lanes]
    .filter(r => (r.end ?? now) >= now - LANE_WINDOW_MS).sort((x, y) => x.at - y.at)
  const context = contextFacts(f.points, agents)
  return { plans: f.plans, agents, context: { ...context, points: thin(context.points) }, lanes }
}
