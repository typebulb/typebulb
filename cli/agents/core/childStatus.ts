// A child's Status (TB-Agent-Children.md), the logic without the view: the digest of its transcript
// the status call reads, the rows and facts built from the calls' answers, the files it edited, and
// the plain text the orchestrating agent reads. Pure and harness-neutral, so the mirror's Status view
// and `typebulb status` build one report from one code path.
import type { Event } from './events.js'
import { asStr, basename, displayPath, formatDuration as mins, toolSummary, toolDisplayName } from './format.js'

const RECENT = 30              // the newest steps keep full detail; "where it is now" lives there
const LONG_STEP_MS = 3 * 60_000
const IDLE_MIN_MS = 60_000     // a quiet stretch before a wake shorter than this is thinking, not idle
const EXPLORE = new Set(['Read', 'Grep', 'Glob'])
// A command that runs a test suite: the last one's result is the child's red or green.
const TEST_CMD = /\b(vitest|jest|pytest|mocha|playwright test|go test|cargo test|dotnet test|(?:npm|pnpm|yarn|bun)(?: run)? test)\b/

export interface Plan { request: string; subtasks: string[] }
export interface Row { id: number; status: string; did: string; note: string; steps: [number, number?][]; evidence: [number, number?][] }
interface OffRow { what: string; note: string; steps: [number, number?][] }
export interface Status { now: string; decision: string; rows: Row[]; offBrief: OffRow[] }
// A status as judged: its payload's key, and how many steps and parent follow-ups it saw. Fewer
// follow-ups than the transcript holds means the parent has spoken since, and what it said before
// may already be answered.
export interface Judged { key: string; data: Status; steps: number; followups: number; at: number }
// The last test run: red when it failed, green when its counts say so, unknown when it said nothing.
// `ms` is how long the call took, call to result: the whole command, startup and all.
export interface TestRun { n: number; state: 'red' | 'green' | 'unknown'; line: string; ms?: number }
// The transcript as the digest reads it: the mirror's own messages satisfy this, and `msgsOf` builds
// it from the event stream where no mirror is running.
export interface StatusTool { id: string; name: string; input: Record<string, unknown>; result?: string; isError: boolean; digest?: string; at?: number; doneAt?: number }
export interface StatusMsg { role: 'user' | 'assistant' | 'fork'; text: string; tools: StatusTool[]; agent?: { from: string }; at?: number }
// `parts` are the step's stretches on the child's active timeline; `wall` their total.
export interface Step { n: number; tool: StatusTool; wall: number; parts: Span[] }
// One line of the table, computed once and read by both the table and the copy text.
export type Line =
  | { kind: 'group'; request: string; idx: number }
  | { kind: 'row'; num?: number; title: string; status: string; did: string; note: string; steps: [number, number?][]; cite: [number, number?][]; ms: number; spans: Span[] }
// A stretch on the child's timeline, in ms of ACTIVE time from its brief: idle waits for a wake are cut.
export interface Span { from: number; to: number }
export type Digest = ReturnType<typeof childDigest>
// A file the child changed: by an edit tool, or deleted or renamed through git.
export interface Edited { path: string; deleted?: boolean; from?: string }
export type Fact = [label: string, value: string, cls?: string]

const clip = (s: string, n: number) => { s = s.replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s }
const abridge = (s: string, n: number) => s.length <= n ? s : s.slice(0, n / 2) + '\n[…]\n' + s.slice(-n / 2)
const firstLine = (s: string) => s.split('\n').find(l => l.trim()) ?? ''
// Shell preamble that says nothing about the step.
const stripBoiler = (s: string) => s.replace(/^(\s*(cd\s+\S+|export\s+PATH=\S+)\s*(;|&&)\s*)+/, '')
// "Bash: node build.mjs", the step as the log and the counted facts both name it.
const stepLabel = (t: StatusTool, n: number) => `${toolDisplayName(t.name)}: ${clip(stripBoiler(toolSummary(t.input)), n)}`
export const statusLabel = (status: string) => status === 'off' ? 'off brief' : status.replace('_', ' ')
export const inRanges = (n: number, ranges: [number, number?][]) => ranges.some(([a, b]) => n >= a && n <= (b ?? a))
const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
// A child whose brief never reaches its transcript in the clear (Codex encrypts it): nothing to plan,
// so no calls, and the report keeps only what is counted.
export const NO_BRIEF = 'No readable brief on record, so no subtasks to judge.'

