import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { cpus, freemem, totalmem } from 'os'
import { typebulbHome } from '../../../src/servers.js'
import type { MachineFacts } from '../plan.js'

// The machine's load for the schedule (TB-Agent-Schedule.md): CPU and memory in use, sampled while a
// mirror runs. The whole machine's, not any task's. Kept in one file per machine, so a restart keeps
// the history; every mirror running appends to it.

const EVERY_MS = 10_000
const WINDOW_MS = 12 * 60 * 60_000
const MAX_POINTS = 400
// Two mirrors sample the same machine; on loading, samples closer than this are one.
const SAME_MS = EVERY_MS / 2

type Sample = MachineFacts['samples'][number]
const file = () => join(typebulbHome(), 'machine.jsonl')
let samples: Sample[] = []
let last: { at: number; idle: number; total: number } | undefined
let timer: ReturnType<typeof setInterval> | undefined

// The file's last window, merged. A home that can't be read leaves the history to this run.
function readSamples(now: number): Sample[] {
  let lines: string[] = []
  try { lines = readFileSync(file(), 'utf8').split('\n') } catch {}
  const read = lines.flatMap(l => { try { return [JSON.parse(l) as Sample] } catch { return [] } })
    .filter(s => s.at >= now - WINDOW_MS && s.to > s.at).sort((a, b) => a.at - b.at)
  return read.filter((s, i) => i === 0 || s.at - read[i - 1]!.at >= SAME_MS)
}

// Rewritten on load, so the file doesn't grow past the window.
function load(now: number) {
  samples = readSamples(now)
  try { mkdirSync(typebulbHome(), { recursive: true }); writeFileSync(file(), samples.map(s => JSON.stringify(s) + '\n').join('')) } catch {}
}

// Each sample is the share of CPU busy since the one before, from that one to now.
function sample() {
  const at = Date.now()
  const t = cpus().reduce((n, c) => ({ idle: n.idle + c.times.idle, total: n.total + c.times.user + c.times.nice + c.times.sys + c.times.irq + c.times.idle }), { idle: 0, total: 0 })
  if (last && t.total > last.total) {
    const s = { at: last.at, to: at, cpu: 1 - (t.idle - last.idle) / (t.total - last.total), mem: 1 - freemem() / totalmem() }
    samples.push(s)
    try { appendFileSync(file(), JSON.stringify(s) + '\n') } catch {}
  }
  last = { at, ...t }
  while (samples.length && samples[0]!.at < at - WINDOW_MS) samples.shift()
}

export function startMachineSampler() {
  if (timer) return
  load(Date.now())
  sample()
  timer = setInterval(sample, EVERY_MS)
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
  const recent = readSamples(now).filter(s => s.to >= now - 30 * 60_000)
  const latest = recent.at(-1)
  if (!latest || latest.to < now - 60_000) return ''
  const gb = (share: number) => Math.round(share * totalmem() / 2 ** 30)
  return `Machine: CPU ${Math.round(latest.cpu * 100)}% now, peak ${Math.round(Math.max(...recent.map(s => s.cpu)) * 100)}% in the last 30 min; memory ${gb(latest.mem)} of ${gb(1)} GB.`
}
