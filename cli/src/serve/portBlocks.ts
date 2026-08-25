/**
 * Port allocation (TB-CLI.md, "Port allocation"). A project claims a 100-port block and keeps it, so
 * every bulb answers at the same URL run after run — bookmarkable, and a replace can't move it out
 * from under an open tab.
 *
 * Blocks are one file per base under `~/.typebulb/blocks/`, claimed by exclusive create: the
 * registry's one-file-per-pid trick, so two projects launching at the same instant can't both win
 * without a lock or a read-modify-write race.
 */

import * as net from 'net'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { typebulbHome, normalizeBulbPath, warnStateDirOnce } from './paths.js'

/**
 * 20100–21999, one 100-port block per project: 20100 is a project, 20101 and 20102 its first two
 * bulbs. Stepping by 100 is what makes a port *countable* — the hundreds name the project, the units
 * the app — where a narrower stride means dividing in your head to read it.
 *
 * Only one port rule is hard: Chrome's `ERR_UNSAFE_PORT` list — the one hazard probing cannot see,
 * since a blocked port *binds* fine and the browser refuses it anyway, so the bulb fails pointing at
 * nothing. Its last member is 10080, so up here there is nothing to exclude and no exclusion list to
 * maintain. Everything else is soft: an occupied port doesn't bind, the allocator takes the next slot
 * in the same block and says so.
 *
 * The edges are where the soft cases cluster. It starts at 20100, not 20000, because that base is the
 * one genuinely contested port in range (Usermin, DNP3) — and it would otherwise be the *first*
 * project's mirror, the port that project visits most. It stops at 21999, below the 20000s' famous
 * residents: Syncthing 22000, Minecraft 25565, CockroachDB 26257, MongoDB 27017, Steam 27000–27050.
 * The WebRTC/TURN and RTP ranges that overlap here are UDP, a separate namespace from our binds.
 * Well below every ephemeral range (Linux 32768+, Windows 49152+) too, where a fixed bind would
 * intermittently lose to an outgoing connection's source port.
 */
const BAND_START = 20100
const BLOCK_SIZE = 100
const BLOCK_COUNT = 19
/** Spill base: past the band and past Syncthing, for a project with no block or a full one. */
const SPILL_BASE = 23000

/** Bulbs count up from +1 so "app 2" is `<base>02`; a mirror takes +0 — the project's home port —
 *  and a second harness's mirror counts down from the far end rather than displacing app numbering. */
const FIRST_BULB_SLOT = 1
const LAST_SLOT = BLOCK_SIZE - 1

/** How long a launch waits for its OWN slot before concluding somebody else holds it, polled every
 *  150ms. A replaced predecessor is already dead by then (`stopServer` waits for it), but its socket
 *  can outlive it for a beat, and the kill fallback does not wait at all. Spilling is no longer a
 *  shrug: a page may be waiting at that slot, so the launch aborts rather than move
 *  (TB-Page-Lifecycle.md, A keep is a promise). Four tries at 150ms was not enough. */
const BIND_WAIT_MS = 3000

interface BlockFile {
  /** The project this block belongs to (normalized). */
  cwd: string
  /** Bulb path (normalized) → slot offset, with the last run for LRU recycling when the block fills. */
  slots: Record<string, { offset: number; usedAt: number }>
  /** Harness name → mirror slot offset (+0 for the first harness, counting down from the top after). */
  mirrors: Record<string, number>
}

export type PortTarget =
  | { kind: 'bulb'; file: string }
  | { kind: 'mirror'; agent: string }

function blocksDir(): string {
  return join(typebulbHome(), 'blocks')
}

function blockPath(base: number): string {
  return join(blocksDir(), `${base}.json`)
}

/** Can we actually listen on this port right now? The allocator's only fact about the outside world. */
function canBind(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const probe = net.createServer()
    probe.once('error', () => resolve(false))
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)))
  })
}

/** First bindable port at or above `from`, ignoring blocks — the spill path and nothing else. */
export async function findAvailablePort(from: number): Promise<number> {
  for (let port = from; port < 65535; port++) {
    if (await canBind(port)) return port
  }
  throw new Error(`No free port found above ${from}`)
}

/**
 * The one place a port collision becomes a message. Names the occupant when it's one of ours — the
 * registry is right here, and it is the only moment we can say *which* bulb took it.
 *
 * The registry is reached lazily, and deliberately: `serverRegistry` needs `assignedPortFor` to
 * decide a replaced predecessor's pages (TB-Page-Lifecycle.md), which makes allocation the lower
 * layer. A static import here would point the edge both ways for one diagnostic.
 */
