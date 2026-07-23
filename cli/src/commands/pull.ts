import * as fs from 'fs/promises'
import * as path from 'path'
import { createHash } from 'crypto'
import { loadEnv } from '../env.js'
import { parseBulb, orderedKinds, blocks } from 'typebulb/format'
import { bulbAssetsDir, conventionalIdentity } from '../pipeline.js'

/**
 * `typebulb pull <url | file>` — fetch one bulb from typebulb.com into its conventional local
 * file (TB-Push-Pull.md), **assets folder included** (TB-Assets.md: assets follow every gesture
 * that moves a bulb — a pulled copy is the whole bulb, not just its text). Explicit whole-bulb
 * transfer, never sync: a differing local file OR asset is refused unless --force. The wire is
 * the public raw `.bulb.md` GET plus the asset manifest/bytes GETs (visibility is the auth on
 * all of them); a TYPEBULB_TOKEN (when set) rides along and unlocks the owner's private bulbs.
 */

const DEFAULT_ORIGIN = 'https://typebulb.com'

/** The conventional local home of a remote bulb — the path IS the remote identity (Invariant 4). */
export const bulbRelPath = (userSlug: string, slug: string) => path.join('typebulbs', 'u', userSlug, `${slug}.bulb.md`)

/** The one wire URL both directions speak: the public raw-markdown shape (TB-Push-Pull.md Invariant 2). */
export const bulbMdUrl = (t: PullTarget) =>
  `${t.origin}/u/${encodeURIComponent(t.userSlug)}/${encodeURIComponent(t.slug)}.md`

/** A relative asset path as URL segments (`sub/née.png` → `sub/n%C3%A9e.png`). */
export const encodeRel = (rel: string) => rel.split('/').map(encodeURIComponent).join('/')

/** The wire base all four asset verbs share (manifest GET, bytes GET, PUT, DELETE). */
export const assetsWireBase = (t: PullTarget) =>
  `${t.origin}/u/${encodeURIComponent(t.userSlug)}/${encodeURIComponent(t.slug)}/assets`

/** Run `fn` over `items` with at most `limit` in flight; first rejection wins (rest may finish). */
export async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items]
  const worker = async () => { for (let it = queue.shift(); it !== undefined; it = queue.shift()) await fn(it) }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

/** Content MD5 as hex — the manifest's compare key on both sides of the wire (R2's etag). */
export const md5hex = (bytes: Uint8Array | string) => createHash('md5').update(bytes).digest('hex')

/** `{error}` JSON's message when the body is that shape, else the raw body. */
export function errorFrom(body: string): string {
  try { return (JSON.parse(body) as { error?: string }).error || body } catch { return body }
}

export type AssetManifestEntry = { path: string; md5: string }

/** The remote asset manifest, or the reason it couldn't be had — shared by pull's plan and
 *  push's sync, each keeping its own policy (pull degrades to text-only, push refuses). A 200
 *  that isn't JSON is the SPA-shell trap (TB-Push-Pull.md appendix): a wrong origin. */
