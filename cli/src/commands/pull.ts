import * as fs from 'fs/promises'
import * as path from 'path'
import { loadEnv } from '../env.js'
import { parseBulb, orderedKinds, blocks } from 'typebulb/format'

/**
 * `typebulb pull <url | file>` — fetch one bulb from typebulb.com into its conventional local
 * file (TB-Push-Pull.md). Explicit whole-file transfer, never sync: a differing local file is
 * refused with both timestamps unless --force. The wire format is the public raw `.bulb.md`
 * (`GET <origin>/u/<user>/<slug>.md`); unlisted/public bulbs need no auth, a TYPEBULB_TOKEN
 * (when set) rides along and unlocks the owner's private bulbs.
 */

const DEFAULT_ORIGIN = 'https://typebulb.com'

/** The conventional local home of a remote bulb — the path IS the remote identity (Invariant 4). */
export const bulbRelPath = (userSlug: string, slug: string) => path.join('typebulbs', 'u', userSlug, `${slug}.bulb.md`)

/** The one wire URL both directions speak: the public raw-markdown shape (TB-Push-Pull.md Invariant 2). */
export const bulbMdUrl = (t: PullTarget) =>
  `${t.origin}/u/${encodeURIComponent(t.userSlug)}/${encodeURIComponent(t.slug)}.md`

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
  const [folder, uDir, userSlug, file] = dest.split(path.sep).slice(-4)
  if (folder !== 'typebulbs' || uDir !== 'u' || !userSlug || !file?.endsWith('.bulb.md')) {
    throw new Error(
      `Not a conventional bulb path: ${arg}\n` +
      `A pull target must be a bulb URL, or a local file at typebulbs/u/<user>/<slug>.bulb.md — the path is its remote identity.`
    )
  }
  return { origin: defaultOrigin, userSlug, slug: file.slice(0, -'.bulb.md'.length), dest }
}

export type PullOutcome =
  | { kind: 'written'; dest: string; created: boolean }
  | { kind: 'up-to-date'; dest: string }
  | { kind: 'conflict'; dest: string; localMtime: Date; remoteLastModified: string | null }
  | { kind: 'http-error'; status: number }
  | { kind: 'not-markdown'; contentType: string | null }

/** The transfer itself, separated from CLI messaging/exit codes so tests can drive it. */
export async function pullBulb(target: PullTarget, opts: { force?: boolean; token?: string; timeoutMs?: number } = {}): Promise<PullOutcome> {
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
  if (existing !== undefined) {
    if (bulbEquivalent(existing, markdown)) return { kind: 'up-to-date', dest: target.dest }
    if (!opts.force) {
      const { mtime } = await fs.stat(target.dest)
      return { kind: 'conflict', dest: target.dest, localMtime: mtime, remoteLastModified: resp.headers.get('last-modified') }
    }
  }

  await fs.mkdir(path.dirname(target.dest), { recursive: true })
  await fs.writeFile(target.dest, markdown)
  // Stamp mtime = the server's updatedAt (when sent): mtime is the last-synced marker push's
  // If-Unmodified-Since guard reads — a pulled-then-pushed file round-trips with no bookkeeping.
  const lastModified = new Date(resp.headers.get('last-modified') ?? '')
  if (!isNaN(lastModified.getTime())) await fs.utimes(target.dest, new Date(), lastModified)
  return { kind: 'written', dest: target.dest, created: existing === undefined }
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
      return
    case 'up-to-date':
      console.log(`up to date: ${rel}`)
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