export async function reportPortInUse(port: number): Promise<never> {
  const { listBulbServers } = await import('./serverRegistry.js')
  const holder = (await listBulbServers()).find(s => s.port === port)
  const who = holder ? ` (pid ${holder.pid}, ${holder.agent ? `agent:${holder.agent}` : holder.file})` : ''
  console.error(`port ${port} in use${who}`)
  process.exit(1)
}

async function readBlock(base: number): Promise<BlockFile | undefined> {
  try {
    const parsed = JSON.parse(await readFile(blockPath(base), 'utf8')) as BlockFile
    return parsed && typeof parsed.cwd === 'string'
      ? { cwd: parsed.cwd, slots: parsed.slots ?? {}, mirrors: parsed.mirrors ?? {} }
      : undefined
  } catch {
    return undefined   // missing or corrupt — treat as unclaimed, the same self-heal the registry does
  }
}

/** Best-effort: an unwritable home (sandboxed shell) degrades per call site — a claim that can't
 *  persist is still usable this run; `canBind` arbitrates any cross-run drift. */
async function writeBlock(base: number, block: BlockFile): Promise<boolean> {
  try {
    await writeFile(blockPath(base), JSON.stringify(block, null, 2))
    return true
  } catch {
    warnStateDirOnce()
    return false
  }
}

/**
 * The block base for `cwd`, claiming one if this project has none. A block whose project directory
 * is gone is reclaimed on sight (prune-on-read, like `listBulbServers`); when every base is claimed
 * by a live project the least-recently-used one is taken over. Returns undefined only if the
 * blocks dir is unusable or a claim can't be persisted — the caller then spills.
 */
async function blockBaseFor(cwd: string): Promise<number | undefined> {
  const key = normalizeBulbPath(cwd)
  try {
    await mkdir(blocksDir(), { recursive: true })
  } catch {
    return undefined
  }

  const bases: number[] = []
  for (let i = 0; i < BLOCK_COUNT; i++) bases.push(BAND_START + i * BLOCK_SIZE)

  // Ours already?
  const existing = await Promise.all(bases.map(async base => ({ base, block: await readBlock(base) })))
  for (const { base, block } of existing) {
    if (block?.cwd === key) return base
  }

  // Claim: exclusive create wins the race outright; an EEXIST whose project is gone is reclaimed.
  const fresh: BlockFile = { cwd: key, slots: {}, mirrors: {} }
  for (const { base, block } of existing) {
    if (!block) {
      try {
        await writeFile(blockPath(base), JSON.stringify(fresh, null, 2), { flag: 'wx' })
        return base
      } catch (e) {
        // Lost the race to another launch — re-read; if it took the base for THIS project, it's ours.
        // Any failure other than the race's EEXIST is the home refusing writes.
        const now = await readBlock(base)
        if (now?.cwd === key) return base
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') warnStateDirOnce()
        continue
      }
    }
    if (!existsSync(block.cwd)) {
      return (await writeBlock(base, fresh)) ? base : undefined
    }
  }

  // Band full of live projects: recycle the one whose newest slot is oldest.
  const lru = existing
    .filter((e): e is { base: number; block: BlockFile } => !!e.block)
    .sort((a, a2) => newestUse(a.block) - newestUse(a2.block))[0]
  if (!lru) return undefined
  return (await writeBlock(lru.base, fresh)) ? lru.base : undefined
}

function newestUse(block: BlockFile): number {
  return Object.values(block.slots).reduce((max, s) => Math.max(max, s.usedAt ?? 0), 0)
}

/**
 * This target's sticky offset within its project block, recording the claim. Bulbs take +1 upward in
 * first-run order and keep it; when they're all spoken for the least-recently-run one is reused.
 */
async function offsetFor(base: number, target: PortTarget): Promise<number> {
  const block = (await readBlock(base)) ?? { cwd: '', slots: {}, mirrors: {} }

  if (target.kind === 'mirror') {
    const held = block.mirrors[target.agent]
    if (held !== undefined) return held
    // The first harness gets +0 (the project's home port); the next counts down from the top, so a
    // project running both a claude and a pi mirror never renumbers its bulbs.
    const taken = heldOffsets(block)
    let slot = taken.has(0) ? LAST_SLOT : 0
    while (slot > FIRST_BULB_SLOT && taken.has(slot)) slot--
    block.mirrors[target.agent] = slot
    await writeBlock(base, block)
    return slot
  }

  const key = normalizeBulbPath(target.file)
  let offset = block.slots[key]?.offset
  if (offset === undefined) {
    const taken = heldOffsets(block)
    offset = FIRST_BULB_SLOT
    while (offset < BLOCK_SIZE && taken.has(offset)) offset++
    if (offset >= BLOCK_SIZE) {
      // Block full — take the least-recently-run bulb's slot (it will simply be reassigned next run).
      const oldest = Object.entries(block.slots).sort((a, b) => (a[1].usedAt ?? 0) - (b[1].usedAt ?? 0))[0]
      offset = oldest ? oldest[1].offset : FIRST_BULB_SLOT
      if (oldest) delete block.slots[oldest[0]]
    }
  }
  block.slots[key] = { offset, usedAt: Date.now() }   // held or new, every run refreshes the LRU fact
  await writeBlock(base, block)
  return offset
}

