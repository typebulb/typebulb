import { execFile } from 'child_process'
import { realpathSync } from 'fs'
import { cpus } from 'os'
import { clock } from '../childStatus.js'
import { HEAVY_CPU, HEAVY_MB, sizeText, type ProcessRun } from '../plan.js'
import { windowFile } from './history.js'
import { plural } from './text.js'

// The project's heavy processes for the schedule and `typebulb status` (TB-Agent-Schedule.md): every
// process whose command line names the project's folder, which catches what a runner or an engine
// starts on its own, out of every transcript's sight. Heavy: past HEAVY_MB or HEAVY_CPU of the machine.

const EVERY_MS = 30_000
const WINDOW_MS = 12 * 60 * 60_000
// ps dates a process from its elapsed time, which wobbles by a second between samples.
const SAME_START_MS = 5_000
// A process's usage graph draws at most this many points, each the peak of those it stands for.
const MAX_POINTS = 120

interface Proc { pid: number; start: number; mb: number; cpuMs: number; cmd: string }
// One sighting of a process that has been heavy, as the history file keeps it: every project a mirror
// watches, in one file. Once heavy, a process is followed for the rest of its life, so its graph runs on.
interface Seen { root: string; pid: number; start: number; at: number; mb: number; cpu: number; cmd: string; heavy?: boolean }

const run = (file: string, args: string[]) => new Promise<string>(resolve =>
  execFile(file, args, { windowsHide: true, maxBuffer: 64 << 20, timeout: 20_000 }, (err, out) => resolve(err ? '' : out)))

const PS = "Get-CimInstance Win32_Process | Where-Object CommandLine | ForEach-Object { [pscustomobject]@{ p = $_.ProcessId; "
  + "s = [long]($_.CreationDate.ToUniversalTime() - [datetime]'1970-01-01').TotalMilliseconds; m = [long]$_.WorkingSetSize; "
  + "c = [long]($_.UserModeTime + $_.KernelModeTime); a = $_.CommandLine } } | ConvertTo-Json -Compress"

// ps's [dd-][hh:]mm:ss[.ss], in ms.
const clockMs = (s: string) => {
  const [d, rest] = s.includes('-') ? s.split('-') : ['0', s]
  return (Number(d) * 86_400 + rest!.split(':').reduce((n, p) => n * 60 + Number(p), 0)) * 1000
}

/** Every process with a command line: when it started, its memory, and the CPU time it has used. */
export async function listProcesses(): Promise<Proc[]> {
  if (process.platform === 'win32') {
    let rows: { p: number; s: number; m: number; c: number; a: string }[] = []
    try { const j = JSON.parse(await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS]) || '[]'); rows = Array.isArray(j) ? j : [j] } catch {}
    return rows.map(r => ({ pid: r.p, start: r.s, mb: r.m / 2 ** 20, cpuMs: r.c / 10_000, cmd: r.a }))
  }
  const now = Date.now()
  return (await run('ps', ['-axww', '-o', 'pid=,rss=,time=,etime=,command='])).split('\n').flatMap(l => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+)$/.exec(l)
    return m ? [{ pid: Number(m[1]), start: now - clockMs(m[4]!), mb: Number(m[2]) / 1024, cpuMs: clockMs(m[3]!), cmd: m[5]! }] : []
  })
}

const norm = (s: string) => s.replace(/\\/g, '/').toLowerCase().replace(/\/$/, '')
// Typebulb's own processes (a mirror, a babysit, a bulb) run its program, which in the typebulb repo lies
// in the project. Its real path: npx starts it through a link.
const program = (() => { try { return norm(realpathSync(process.argv[1] ?? '')) } catch { return '' } })()
const ours = (p: Proc) => p.pid === process.pid || !!program && norm(p.cmd).includes(program)
/** Whether a command line names the project's folder, or a path inside it (not a sibling sharing its prefix). */
export function inProject(root: string, cmd: string): boolean {
  const r = norm(root), c = norm(cmd)
  for (let i = c.indexOf(r); i >= 0; i = c.indexOf(r, i + 1)) if (!/[\w.-]/.test(c[i + r.length] ?? '')) return true
  return false
}

