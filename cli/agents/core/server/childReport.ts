import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import { typebulbHome } from '../../../src/servers.js'
import type { AgentAdapter } from './adapter.js'
import { childStatusPart } from './summarize.js'
import { readTranscript, sessionLive, childState } from './transcript.js'
import { childName, type ChildRow } from '../events.js'
import { orderByDescending } from '../order.js'
import {
  msgsOf, childDigest, statusJob, statusLines, statusFacts, editedFiles, statusText, normalizePlan, normalizeStatus,
  type Plan, type Row, type Judged,
} from '../childStatus.js'

// `typebulb status` (TB-Agent-Children.md): a child's Status report printed for the orchestrating
// agent, the same text the mirror's Copy Status gives, built with no mirror page open. The calls are
// the view's and the licence is too: the command is the request, and nothing touches the transcript.

export interface SessionChildren { sessionId: string; children: ChildRow[] }

/** Every session's children, the caller's own session first, then the rest newest first: where a
 *  bare name is looked up, so an orchestrator finds its own agents before anyone else's. */
export function sessionsWithChildren<E>(adapter: AgentAdapter<E>, cwd: string): SessionChildren[] {
  if (!adapter.listChildren) return []
  const own = adapter.callerSessionId?.(cwd)
  const files = orderByDescending(adapter.listSessionFiles(cwd), f => f.mtime)
    .sort((a, b) => Number(b.sessionId === own) - Number(a.sessionId === own))
  const out: SessionChildren[] = []
  for (const f of files) {
    const kids = adapter.listChildren(cwd, f.sessionId)
    if (!kids.length) continue
    const live = sessionLive(adapter, f.sessionId, cwd, f.file)
    out.push({ sessionId: f.sessionId, children: kids.map(c => ({ ...c, state: childState(c, live) })) })
  }
  return out
}

/** The children a query names, from the first session with any: an exact id, an id prefix, or a
 *  case-insensitive piece of the description. */
export function matchChildren(sessions: SessionChildren[], query: string): ChildRow[] {
  const q = query.trim().toLowerCase()
  for (const s of sessions) {
    const exact = s.children.filter(c => c.id.toLowerCase() === q)
    if (exact.length) return exact
    const hits = s.children.filter(c => c.id.toLowerCase().startsWith(q) || childName(c).toLowerCase().includes(q))
    if (hits.length) return hits
  }
  return []
}

// What a report keeps between runs, per child: its plans by message, its done rows, and its last
// status by payload key. An idle child asked about twice costs no call the second time.
interface Cache { plans: Record<string, Plan>; frozen: Record<string, Row>; status?: Judged }
const hash = (s: string) => createHash('sha1').update(s).digest('hex')

/** A child judged: its digest, every parent message planned, and a status for the transcript as it
 *  stands, making whatever calls the cache lacks. `error` is why part of it could not be judged
 *  (`setup` when no cheap-model key is set); everything counted without a model is still there.
 *  `cached` when the cache answered it all, without a call. */
export async function judgeChild<E>(adapter: AgentAdapter<E>, child: ChildRow) {
  const d = childDigest(msgsOf(readTranscript(adapter, child.file, 'child')))
  const cacheFile = join(typebulbHome(), 'cache', 'child-status', `${hash(child.file)}.json`)
  let cache: Cache = { plans: {}, frozen: {} }
  try { cache = { ...cache, ...JSON.parse(readFileSync(cacheFile, 'utf8')) } } catch {}
  const plans = new Map(Object.entries(cache.plans))
  const frozen = new Map(Object.entries(cache.frozen))
  let error: string | undefined
  let setup = false
  const fail = (r: { error: string; setup?: true }) => { error ??= r.error; setup ||= !!r.setup }

  const missing = [d.brief, ...d.followups].filter(t => t && !plans.has(t))
  for (const [text, r] of await Promise.all(missing.map(async t => [t, await childStatusPart('plan', t)] as const))) {
    if (r.ok) plans.set(text, normalizePlan(r.data))
    else fail(r)
  }
  let judged = cache.status
  const job = d.brief ? statusJob(d, plans, child.state !== 'running') : undefined
  const stale = !!job && judged?.key !== job.key
  if (job && stale) {
    const r = await childStatusPart('status', job.payload)
    if (r.ok) judged = { key: job.key, data: normalizeStatus(r.data), steps: job.steps, followups: job.followups, at: Date.now() }
    else fail(r)
  }
  // Building the rows is what freezes the ones now done.
  statusLines(d, plans, judged?.data, frozen)
  try {
    mkdirSync(join(cacheFile, '..'), { recursive: true })
    writeFileSync(cacheFile, JSON.stringify({ plans: Object.fromEntries(plans), frozen: Object.fromEntries(frozen), status: judged }))
  } catch {}
  return { d, plans, frozen, judged, error, setup, cached: !missing.length && !stale }
}

/** One child's report as text, for `typebulb status`. */
export async function childReport<E>(adapter: AgentAdapter<E>, cwd: string, child: ChildRow): Promise<{ text: string; error?: string }> {
  const { d, plans, frozen, judged, error } = await judgeChild(adapter, child)
  const text = statusText({
    d, lines: statusLines(d, plans, judged?.data, frozen), facts: statusFacts(d, judged, plans, false),
    edited: editedFiles(d, cwd), plans, name: childName(child), working: child.state === 'running', now: Date.now(),
  })
  return { text, error }
}