export async function fetchAssetManifest(target: PullTarget, opts: { token?: string; timeoutMs?: number }): Promise<{ entries: AssetManifestEntry[] } | { error: string }> {
  try {
    const resp = await fetch(assetsWireBase(target), {
      headers: opts.token ? { Authorization: `Bearer ${opts.token}` } : {},
      signal: opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined,
    })
    if (!resp.ok) return { error: `manifest request failed (${resp.status}): ${errorFrom(await resp.text())}` }
    if (!resp.headers.get('content-type')?.includes('json')) return { error: 'manifest response is not JSON — wrong origin?' }
    return { entries: await resp.json() as AssetManifestEntry[] }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

type PullOpts = { force?: boolean; token?: string; timeoutMs?: number }

/** Shared command preamble: load the env cascade, resolve the origin, parse the target (exits on
 *  a bad argument — parse errors are usage errors). */
export function resolveTarget(arg: string, mode?: string): PullTarget {
  loadEnv(mode)
  const origin = process.env.TYPEBULB_ORIGIN || DEFAULT_ORIGIN
  try {
    return parsePullTarget(arg, process.cwd(), origin)
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(1)
  }
}

export interface PullTarget {
  origin: string
  userSlug: string
  slug: string
  /** Absolute path the bulb lands at: <cwd>/typebulbs/u/<userSlug>/<slug>.bulb.md. */
  dest: string
}

/**
 * Parse pull's argument. A bulb URL carries its own host (any page variant of
 * `/u/<user>/<slug>`, or the raw API `.md` URL); a local file must sit at the conventional
 * path — the path IS the remote identity (TB-Push-Pull.md Invariant 4) — and re-pulls in
 * place against `defaultOrigin`. Throws a usage-quality message otherwise.
 */
export function parsePullTarget(arg: string, cwd: string, defaultOrigin: string): PullTarget {
  if (/^https?:\/\//i.test(arg)) {
    const url = new URL(arg)
    const segs = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    // Page URL (/u/<user>/<slug>[/full…]) or raw API URL (/api/scripts/u/<user>/<slug>.md) —
    // trailing page-variant segments are ignored.
    const u = segs[0] === 'api' && segs[1] === 'scripts' ? segs.slice(2) : segs
    if (u[0] !== 'u' || !u[1] || !u[2]) {
      throw new Error(`Not a bulb URL: ${arg}\nExpected <origin>/u/<user>/<slug>`)
    }
    const userSlug = u[1]
    const slug = u[2].replace(/(\.bulb)?\.md$/, '')
    return { origin: url.origin, userSlug, slug, dest: path.join(cwd, bulbRelPath(userSlug, slug)) }
  }

  const dest = path.resolve(cwd, arg)
  const identity = conventionalIdentity(dest)
  if (!identity) {
    throw new Error(
      `Not a conventional bulb path: ${arg}\n` +
      `A pull target must be a bulb URL, or a local file at typebulbs/u/<user>/<slug>.bulb.md — the path is its remote identity.`
    )
  }
  return { origin: defaultOrigin, ...identity, dest }
}

export type PullOutcome =
  | { kind: 'written'; dest: string; created: boolean; assets?: AssetPull }
  | { kind: 'up-to-date'; dest: string; assets?: AssetPull }
  | { kind: 'conflict'; dest: string; localMtime: Date; remoteLastModified: string | null }
  | { kind: 'asset-conflict'; dest: string; paths: string[] }
  | { kind: 'http-error'; status: number }
  | { kind: 'not-markdown'; contentType: string | null }

/** The assets leg's outcome, attached to written/up-to-date. Absent = the leg didn't run (the
 *  manifest was empty or unavailable — an older server, a dev host without the binding). */
export type AssetPull = { downloaded: number; unchanged: number; errors: string[] }

type AssetPlan =
  | { kind: 'none' }
  | { kind: 'conflict'; paths: string[] }
  | { kind: 'plan'; toGet: string[]; unchanged: number }

/** Diff the remote manifest against the local assets/ folder: missing → download, identical
 *  (md5) → skip, differing → conflict unless force — the text's one conflict resolution, applied
 *  to bytes. A manifest the server can't or won't give (older server, dev Node without the R2
 *  binding, a private bulb without its owner's token) skips the leg; the 302 chain still serves. */
async function planAssetPull(target: PullTarget, opts: PullOpts): Promise<AssetPlan> {
  const manifest = await fetchAssetManifest(target, opts)
  if ('error' in manifest || !manifest.entries.length) return { kind: 'none' }
  const remote = manifest.entries

  const dir = bulbAssetsDir(target.dest)
  const toGet: string[] = []
  const conflicts: string[] = []
  let unchanged = 0
  for (const r of remote) {
    const local = await fs.readFile(path.join(dir, ...r.path.split('/'))).catch(() => undefined)
    if (local === undefined) toGet.push(r.path)
    else if (md5hex(local) === r.md5) unchanged++
    else if (opts.force) toGet.push(r.path)
    else conflicts.push(r.path)
  }
  return conflicts.length ? { kind: 'conflict', paths: conflicts } : { kind: 'plan', toGet, unchanged }
}

/** Download the planned files (bounded concurrency); per-file failures collect rather than
 *  abort — a re-pull re-plans exactly the missing ones (md5-skip makes it idempotent). */
async function downloadAssets(target: PullTarget, plan: { toGet: string[]; unchanged: number }, opts: PullOpts): Promise<AssetPull> {
  const dir = bulbAssetsDir(target.dest)
  const errors: string[] = []
  let downloaded = 0
  await mapLimit(plan.toGet, 4, async rel => {
    try {
      const resp = await fetch(`${assetsWireBase(target)}/${encodeRel(rel)}`, {
        headers: opts.token ? { Authorization: `Bearer ${opts.token}` } : {},
        signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
      })
      if (!resp.ok) { errors.push(`${rel}: HTTP ${resp.status}`); return }
      const dest = path.join(dir, ...rel.split('/'))
      await fs.mkdir(path.dirname(dest), { recursive: true })
      await fs.writeFile(dest, new Uint8Array(await resp.arrayBuffer()))
      downloaded++
    } catch (e) {
      errors.push(`${rel}: ${e instanceof Error ? e.message : String(e)}`)
    }
  })
  return { downloaded, unchanged: plan.unchanged, errors }
}

/** The transfer itself, separated from CLI messaging/exit codes so tests can drive it. */
export async function pullBulb(target: PullTarget, opts: PullOpts = {}): Promise<PullOutcome> {
  const resp = await fetch(bulbMdUrl(target), {
    headers: opts.token ? { Authorization: `Bearer ${opts.token}` } : {},
    signal: opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined,
  })
  if (!resp.ok) return { kind: 'http-error', status: resp.status }
  // Guard against an SPA-fallback 200 (HTML shell for an unhandled path): only markdown is a bulb.
  const contentType = resp.headers.get('content-type')
  if (!contentType?.includes('text/markdown')) return { kind: 'not-markdown', contentType }
  const markdown = await resp.text()

  let existing: string | undefined
  try { existing = await fs.readFile(target.dest, 'utf-8') } catch {}
  const upToDate = existing !== undefined && bulbEquivalent(existing, markdown)
  if (existing !== undefined && !upToDate && !opts.force) {
    const { mtime } = await fs.stat(target.dest)
    return { kind: 'conflict', dest: target.dest, localMtime: mtime, remoteLastModified: resp.headers.get('last-modified') }
  }

  // The assets leg, planned BEFORE the text write so an asset conflict refuses with nothing
  // half-moved — the folder is part of the bulb (TB-Assets.md).
  const plan = await planAssetPull(target, opts)
  if (plan.kind === 'conflict') return { kind: 'asset-conflict', dest: target.dest, paths: plan.paths }

  if (!upToDate) {
    await fs.mkdir(path.dirname(target.dest), { recursive: true })
    await fs.writeFile(target.dest, markdown)
    // Stamp mtime = the server's updatedAt (when sent): mtime is the last-synced marker push's
    // If-Unmodified-Since guard reads — a pulled-then-pushed file round-trips with no bookkeeping.
    const lastModified = new Date(resp.headers.get('last-modified') ?? '')
    if (!isNaN(lastModified.getTime())) await fs.utimes(target.dest, new Date(), lastModified)
  }
  const assets = plan.kind === 'plan' ? await downloadAssets(target, plan, opts) : undefined
  return upToDate
    ? { kind: 'up-to-date', dest: target.dest, assets }
    : { kind: 'written', dest: target.dest, created: existing === undefined, assets }
}

/** Same bulb, not same bytes: the remote stores parsed blocks and re-serializes canonically, so
 * authored formatting (block order, trailing lines) must not read as drift — nor may `server.ts`,
 * which is CLI-only and always stripped remotely (Invariant 8), so only the site blocks compare.
 * CRLF-insensitive; unparseable content falls back to a byte compare. */
function bulbEquivalent(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/\r\n/g, '\n')
  const pa = parseBulb(norm(a)), pb = parseBulb(norm(b))
  if (!pa || !pb) return norm(a) === norm(b)
  return pa.frontmatter.name === pb.frontmatter.name &&
    orderedKinds.every(k => (pa.files.get(blocks[k].path) || '') === (pb.files.get(blocks[k].path) || ''))
}

export async function runPull(arg: string | undefined, opts: { force: boolean; mode?: string }): Promise<void> {
  if (!arg) {
    console.error('Usage: typebulb pull <bulb url | typebulbs/u/<user>/<slug>.bulb.md>')
    process.exit(1)
  }
  const target = resolveTarget(arg, opts.mode)

  const bulbUrl = `${target.origin}/u/${target.userSlug}/${target.slug}`
  let outcome: PullOutcome
  try {
    outcome = await pullBulb(target, { force: opts.force, token: process.env.TYPEBULB_TOKEN })
  } catch (e) {
    console.error(`Could not reach ${target.origin}: ${e instanceof Error ? e.message : String(e)}`)
    // exitCode, not process.exit: a hard exit while fetch's sockets are tearing down trips a
    // libuv assertion on Windows (observed: exit 127 instead of 1).
    process.exitCode = 1
    return
  }

  const rel = path.relative(process.cwd(), target.dest) || target.dest
  switch (outcome.kind) {
    case 'written':
      console.log(`pulled ${bulbUrl} → ${rel}${outcome.created ? '' : ' (overwritten)'}`)
      reportAssets(outcome.assets)
      return
    case 'up-to-date':
      console.log(`up to date: ${rel}`)
      reportAssets(outcome.assets)
      return
    case 'conflict':
      console.error(
        `Refusing to overwrite ${rel} — it differs from ${bulbUrl}\n` +
        `  local file modified   ${outcome.localMtime.toISOString()}\n` +
        `  remote last saved     ${outcome.remoteLastModified ?? 'unknown'}\n` +
        `Re-run with --force to overwrite the local file.`
      )
      process.exitCode = 1
      return
    case 'asset-conflict':
      console.error(
        `Refusing to overwrite local assets that differ from the hosted copies:\n` +
        outcome.paths.map(p => `  assets/${p}`).join('\n') +
        `\nRe-run with --force to overwrite them.`
      )
      process.exitCode = 1
      return
    case 'http-error':
      if (outcome.status === 404) console.error(`Bulb not found: ${bulbUrl}`)
      else if (outcome.status === 401 || outcome.status === 403) console.error(`This bulb is private (${outcome.status}) — pulling it needs a TYPEBULB_TOKEN for its owner.`)
      else console.error(`Pull failed: ${target.origin} responded ${outcome.status}`)
      process.exitCode = 1
      return
    case 'not-markdown':
      console.error(
        `${bulbUrl}.md did not return bulb markdown (got ${outcome.contentType ?? 'no content-type'}) — ` +
        `is ${target.origin} a typebulb host?`
      )
      process.exitCode = 1
  }
}

/** The assets line under the pull's own: silent when the leg didn't run or had nothing to do. */
function reportAssets(a?: AssetPull): void {
  if (!a || (!a.downloaded && !a.errors.length)) return
  console.log(`assets: ${a.downloaded} downloaded${a.unchanged ? `, ${a.unchanged} unchanged` : ''}`)
  for (const e of a.errors) console.error(`  asset failed — ${e} (a re-pull retries just the missing ones)`)
  if (a.errors.length) process.exitCode = 1
}