/** Every offset any target in this block holds — bulb slots and mirrors alike, so the two kinds can
 *  never be double-booked (a project deep enough into the block to reach +99 meets a second mirror). */
function heldOffsets(block: BlockFile): Set<number> {
  return new Set([...Object.values(block.mirrors), ...Object.values(block.slots).map(s => s.offset)])
}

export interface ResolvedPort {
  port: number
  /** Printed under the URL when the port isn't the assigned slot — never for the ordinary case. */
  note?: string
}

/**
 * This target's sticky port — the project block's slot for it, claimed if new. Pure bookkeeping: it
 * asks nothing of the network, so it answers "which port is mine" identically whether or not anything
 * currently holds it. `resolvePort` is this plus the binding reality.
 */
export async function assignedPortFor(target: PortTarget, cwd: string): Promise<number | undefined> {
  const base = await blockBaseFor(cwd)
  return base === undefined ? undefined : base + (await offsetFor(base, target))
}

/**
 * When each of this project's bulbs last launched — the `usedAt` the slot LRU already maintains
 * (`offsetFor` refreshes it on every run), exposed for hosts that order by use (the mirror's bulbs
 * pill). Read-only by design: listing must never claim a block, so a project that has run nothing
 * answers 0 for everything. Returns a lookup so the block's key scheme stays internal.
 */
export async function lastRunTimes(cwd: string): Promise<(file: string) => number> {
  const key = normalizeBulbPath(cwd)
  for (let i = 0; i < BLOCK_COUNT; i++) {
    const block = await readBlock(BAND_START + i * BLOCK_SIZE)
    if (block?.cwd === key) return file => block.slots[normalizeBulbPath(file)]?.usedAt ?? 0
  }
  return () => 0
}

/**
 * The port to bind. An explicit `--port` is honoured or fails (the caller's decision, not ours to
 * silently move), its run still recorded; otherwise the project block's sticky slot, probing within the block and finally
 * spilling past the band. A just-replaced predecessor may hold the slot for a beat, so the assigned
 * one is retried briefly before we conclude somebody else owns it — that retry is what keeps an open
 * tab pointed at a live server across a relaunch.
 */
export async function resolvePort(opts: { explicit?: number; target: PortTarget; cwd: string }): Promise<ResolvedPort> {
  if (opts.explicit !== undefined) {
    // Never bumped: a flag whose only purpose is to name a port has already decided which URL the
    // caller opens or hands out. Checked here so it fails before a compile's worth of output.
    if (!(await canBind(opts.explicit))) await reportPortInUse(opts.explicit)
    // The run is still recorded (the slot's usedAt, what `lastRunTimes` answers): a launch reads it
    // to know whether an earlier tab may be retrying its stream. Unrecorded, a --port relaunch read
    // as the bulb's first run, skipped the settle window, and stacked a tab on the returning one.
    if (opts.target.kind === 'bulb') await assignedPortFor(opts.target, opts.cwd)
    return { port: opts.explicit }
  }

  const assigned = await assignedPortFor(opts.target, opts.cwd)
  if (assigned !== undefined) {
    // Recoverable from the port because BAND_START is block-aligned: the remainder IS the slot offset.
    const base = assigned - (assigned % BLOCK_SIZE)
    const deadline = Date.now() + BIND_WAIT_MS
    do {
      if (await canBind(assigned)) return { port: assigned }
      await new Promise(r => setTimeout(r, 150))
    } while (Date.now() < deadline)
    // Somebody else holds our slot: any other free port in the block keeps us inside the project's range.
    for (let offset = FIRST_BULB_SLOT; offset < BLOCK_SIZE; offset++) {
      const port = base + offset
      if (port === assigned) continue
      if (await canBind(port)) return { port, note: `(slot ${assigned} was busy)` }
    }
  }

  const port = await findAvailablePort(SPILL_BASE)
  return { port, note: assigned === undefined ? '(no port block available)' : `(this project's block was full)` }
}
