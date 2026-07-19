import * as fs from 'fs/promises'
import * as path from 'path'
import { parseBulb, assetsBase } from 'typebulb/format'
import { bulbMdUrl, resolveTarget, type PullTarget } from './pull.js'
import { bulbDataDir } from '../pipeline.js'

/**
 * `typebulb push <file>` — upload one conventional local bulb to typebulb.com as the authed
 * user (TB-Push-Pull.md). The wire is the raw `.bulb.md` PUT twin of pull's GET; auth is the
 * TYPEBULB_TOKEN personal access token. Stateless staleness guard: the file's mtime — stamped
 * to the server's updatedAt by pull and by every successful push — rides as If-Unmodified-Since,
 * and the server 409s if the remote changed after it. --force omits the header (the deliberate
 * clobber). The server strips `server.ts` (CLI-only) and says so; the local file never changes.
 */

export type PushOutcome =
  | { kind: 'pushed'; created: boolean; serverStripped: boolean; updatedAt: number }
  | { kind: 'conflict'; message: string }
  | { kind: 'http-error'; status: number; message: string }

export type AssetsCheckResult =
  | { kind: 'none' }
  | { kind: 'no-key'; count: number }
  | { kind: 'verified'; count: number; base: string }
  | { kind: 'missing'; missing: { rel: string; url: string }[]; count: number; base: string }

/** TB-Assets.md Invariant 7: the folder is the manifest. HEAD every file under the bulb's
 *  own `assets/` (birds.bulb.md → birds/assets/) at `<base>/<relpath>` — misses block the push
 *  (`--force` overrides), and a folder without the config key earns a loud note (local assets
 *  don't travel). No code scanning. */
export async function checkAssets(bulbFile: string, opts?: { timeoutMs?: number }): Promise<AssetsCheckResult> {
  const assetsDir = path.join(bulbDataDir(bulbFile), 'assets')
  const rels = await listFilesRec(assetsDir)
  if (!rels.length) return { kind: 'none' }
  const markdown = await fs.readFile(bulbFile, 'utf-8')
  const base = assetsBase(parseBulb(markdown)?.files.get('config.json'))
  if (!base) return { kind: 'no-key', count: rels.length }
  // Probes run concurrently so a dead host costs one timeout, not one per file.
  const missing = (await Promise.all(rels.map(async rel => {
    const url = base + rel.split('/').map(encodeURIComponent).join('/')
    return (await probeUrl(url, opts?.timeoutMs ?? 10_000)) ? undefined : { rel, url }
  }))).filter(m => m !== undefined)
  return missing.length ? { kind: 'missing', missing, count: rels.length, base } : { kind: 'verified', count: rels.length, base }
}

/** Relative paths (forward-slashed) of all files under `dir`, [] when it doesn't exist. */
async function listFilesRec(dir: string, prefix = ''): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  const out: string[] = []
  for (const e of entries) {
    if (e.isDirectory()) out.push(...await listFilesRec(path.join(dir, e.name), `${prefix}${e.name}/`))
    else if (e.isFile()) out.push(prefix + e.name)
  }
  return out
}

/** Does `url` exist? HEAD first; a host that rejects HEAD (405/501) gets a 1-byte ranged GET. */
async function probeUrl(url: string, timeoutMs: number): Promise<boolean> {
  try {
    const head = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(timeoutMs) })
    if (head.ok) return true
    if (head.status !== 405 && head.status !== 501) return false
    const get = await fetch(url, { headers: { Range: 'bytes=0-0' }, signal: AbortSignal.timeout(timeoutMs) })
    return get.ok
  } catch {
    return false
  }
}

