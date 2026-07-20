import * as fs from 'fs/promises'
import * as path from 'path'
import { createHash } from 'crypto'
import { parseBulb, assetsBase, hostedAssetsBase } from 'typebulb/format'
import { bulbMdUrl, resolveTarget, type PullTarget } from './pull.js'
import { bulbAssetsDir } from '../pipeline.js'
import { contentTypeFor } from '../serve/server.js'

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

/** A relative asset path as URL segments (`sub/née.png` → `sub/n%C3%A9e.png`). */
const encodeRel = (rel: string) => rel.split('/').map(encodeURIComponent).join('/')

/** TB-Assets.md Invariant 7: the folder is the manifest. HEAD every file under the bulb's
 *  own `assets/` (birds.bulb.md → birds/assets/) at `<base>/<relpath>` — misses block the push
 *  (`--force` overrides), and a folder without the config key earns a loud note (local assets
 *  don't travel). No code scanning. */
export async function checkAssets(bulbFile: string, opts?: { timeoutMs?: number }): Promise<AssetsCheckResult> {
  const rels = await listFilesRec(bulbAssetsDir(bulbFile))
  if (!rels.length) return { kind: 'none' }
  const markdown = await fs.readFile(bulbFile, 'utf-8')
  const base = assetsBase(parseBulb(markdown)?.files.get('config.json'))
  if (!base) return { kind: 'no-key', count: rels.length }
  // Probes run concurrently so a dead host costs one timeout, not one per file.
  const missing = (await Promise.all(rels.map(async rel => {
    const url = base + encodeRel(rel)
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

export type AssetsSyncResult =
  | { kind: 'skipped' }                                                        // nothing local, nothing remote
  | { kind: 'synced'; uploaded: number; unchanged: number; toDelete: string[]; base: string }
  | { kind: 'sync-error'; message: string }

/** The wire base all three asset verbs share (manifest GET, PUT, DELETE). */
const assetsWireBase = (t: PullTarget) =>
  `${t.origin}/u/${encodeURIComponent(t.userSlug)}/${encodeURIComponent(t.slug)}/assets`

/** TB-Assets-Push.md Invariant 4: sync the bulb's `assets/` folder to typebulb-hosted R2 as a
 *  one-gesture clobber — upload new/changed (skip byte-identical by MD5), and *plan* the
 *  deletion of remote keys with no local file. Deletions come back as `toDelete`, pruned only
 *  after the text PUT succeeds (Invariant 5: add → commit → prune — the old live text may still
 *  reference them). An *absent* folder is a consumer copy's no-opinion — remote untouched, no
 *  wire traffic; an *existing* folder, even empty, is the manifest. Runs only when config.json
 *  has no `assets` key (present key = self-host, verified by checkAssets — no third mode). */
export async function syncAssets(target: PullTarget, opts: { token: string; timeoutMs?: number }): Promise<AssetsSyncResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000
  const wireBase = assetsWireBase(target)
  const auth = { Authorization: `Bearer ${opts.token}` }

  const assetsDir = bulbAssetsDir(target.dest)
  // Absent folder = a consumer copy (pull never fetches folders): it has no asset opinion, so
  // touch nothing remote — and skip the wire entirely (the common asset-less push costs zero
  // requests). Deliberately emptying the remote takes an existing, empty assets/ folder.
  if (!await fs.stat(assetsDir).then(s => s.isDirectory()).catch(() => false)) return { kind: 'skipped' }
  const rels = await listFilesRec(assetsDir)

  let remote: { path: string; md5: string }[]
  try {
    const resp = await fetch(wireBase, { headers: auth, signal: AbortSignal.timeout(timeoutMs) })
    if (!resp.ok) {
      return { kind: 'sync-error', message: `manifest request failed (${resp.status}): ${errorFrom(await resp.text())}` }
    }
    remote = await resp.json()
  } catch (e) {
    return { kind: 'sync-error', message: e instanceof Error ? e.message : String(e) }
  }

  if (!rels.length && !remote.length) return { kind: 'skipped' }

  const remoteMd5 = new Map(remote.map(r => [r.path, r.md5]))
  const localSet = new Set(rels)
  const toDelete = remote.map(r => r.path).filter(p => !localSet.has(p))
  let uploaded = 0, unchanged = 0

  try {
    // Bounded concurrency, fail-fast: a refused file (quota, invalid path) aborts the sync and
    // with it the whole push. Uploads are safe before the commit point — the live text never
    // references a not-yet-referenced key.
    await mapLimit(rels, 4, async rel => {
      const bytes = await fs.readFile(path.join(assetsDir, ...rel.split('/')))
      if (remoteMd5.get(rel) === createHash('md5').update(bytes).digest('hex')) { unchanged++; return }
      const resp = await fetch(`${wireBase}/${encodeRel(rel)}`, {
        method: 'PUT', body: new Uint8Array(bytes),   // Buffer isn't BodyInit under DOM lib types
        headers: { ...auth, 'Content-Type': contentTypeFor(rel) },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!resp.ok) throw new Error(`upload of '${rel}' refused (${resp.status}): ${errorFrom(await resp.text())}`)
      uploaded++
    })
  } catch (e) {
    return { kind: 'sync-error', message: e instanceof Error ? e.message : String(e) }
  }

  return { kind: 'synced', uploaded, unchanged, toDelete, base: hostedAssetsBase(target.userSlug, target.slug) }
}

/** Prune remote orphans after the text PUT (add → commit → prune). Stops at the first failure:
 *  the push has already succeeded, so what remains is a harmless orphan key the next push
 *  re-plans — reported, never an exit code. */
export async function pruneAssets(target: PullTarget, rels: string[], opts: { token: string; timeoutMs?: number }): Promise<{ deleted: string[]; error?: string }> {
  const timeoutMs = opts.timeoutMs ?? 30_000
  const wireBase = assetsWireBase(target)
  const deleted: string[] = []
  for (const rel of rels) {
    try {
      const resp = await fetch(`${wireBase}/${encodeRel(rel)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${opts.token}` },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!resp.ok) return { deleted, error: `delete of '${rel}' refused (${resp.status}): ${errorFrom(await resp.text())}` }
      deleted.push(rel)
    } catch (e) {
      return { deleted, error: e instanceof Error ? e.message : String(e) }
    }
  }
  return { deleted }
}

/** Run `fn` over `items` with at most `limit` in flight; first rejection wins (rest may finish). */
async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items]
  const worker = async () => { for (let it = queue.shift(); it !== undefined; it = queue.shift()) await fn(it) }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

/** The assets leg of a push, before the text PUT (TB-Assets-Push.md Invariant 5: the site never
 *  dangles). An `assets` key = self-host: HEAD-verify, misses refuse (`--force` publishes anyway).
 *  No key = typebulb-hosted: sync the folder as a manifest; a sync failure refuses the push.
 *  Prints the story; returns whether the push may proceed, plus the orphan keys to prune once
 *  the text PUT has committed. */
async function assetsGate(target: PullTarget, token: string, force: boolean): Promise<{ proceed: boolean; toDelete?: string[] }> {
  const assets = await checkAssets(target.dest)
  if (assets.kind === 'missing') {
    console.error(`assets check against ${assets.base}`)
    for (const m of assets.missing) console.error(`  MISSING ${m.rel}  → expected at ${m.url}`)
    if (!force) {
      console.error(`push refused: ${assets.missing.length} of ${assets.count} asset(s) not on your host yet. Upload them, or push --force to publish anyway.`)
      return { proceed: false }
    }
    console.error('  continuing (--force): the published bulb will 404 on these until they are uploaded.')
  }
  if (assets.kind === 'verified') console.log(`assets: verified ${assets.count} file(s) against ${assets.base}`)
  if (assets.kind === 'no-key' || assets.kind === 'none') {
    const sync = await syncAssets(target, { token })
    if (sync.kind === 'sync-error') {
      console.error(`assets sync failed: ${sync.message}\npush refused: the bulb text was not pushed.`)
      return { proceed: false }
    }
    if (sync.kind === 'synced') {
      console.log(`assets: ${sync.uploaded} uploaded, ${sync.unchanged} unchanged → ${sync.base}`)
      return { proceed: true, toDelete: sync.toDelete }
    }
  }
  return { proceed: true }
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
  let toDelete: string[] | undefined
  try {
    const gate = await assetsGate(target, token, opts.force)
    if (!gate.proceed) {
      process.exitCode = 1
      return
    }
    toDelete = gate.toDelete
    outcome = await pushBulb(target, { token, force: opts.force })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error((e as NodeJS.ErrnoException)?.code === 'ENOENT' ? `File not found: ${rel}` : `Could not push to ${target.origin}: ${msg}`)
    process.exitCode = 1
    return
  }

  switch (outcome.kind) {
    case 'pushed': {
      console.log(`pushed ${rel} → ${bulbUrl}${outcome.created ? ' (created, unlisted)' : ''}`)
      if (outcome.serverStripped) console.log('note: the server.ts block was stripped on the server copy (CLI-only); your local file is untouched.')
      if (toDelete?.length) {
        const prune = await pruneAssets(target, toDelete, { token })
        for (const d of prune.deleted) console.log(`  deleted ${d} (no longer in assets/)`)
        if (prune.error) console.log(`note: asset cleanup incomplete — ${prune.error}; the next push will retry.`)
      }
      return
    }
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