/** The event stream as the digest's messages: the mirror's own reduction (consecutive sends fold into
 *  one, a hand-back stays its own turn), for a report built where no mirror page is open. */
export function msgsOf(events: Event[]): StatusMsg[] {
  const out: StatusMsg[] = []
  for (const e of events) {
    if (e.type === 'cleared') out.length = 0
    else if (e.type === 'user') {
      const prev = out.at(-1)
      if (prev?.role === 'user' && !e.agent && !prev.agent) prev.text += '\n\n' + e.text
      else out.push({ role: 'user', text: e.text, tools: [], agent: e.agent, at: e.at })
    } else if (e.type === 'assistant') {
      out.push({ role: 'assistant', text: e.text, tools: e.tools.map(t => ({ ...t, isError: false, at: e.at })), at: e.at })
    } else if (e.type === 'tool_result') {
      const t = out.flatMap(m => m.tools).find(x => x.id === e.id)
      if (t) { t.result = e.content; t.isError = e.isError; t.digest = e.digest; t.doneAt = e.at }
    }
  }
  return out
}

/** The child's messages from its parent and its work, digested for the status call. Pure, and a
 *  function of the transcript alone: time runs to its last entry, never to the clock, so the same
 *  transcript always digests to the same payload and a cached status still fits it. */
export function childDigest(msgs: StatusMsg[]) {
  let brief = ''
  const followups: string[] = []
  const steps: Step[] = []
  const lines: string[] = []
  const say: { after: number; line: string }[] = []
  let end = 0
  for (const m of msgs) {
    end = Math.max(end, m.at ?? 0, ...m.tools.map(t => t.doneAt ?? t.at ?? 0))
    if (m.role === 'fork') continue
    if (m.role === 'user') {
      if (m.agent) { say.push({ after: steps.length, line: 'REPORT FROM ITS OWN SUB-AGENT: ' + abridge(m.text, 1500) }); continue }
      if (!brief) { brief = m.text; continue }
      followups.push(m.text)
      say.push({ after: steps.length, line: `FOLLOW-UP FROM PARENT: ${abridge(m.text, 1500)}` })
      continue
    }
    if (m.text) say.push({ after: steps.length, line: 'AGENT SAYS: ' + abridge(m.text, 1500) })
    for (const t of m.tools) {
      steps.push({ n: steps.length + 1, tool: t, wall: 0, parts: [] })
      // A long `message` input is the agent talking (a hand-back, a send): where a report lives.
      const message = t.input?.message
      if (typeof message === 'string' && message.length > 200)
        say.push({ after: steps.length, line: `AGENT SENDS (${toolDisplayName(t.name)}): ${abridge(message, 8000)}` })
    }
  }
  const tail = end
  const time = childTimeline(msgs, steps, tail)
  // The last message whole: a final report is the densest line in the log.
  const last = say.at(-1)
  if (last && /^AGENT SAYS/.test(last.line)) {
    const m = [...msgs].reverse().find(x => x.role === 'assistant' && x.text)
    if (m) last.line = 'AGENT SAYS: ' + abridge(m.text, 8000)
  }

  const sayAt = new Map<number, string[]>()
  for (const s of say) sayAt.set(s.after, [...(sayAt.get(s.after) ?? []), s.line])
  lines.push(...sayAt.get(0) ?? [])
  const cutoff = steps.length - RECENT
  for (let i = 0; i < steps.length;) {
    const s = steps[i]!
    // A run of 3+ clean reads and searches is one line: exploration rarely carries progress.
    if (s.n <= cutoff && EXPLORE.has(s.tool.name) && !s.tool.isError) {
      let j = i
      while (j < steps.length && steps[j]!.n <= cutoff && EXPLORE.has(steps[j]!.tool.name) && !steps[j]!.tool.isError
        && (j === i || !sayAt.has(steps[j - 1]!.n))) j++
      if (j - i >= 3) {
        const names = [...new Set(steps.slice(i, j).map(x => basename(toolSummary(x.tool.input))))]
        lines.push(`[${s.n}-${steps[j - 1]!.n}] explored ${j - i} files/searches: ${clip(names.join(', '), 160)}`)
        lines.push(...sayAt.get(steps[j - 1]!.n) ?? [])
        i = j
        continue
      }
    }
    const recent = s.n > cutoff
    const t = s.tool
    const out = t.result === undefined ? '(running)'
      : t.isError ? 'ERROR: ' + clip(firstLine(t.result), 160)
      : clip(t.digest ?? '', recent ? 120 : 60) || 'ok'
    lines.push(`[${s.n}] ${stepLabel(t, recent ? 160 : 80)} → ${out}`)
    lines.push(...sayAt.get(s.n) ?? [])
    i++
  }
  return {
    brief, followups, steps, log: lines.join('\n'), facts: countedFacts(steps),
    span: time.span, idle: time.idle, wakes: time.wakes, tests: lastTestRun(steps), lastAt: end,
  }
}