/** The transfer itself, separated from CLI messaging/exit codes so tests can drive it. */
export async function pushBulb(target: PullTarget, opts: { token: string; force?: boolean; timeoutMs?: number }): Promise<PushOutcome> {
  const markdown = await fs.readFile(target.dest, 'utf-8')
  const { mtime } = await fs.stat(target.dest)

  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.token}`,
    'Content-Type': 'text/markdown; charset=utf-8',
  }
  if (!opts.force) headers['If-Unmodified-Since'] = mtime.toUTCString()

  const resp = await fetch(bulbMdUrl(target), {
    method: 'PUT',
    body: markdown,
    headers,
    signal: opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined,
  })

  const body = await resp.text()
  if (resp.status === 409) return { kind: 'conflict', message: errorFrom(body) }
  if (!resp.ok) return { kind: 'http-error', status: resp.status, message: errorFrom(body) }

  const r = JSON.parse(body) as { id: string; updatedAt: number; created: boolean; serverStripped: boolean }
  // Stamp mtime = the server's updatedAt: an unedited re-push stays non-stale, a remote edit
  // after this moment is stale. mtime IS the last-synced marker — no sidecar (Invariant 5).
  await fs.utimes(target.dest, new Date(), new Date(r.updatedAt))
  return { kind: 'pushed', created: r.created, serverStripped: r.serverStripped, updatedAt: r.updatedAt }
}

function errorFrom(body: string): string {
  try { return (JSON.parse(body) as { error?: string }).error || body } catch { return body }
}

export async function runPush(arg: string | undefined, opts: { force: boolean; mode?: string }): Promise<void> {
  if (!arg) {
    console.error('Usage: typebulb push <typebulbs/u/<user>/<slug>.bulb.md>')
    process.exit(1)
  }
  if (/^https?:\/\//i.test(arg)) {
    console.error('push takes a local .bulb.md file, not a URL (the path is its remote identity)')
    process.exit(1)
  }
  const target = resolveTarget(arg, opts.mode)
  const token = process.env.TYPEBULB_TOKEN
  if (!token) {
    console.error('push needs TYPEBULB_TOKEN in your .env — create one on your typebulb.com settings page.')
    process.exit(1)
  }

  const bulbUrl = `${target.origin}/u/${target.userSlug}/${target.slug}`
  const rel = path.relative(process.cwd(), target.dest) || target.dest
  let outcome: PushOutcome
  try {
    // Assets gate (TB-Assets.md) before the PUT: misses refuse (--force publishes anyway),
    // a keyless assets/ folder notes-and-continues. Never uploads binaries.
    const assets = await checkAssets(target.dest)
    if (assets.kind === 'missing') {
      console.error(`assets check against ${assets.base}`)
      for (const m of assets.missing) console.error(`  MISSING ${m.rel}  → expected at ${m.url}`)
      if (!opts.force) {
        console.error(`push refused: ${assets.missing.length} of ${assets.count} asset(s) not hosted yet (typebulb.com stores the bulb text only). Upload them, or push --force to publish anyway.`)
        process.exitCode = 1
        return
      }
      console.error('  continuing (--force): the published bulb will 404 on these until they are uploaded.')
    }
    if (assets.kind === 'no-key') console.log(`note: this bulb has an assets/ folder (${assets.count} file(s)) but no "assets" base URL in config.json — local assets don't travel with a push; host them and set the key, or inline them.`)
    if (assets.kind === 'verified') console.log(`assets: verified ${assets.count} file(s) against ${assets.base}`)
    outcome = await pushBulb(target, { token, force: opts.force })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error((e as NodeJS.ErrnoException)?.code === 'ENOENT' ? `File not found: ${rel}` : `Could not push to ${target.origin}: ${msg}`)
    process.exitCode = 1
    return
  }

  switch (outcome.kind) {
    case 'pushed':
      console.log(`pushed ${rel} → ${bulbUrl}${outcome.created ? ' (created, unlisted)' : ''}`)
      if (outcome.serverStripped) console.log('note: the server.ts block was stripped on the server copy (CLI-only); your local file is untouched.')
      return
    case 'conflict':
      console.error(`${outcome.message}\n  pull to see the remote: typebulb pull ${rel}\n  or overwrite it:        typebulb push ${rel} --force`)
      process.exitCode = 1
      return
    case 'http-error':
      if (outcome.status === 401) console.error('The server rejected TYPEBULB_TOKEN (401) — it may be revoked; mint a new one on the settings page.')
      else console.error(`Push failed: ${target.origin} responded ${outcome.status}${outcome.message ? ` — ${outcome.message}` : ''}`)
      process.exitCode = 1
  }
}