/** A process by what it runs: its script's folder and name, else the package it runs, else the program. */
export function processLabel(cmd: string): string {
  const toks = (cmd.match(/"[^"]*"|\S+/g) ?? []).map(t => t.replace(/^"|"$/g, '').replace(/\\/g, '/'))
  const files = toks.slice(1).filter(t => !t.startsWith('-') && /\.(m?js|cjs|m?ts)$/i.test(t))
  const own = files.find(f => !f.includes('/node_modules/'))
  if (own) return own.split('/').slice(-2).join('/')
  const pkg = files.map(f => /\/node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(f)?.[1]).find(Boolean)
  return pkg ?? toks[0]?.split('/').pop() ?? cmd.slice(0, 40)
}

// A share of the machine's CPU between two listings.
const cpuShare = (a: Proc | undefined, b: Proc, wallMs: number) =>
  a && wallMs > 0 ? Math.max(0, (b.cpuMs - a.cpuMs) / wallMs / cpus().length) : 0

const history = windowFile<Seen>('processes.jsonl', WINDOW_MS)
const roots = new Set<string>()
let seen: Seen[] = []
// Heavy on one reading. The sampler asks HEAVY_CPU of two readings running, so a burst at startup doesn't count.
const isHeavy = (s: { mb: number; cpu: number }) => s.mb >= HEAVY_MB || s.cpu >= HEAVY_CPU
// A process seen heavy, which the sampler then follows for the rest of its life.
const followed = (pid: number, start: number) => seen.some(s => s.pid === pid && Math.abs(s.start - start) < SAME_START_MS && s.heavy)
let warm = new Set<number>()   // pids past HEAVY_CPU in the last sample
let prev = new Map<number, Proc>(), prevAt = 0, lastAt = 0, busy = false
let timer: ReturnType<typeof setInterval> | undefined

async function sample() {
  if (busy) return
  busy = true
  try {
    const procs = await listProcesses()
    const at = Date.now()
    const out: Seen[] = []
    const hot = new Set<number>()
    for (const p of procs) {
      const root = ours(p) ? undefined : [...roots].find(r => inProject(r, p.cmd))
      if (!root) continue
      const cpu = cpuShare(prev.get(p.pid), p, at - prevAt)
      if (cpu >= HEAVY_CPU) hot.add(p.pid)
      const now = p.mb >= HEAVY_MB || cpu >= HEAVY_CPU && warm.has(p.pid)
      if (now || followed(p.pid, p.start))
        out.push({ root, pid: p.pid, start: p.start, at, mb: Math.round(p.mb), cpu: Math.round(cpu * 1000) / 1000, cmd: p.cmd.slice(0, 200), ...now ? { heavy: true } : {} })
    }
    warm = hot
    if (procs.length) { prev = new Map(procs.map(p => [p.pid, p])); prevAt = at; lastAt = at }
    seen.push(...out)
    while (seen.length && seen[0]!.at < at - WINDOW_MS) seen.shift()
    history.append(out)
  } finally { busy = false }
}

/** Sample the project's processes every 30 s while this mirror runs. */
export function watchProjectProcesses(root: string) {
  roots.add(root)
  if (timer) return
  seen = history.load(Date.now())
  void sample()
  timer = setInterval(() => void sample(), EVERY_MS)
  timer.unref()
}

/** The project's heavy processes, one run each: from the process's start to its last sighting, open
 *  while the latest sample still saw it, with its usage at each sighting. */
export function processFacts(root: string): ProcessRun[] {
  const r = norm(root), runs: ProcessRun[] = []
  for (const s of seen) {
    if (norm(s.root) !== r) continue
    let x = runs.find(x => x.pid === s.pid && Math.abs(x.start - s.start) < SAME_START_MS)
    if (!x) runs.push(x = { pid: s.pid, label: processLabel(s.cmd), cmd: s.cmd, start: s.start, to: s.at, peakMb: 0, peakCpu: 0, lastMb: 0, lastCpu: 0, open: false, points: [] })
    if (s.at >= x.to) Object.assign(x, { lastMb: s.mb, lastCpu: s.cpu })
    Object.assign(x, { to: Math.max(x.to, s.at), peakMb: Math.max(x.peakMb, s.mb), peakCpu: Math.max(x.peakCpu, s.cpu) })
    x.points.push({ at: s.at, mb: s.mb, cpu: s.cpu })
  }
  // Only a process seen heavy is drawn: one never past the bar isn't.
  const drawn = runs.filter(x => followed(x.pid, x.start))
  for (const x of drawn) {
    x.open = x.to >= lastAt
    const k = Math.ceil(x.points.length / MAX_POINTS)
    if (k > 1) x.points = Array.from({ length: Math.ceil(x.points.length / k) }, (_, i) => x.points.slice(i * k, i * k + k))
      .map(b => ({ at: b[0]!.at, mb: Math.max(...b.map(p => p.mb)), cpu: Math.max(...b.map(p => p.cpu)) }))
  }
  return drawn.sort((a, b) => a.start - b.start)
}

/** The project's heavy processes running now, read live (two listings a second apart, for CPU), heaviest first. */
export async function heavyProcesses(root: string): Promise<(Proc & { cpu: number })[]> {
  const a = await listProcesses(), t0 = Date.now()
  await new Promise(r => setTimeout(r, 1000))
  const b = await listProcesses(), wall = Date.now() - t0
  const before = new Map(a.map(p => [p.pid, p]))
  return b.filter(p => !ours(p) && inProject(root, p.cmd)).map(p => ({ ...p, cpu: cpuShare(before.get(p.pid), p, wall) }))
    .filter(isHeavy).sort((x, y) => y.mb - x.mb)
}

/** Heavy processes as one clause: how many, their memory together, and the heaviest named. */
export function heavyText(heavy: (Proc & { cpu: number })[], most = 4): string {
  const named = heavy.slice(0, most).map(p => `${processLabel(p.cmd)} ${sizeText(p.mb)}`)
  return `${plural(heavy.length, 'process', 'processes')}, ${sizeText(heavy.reduce((n, p) => n + p.mb, 0))}: `
    + [...named, ...heavy.length > most ? [`${heavy.length - most} more`] : []].join(', ')
}

/** The project's heavy processes running now, as `typebulb status` states them: '' when none. */
export async function processLine(root: string): Promise<string> {
  const heavy = await heavyProcesses(root)
  if (!heavy.length) return ''
  return `Processes: heavy running in ${root} (${Math.round(heavy.reduce((n, p) => n + p.cpu, 0) * 100)}% CPU), oldest since ${clock(Math.min(...heavy.map(p => p.start)))}: ${heavyText(heavy)}.`
}