// The most recent finished test run. Its counts line decides green; a failure exit or a nonzero
// "failed" decides red; a run whose output was filtered down to nothing says only that it ran.
function lastTestRun(steps: Step[]): TestRun | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const t = steps[i]!.tool
    const cmd = asStr(t.input?.command) ?? asStr(t.input?.cmd)
    if (!cmd || !TEST_CMD.test(cmd) || t.result === undefined) continue
    // The runner's own label ("Tests  213 passed") is dropped: the header already says Tests.
    const counts = (t.result.replace(/\x1b\[[0-9;]*m/g, '').split('\n').filter(l => /\b\d+\s+(passed|failed)\b/i.test(l)).at(-1) ?? '')
      .trim().replace(/^tests?:?\s+/i, '')
    const state = t.isError || /\b[1-9]\d*\s+failed\b/i.test(counts) ? 'red' : /\bpassed\b/i.test(counts) ? 'green' : 'unknown'
    const ms = t.at !== undefined && t.doneAt !== undefined ? t.doneAt - t.at : undefined
    return { n: steps[i]!.n, state, line: clip(counts, 90), ms }
  }
  return undefined
}

// Where the child's time went. A child is often woken again after it finishes (a follow-up, its own
// background task ending, a sub-agent's report): each lands as a user turn, and the wait before it is
// idle, not work. So the timeline runs in ACTIVE time, those waits cut out, with the wakes kept as
// marks. A step owns the thinking that led to its call plus the call's run; work written just before
// a wait (a final report) stays with the step before it. Fills each step's `parts` and `wall`.
function childTimeline(msgs: StatusMsg[], steps: Step[], tail: number) {
  const tools = msgs.flatMap(m => m.tools)
  const activity: number[] = []
  const wakes: number[] = []
  let origin: number | undefined
  for (const m of msgs) {
    if (m.role === 'fork') continue
    if (m.role === 'user') {
      if (origin === undefined && !m.agent) origin = m.at
      else if (m.at) wakes.push(m.at)
      continue
    }
    if (m.at) activity.push(m.at)
    for (const t of m.tools) { if (t.at) activity.push(t.at); if (t.doneAt) activity.push(t.doneAt) }
  }
  const start = origin ?? steps[0]?.tool.at ?? tail
  // Idle: from the last activity before a wake to the wake, unless a tool call was still running
  // across it (a message can arrive mid-build) or the quiet was too short to be anything but thought.
  const gaps: [number, number][] = []
  for (const w of wakes) {
    let last = -Infinity
    for (const t of activity) if (t <= w && t > last) last = t
    const running = tools.some(t => t.at !== undefined && t.at < w && (t.doneAt ?? Infinity) > w)
    if (last > -Infinity && !running && w - last >= IDLE_MIN_MS) gaps.push([last, w])
  }
  const idleBefore = (t: number) => gaps.reduce((n, [g0, g1]) => n + Math.max(0, Math.min(t, g1) - g0), 0)
  const act = (t: number) => Math.max(0, t - start - idleBefore(t))
  // Each step's real interval: from the previous call's end to its own end, kept monotonic because
  // parallel calls in one message share a start.
  const bounds: number[] = []
  steps.forEach((s, i) => {
    const prev = steps[i - 1]?.tool
    const b = i === 0 ? start : (prev?.doneAt ?? prev?.at ?? start)
    bounds.push(Math.min(tail, Math.max(bounds[i - 1] ?? start, b)))
  })
  steps.forEach((s, i) => {
    const x = bounds[i]!, y = bounds[i + 1] ?? tail
    let cursor = x
    let first = true
    for (const [g0, g1] of gaps) {
      if (g1 <= x || g0 >= y) continue
      // The stretch before this step's first wait is the previous step's closing work.
      const target = first && i > 0 ? steps[i - 1]! : s
      if (g0 > cursor) target.parts.push({ from: act(cursor), to: act(g0) })
      cursor = Math.max(cursor, g1)
      first = false
    }
    if (y > cursor) s.parts.push({ from: act(cursor), to: act(y) })
  })
  for (const s of steps) s.wall = s.parts.reduce((n, p) => n + p.to - p.from, 0)
  return { span: act(tail), idle: idleBefore(tail), wakes: wakes.filter(w => w > start && w < tail).map(act) }
}

