import { cpus, freemem, totalmem } from 'os'
import type { MachineFacts } from '../plan.js'
import { windowFile } from './history.js'

// The machine's load (TB-Agent-Schedule.md, TB-Agent-Babysit.md): CPU and memory in use, the whole
// machine's, not any task's. Sampled while a mirror runs and kept in one file per machine, so a restart
// keeps the history; babysit reads the figures itself for its alarm.

const EVERY_MS = 10_000
const WINDOW_MS = 12 * 60 * 60_000
const MAX_POINTS = 400
// Two mirrors sample the same machine; on loading, samples closer than this are one.
const SAME_MS = EVERY_MS / 2
// The alarm: past ALARM for ALARM_MS fires; it lasts until below ALARM_CLEAR.
const ALARM = 0.9
const ALARM_CLEAR = 0.8
const ALARM_MS = 60_000

type Sample = MachineFacts['samples'][number]
export type LoadKind = 'cpu' | 'mem'
const KINDS: LoadKind[] = ['cpu', 'mem']
const history = windowFile<Sample>('machine.jsonl', WINDOW_MS)
const gb = (share: number) => Math.round(share * totalmem() / 2 ** 30)
const pct = (v: number) => `${Math.round(v * 100)}%`

/** The machine's CPU busy since the last reading and its memory in use, as shares of the whole. */
function loadMeter(): () => Record<LoadKind, number> {
  const times = () => cpus().reduce((n, c) => ({ idle: n.idle + c.times.idle, total: n.total + c.times.user + c.times.nice + c.times.sys + c.times.irq + c.times.idle }), { idle: 0, total: 0 })
  let last = times()
  return () => {
    const t = times(), cpu = t.total > last.total ? 1 - (t.idle - last.idle) / (t.total - last.total) : 0
    last = t
    return { cpu, mem: 1 - freemem() / totalmem() }
  }
}

// Samples from the file, merged across mirrors, oldest first.
function merged(rows: Sample[]): Sample[] {
  const sorted = rows.filter(s => s.to > s.at).sort((a, b) => a.at - b.at)
  return sorted.filter((s, i) => i === 0 || s.at - sorted[i - 1]!.at >= SAME_MS)
}

let samples: Sample[] = []
let timer: ReturnType<typeof setInterval> | undefined

export function startMachineSampler() {
  if (timer) return
  samples = merged(history.load(Date.now()))
  const meter = loadMeter()
  let at = Date.now()
  // Each sample spans the time since the one before.
  timer = setInterval(() => {
    const to = Date.now(), s = { at, to, ...meter() }
    samples.push(s)
    history.append([s])
    while (samples.length && samples[0]!.at < to - WINDOW_MS) samples.shift()
    at = to
  }, EVERY_MS)
  timer.unref()
}

/** A few hundred points, each the peak of the samples it stands for, so a spike survives the thinning.
 *  A gap (no mirror running) stays a gap: a point never spans one. */
export function machineFacts(): MachineFacts {
  const k = Math.ceil(samples.length / MAX_POINTS)
  const out: (Sample & { n: number })[] = []
  for (const s of samples) {
    const p = out.at(-1)
    if (p && p.n < k && s.at - p.to < SAME_MS) Object.assign(p, { to: s.to, cpu: Math.max(p.cpu, s.cpu), mem: Math.max(p.mem, s.mem), n: p.n + 1 })
    else out.push({ ...s, n: 1 })
  }
  return { samples: out.map(({ at, to, cpu, mem }) => ({ at, to, cpu, mem })), memTotal: totalmem() }
}

/** The machine's load as `typebulb status` states it, from the file: '' while no mirror samples it. */
export function machineLine(now: number): string {
  const recent = merged(history.read(now)).filter(s => s.to >= now - 30 * 60_000)
  const latest = recent.at(-1)
  if (!latest || latest.to < now - 60_000) return ''
  return `Load: CPU ${pct(latest.cpu)} now, peak ${pct(Math.max(...recent.map(s => s.cpu)))} in the last 30 min; memory ${gb(latest.mem)} of ${gb(1)} GB.`
}

/** Babysit's machine alarm, read at each poll: which kinds fire, which have not yet cleared, and a
 *  firing kind's line, finished by what the caller knows of the processes behind it. */
export function machineAlarm() {
  const meter = loadMeter()
  const hot: Record<LoadKind, number | undefined> = { cpu: undefined, mem: undefined }
  return (now: number) => {
    const level = meter()
    for (const k of KINDS) hot[k] = level[k] >= ALARM ? hot[k] ?? now : undefined
    return {
      firing: KINDS.filter(k => hot[k] !== undefined && now - hot[k]! >= ALARM_MS),
      held: (k: LoadKind) => level[k] >= ALARM_CLEAR,
      line: (k: LoadKind, behind: string) => `Machine: ${k === 'mem' ? `memory ${gb(level.mem)} of ${gb(1)} GB (${pct(level.mem)})` : `CPU ${pct(level.cpu)}`}`
        + ` for ${Math.max(1, Math.round((now - hot[k]!) / 60_000))} min. ${behind}`,
    }
  }
}