// What the status call should not have to infer: failures, repeats, long waits. Counted, so an
// orange note rests on numbers rather than on the cheap model's impression of a long log.
function countedFacts(steps: Step[]): string {
  const facts: string[] = []
  const failed = steps.filter(s => s.tool.isError)
  if (failed.length) facts.push(`${failed.length} of ${steps.length} steps failed.`)
  const byCmd = new Map<string, number[]>()
  for (const s of failed) {
    const k = stepLabel(s.tool, 60)
    byCmd.set(k, [...(byCmd.get(k) ?? []), s.n])
  }
  for (const [k, ns] of byCmd) if (ns.length > 1) facts.push(`${k} failed ${ns.length} times (steps ${ns.join(', ')}).`)
  const recent = steps.slice(-20).filter(s => s.tool.isError).length
  if (recent >= 4) facts.push(`${recent} of the last 20 steps failed.`)
  for (const s of steps) if (s.wall >= LONG_STEP_MS)
    facts.push(`Step ${s.n} (${stepLabel(s.tool, 60)}) took ${mins(s.wall)}.`)
  const total = steps.reduce((n, s) => n + s.wall, 0)
  if (total) facts.push(`${mins(total)} in all over ${steps.length} steps.`)
  return facts.join('\n')
}

/** The status call for the transcript as it stands, once every parent message is planned (the rows
 *  come from every plan). Undefined until then. Its key is a hash of the payload, computed alike in
 *  the browser and on the server, so a status either one judged fits the other. */
export function statusJob(d: Digest, plans: Map<string, Plan>, finished: boolean) {
  const all = [d.brief, ...d.followups].map(t => plans.get(t))
  if (all.some(p => !p)) return undefined
  const payload = { subtasks: all.flatMap(p => p!.subtasks), log: d.log, facts: d.facts, finished }
  return { key: hashText(JSON.stringify(payload)), payload, steps: d.steps.length, followups: d.followups.length }
}

// cyrb53: a fast 53-bit string hash, synchronous in the browser where SubtleCrypto is not. A key,
// not a secret.
function hashText(s: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

/** Every parent message's subtasks in order (a follow-up under its own header), then off-brief work,
 *  then their time: every step gets exactly one owner, so the timeline partitions the whole run. A
 *  row that reaches done is frozen by its subtask, so a later call's variance can't regress or reword
 *  it while it is read. */
export function statusLines(d: Digest, plans: Map<string, Plan>, status: Status | undefined, frozen: Map<string, Row>): Line[] {
  const out: Line[] = []
  let id = 0
  ;[d.brief, ...d.followups].forEach((text, mi) => {
    const plan = plans.get(text)
    if (mi > 0) out.push({ kind: 'group', request: plan?.request ?? '', idx: mi })
    for (const title of plan?.subtasks ?? []) {
      id++
      const frozenKey = d.brief + '\n' + title
      let row = status?.rows.find(r => r.id === id)
      if (row?.status === 'done' && !frozen.has(frozenKey)) frozen.set(frozenKey, row)
      row = frozen.get(frozenKey) ?? row
      const steps = row?.steps ?? []
      out.push({ kind: 'row', num: id, title, status: row?.status ?? '', did: row?.did ?? '', note: row?.note ?? '', steps, cite: row?.evidence?.length ? row.evidence : steps, ms: 0, spans: [] })
    }
  })
  for (const o of status?.offBrief ?? [])
    out.push({ kind: 'row', title: o.what, status: 'off', did: '', note: o.note, steps: o.steps, cite: o.steps, ms: 0, spans: [] })
  placeTime(out, d)
  return out
}

// Each step's owner is the first row that cites it. A step no row cites carries forward from the
// step before it (the agent is still on that task until the log shows it move), and steps before the
// first citation go to the first cited row. An assumption, but it makes the bars add up to the run.
function placeTime(lines: Line[], d: Digest) {
  const rows = lines.filter((l): l is Extract<Line, { kind: 'row' }> => l.kind === 'row')
  const owner: (typeof rows[number] | undefined)[] = d.steps.map(s => rows.find(r => inRanges(s.n, r.steps)))
  const firstOwned = owner.find(Boolean)
  if (!firstOwned) return
  let carry = firstOwned
  for (let i = 0; i < owner.length; i++) owner[i] = carry = owner[i] ?? carry
  d.steps.forEach((s, i) => {
    const r = owner[i]!
    r.ms += s.wall
    for (const p of s.parts) {
      const last = r.spans.at(-1)
      // Touching stretches of one row draw as one segment.
      if (last && Math.abs(last.to - p.from) < 1000) last.to = Math.max(last.to, p.to)
      else r.spans.push({ ...p })
    }
  })
}

/** The closing facts, in the order a delegator acts on them. Tests are counted from the transcript;
 *  the finding and the decision are the status call's, and only while that call has judged the
 *  parent's latest message: after it, what it said may already be answered, and a stale "needs a
 *  decision" invites deciding twice. Until then Now names the follow-up being worked on, from its
 *  plan. A slot with nothing to say is left out. */
export function statusFacts(d: Digest, judged: Judged | null | undefined, plans: Map<string, Plan>, busy: boolean): Fact[] {
  const t = d.tests
  const current = judged && judged.followups === d.followups.length
  const latest = d.followups.length ? plans.get(d.followups.at(-1)!)?.request : undefined
  const now = current ? judged.data.now
    : latest ? `Working on the latest follow-up: ${latest}`
    : busy ? '…' : ''
  return ([
    ['Now', now],
    ['Tests', t ? `${t.state}${t.line ? `, ${t.line}` : ''}${t.ms !== undefined ? `, took ${mins(t.ms)}` : ''} (step ${t.n})` : '', t ? `tests-${t.state}` : undefined],
    ['Needs a decision', current ? judged.data.decision : '', 'warn'],
  ] as Fact[]).filter(([, v]) => v)
}

// Input fields that carry what an edit tool writes. With a path field beside one, the call wrote
// that file: Write, Edit, MultiEdit, NotebookEdit, and patcher tools, named by shape, not by tool.
const WRITE_FIELDS = ['content', 'diff', 'new_string', 'new_source', 'edits']

/** The files the child changed, in the order it first touched them: every successful edit-tool call,
 *  every file a patch's headers name, and what `git rm` and `git mv` delete or move. A write a script
 *  makes is not seen (TB-Agent-Children.md measures how much that misses). Paths outside the project
 *  are dropped, the rest shown relative to it. */
export function editedFiles(d: Digest, cwd: string): Edited[] {
  const out = new Map<string, Edited>()
  const rel = (p: string) => {
    const n = p.trim().replace(/^["']|["']$/g, '').replace(/\\/g, '/').replace(/^\/([a-zA-Z])\//, '$1:/')
    const r = displayPath(n, cwd).replace(/^\.\//, '')
    return !r || /^([a-zA-Z]:)?\//.test(r) ? undefined : r
  }
  const touch = (p: string, how: Omit<Edited, 'path'> = {}) => {
    const path = rel(p)
    if (!path) return
    const e = out.get(path) ?? { path }
    e.deleted = how.deleted
    if (how.from) e.from = how.from
    out.set(path, e)
  }
  const move = (from: string, to: string) => {
    const was = rel(from)
    const prior = was ? out.get(was) : undefined
    if (was) out.delete(was)
    touch(to, { from: prior?.from ?? was })
  }
  for (const { tool: t } of d.steps) {
    if (t.isError) continue
    const i = t.input ?? {}
    // A patch names its own files; a patcher's bare hunks leave that to the path field. A command is
    // not a patch, whatever its heredoc holds.
    let headed = false
    for (const [k, v] of Object.entries(i)) {
      if (k === 'command' || k === 'cmd' || typeof v !== 'string' || !/^(---|\+\+\+) /m.test(v)) continue
      let old: string | undefined
      for (const line of v.split('\n')) {
        const m = /^(---|\+\+\+) (?:[ab]\/)?(.+?)\s*$/.exec(line)
        if (m?.[1] === '---') { old = m[2]; continue }
        if (m?.[1] === '+++') {
          headed = true
          if (m[2] === '/dev/null') { if (old && old !== '/dev/null') touch(old, { deleted: true }) }
          else touch(m[2]!)
          continue
        }
        const mv = /^\*\*\* Move to: (.+?)\s*$/.exec(line)
        if (mv && old) move(old, mv[1]!)
      }
    }
    const path = asStr(i.file_path) ?? asStr(i.filePath) ?? asStr(i.path)
    if (!headed && path && WRITE_FIELDS.some(k => k in i)) touch(path)
    const cmd = asStr(i.command) ?? asStr(i.cmd)
    if (cmd) for (const g of gitMoves(cmd)) g.to ? move(g.from, g.to) : touch(g.from, { deleted: true })
  }
  return [...out.values()]
}

// `git rm` and `git mv` in a shell command, as deletes and moves. Their arguments are paths, so they
// read exactly, unlike a sed or a script. `--cached` untracks and leaves the file, so it is skipped.
function gitMoves(cmd: string): { from: string; to?: string }[] {
  const out: { from: string; to?: string }[] = []
  for (const part of cmd.split(/&&|\|\||[;|\n]/)) {
    const tokens: string[] = part.trim().match(/"[^"]*"|'[^']*'|\S+/g) ?? []
    const at = tokens.indexOf('git')
    const verb = tokens[at + 1]
    if (at < 0 || (verb !== 'rm' && verb !== 'mv') || tokens.includes('--cached')) continue
    const args = tokens.slice(at + 2).filter(a => !a.startsWith('-')).map(a => a.replace(/^["']|["']$/g, ''))
    if (verb === 'rm') { for (const a of args) out.push({ from: a }); continue }
    const to = args.pop()
    if (!to) continue
    for (const from of args) out.push({ from, to: args.length > 1 ? `${to.replace(/\/+$/, '')}/${basename(from)}` : to })
  }
  return out
}

/** The report as plain text for the orchestrating agent, in the view's order, stamped with the time
 *  of the last transcript entry it covers: each request and its rows, the closing facts, then the
 *  files it edited. No step numbers, which mean nothing outside the view. A running child also says
 *  how long it has been quiet, or how long its open call has run: slow and stuck read alike without. */
export function statusText(r: { d: Digest; lines: Line[]; facts: Fact[]; edited: Edited[]; plans: Map<string, Plan>; name: string; working: boolean; now: number }): string {
  const { d } = r
  const state = r.working ? `running, step ${d.steps.length}${quiet(d, r.now)}` : `finished after ${d.steps.length} steps`
  const out = [`Sub-agent "${r.name}": ${state}, ${mins(d.span)} active${d.lastAt ? `, as of ${clock(d.lastAt)}` : ''}.`]
  out.push('', `Request: ${d.brief ? r.plans.get(d.brief)?.request ?? '(not summarized yet)' : NO_BRIEF}`)
  for (const l of r.lines) {
    if (l.kind === 'group') { out.push('', `Follow-up: ${l.request}`); continue }
    const time = l.ms ? ` (${mins(l.ms)})` : ''
    out.push(`- ${l.title}: ${statusLabel(l.status || 'pending')}.${l.did ? ` ${l.did}` : ''}${time}`)
    if (l.note) out.push(`  Note: ${l.note}`)
  }
  if (r.facts.length) out.push('')
  for (const [label, value] of r.facts) out.push(`${label}: ${value}`)
  if (r.edited.length) out.push('', 'Edited:', ...r.edited.map(editedLine))
  return out.join('\n')
}

export const editedLine = (e: Edited) => e.deleted ? `${e.path} (deleted)` : e.from ? `${e.path} (moved from ${e.from})` : e.path

function quiet(d: Digest, now: number): string {
  const open = [...d.steps].reverse().find(s => s.tool.result === undefined && s.tool.at)
  if (open) return `, waiting ${mins(now - open.tool.at!)} on ${stepLabel(open.tool, 60)}`
  return d.lastAt ? `, last activity ${mins(now - d.lastAt)} ago` : ''
}

/** The model's JSON, shaped defensively: a missing field is empty, never a crash in the view. */
export function normalizeStatus(data: unknown): Status {
  const o = (data ?? {}) as Partial<Status>
  const ranges = (x: unknown) => Array.isArray(x)
    ? x.filter(Array.isArray).map(r => [Number(r[0]), r[1] === undefined ? undefined : Number(r[1])] as [number, number?]).filter(r => r[0] > 0)
    : []
  return {
    now: String(o.now ?? ''),
    decision: String(o.decision ?? ''),
    rows: (Array.isArray(o.rows) ? o.rows : []).map(r => ({ id: Number(r.id), status: String(r.status ?? ''), did: String(r.did ?? ''), note: String(r.note ?? ''), steps: ranges(r.steps), evidence: ranges(r.evidence) })),
    offBrief: (Array.isArray(o.offBrief) ? o.offBrief : []).map(r => ({ what: String(r.what ?? ''), note: String(r.note ?? ''), steps: ranges(r.steps) })),
  }
}

/** A plan call's JSON, shaped defensively like a status. A subtask is a title, so a trailing period
 *  the model adds goes: the row puts its own punctuation after it. */
export function normalizePlan(data: unknown): Plan {
  const p = data as Partial<Plan> | undefined
  return { request: String(p?.request ?? ''), subtasks: Array.isArray(p?.subtasks) ? p.subtasks.map(t => String(t).replace(/[.\s]+$/, '')) : [] }
}
