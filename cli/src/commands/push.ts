import * as fs from 'fs/promises'
import * as path from 'path'
import { hostedAssetsBase } from 'typebulb/format'
import { assetsWireBase, bulbMdUrl, encodeRel, errorFrom, fetchAssetManifest, mapLimit, md5hex, resolveTarget, type PullTarget } from './pull.js'
import { bulbAssetsDir } from '../pipeline.js'

/**
 * `typebulb push <file>` — upload one conventional local bulb to typebulb.com as the authed
 * user (TB-Push-Pull.md). The wire is the raw `.bulb.md` PUT twin of pull's GET; auth is the
 * TYPEBULB_TOKEN personal access token. Stateless staleness guard: the file's mtime — stamped
 * to the server's updatedAt by pull and by every successful push — rides as If-Unmodified-Since,
 * and the server 409s if the remote changed after it. --force omits the header (the deliberate
 * clobber). The server strips `server.ts` (CLI-only) and says so; the local file never changes.
 */

export type PushOutcome =
  | { kind: 'pushed'; created: boolean; serverStripped: boolean; updatedAt: number; assets?: AssetsSummary }
  | { kind: 'conflict'; message: string; assets?: AssetsSummary }
  | { kind: 'http-error'; status: number; message: string; assets?: AssetsSummary }
  | { kind: 'asset-error'; message: string }

/** What the push did about assets, when the bulb has an `assets/` folder opinion at all.
 *  `deleted`/`pruneError` are filled only on `pushed` — orphans prune after the commit point. */
export type AssetsSummary = { uploaded: number; unchanged: number; deleted: string[]; base: string; pruneError?: string }

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

export type AssetsSyncResult =
  | { kind: 'skipped' }                                                        // nothing local, nothing remote
  | { kind: 'synced'; uploaded: number; unchanged: number; toDelete: string[]; base: string }
  | { kind: 'sync-error'; message: string }

/** TB-Assets-Push.md Invariant 4: sync the bulb's `assets/` folder to typebulb-hosted R2 as a
 *  one-gesture clobber — upload new/changed (skip byte-identical by MD5), and *plan* the
 *  deletion of remote keys with no local file. Deletions come back as `toDelete`, pruned only
 *  after the text PUT succeeds (Invariant 5: add → commit → prune — the old live text may still
 *  reference them). An *absent* folder is a consumer copy's no-opinion — remote untouched, no
 *  wire traffic; an *existing* folder, even empty, is the manifest. */
export async function syncAssets(target: PullTarget, opts: { token: string; timeoutMs?: number }): Promise<AssetsSyncResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000
  const wireBase = assetsWireBase(target)
  const auth = { Authorization: `Bearer ${opts.token}` }

  const assetsDir = bulbAssetsDir(target.dest)
  // Absent folder = no asset opinion: touch nothing remote, skip the wire entirely (the common
  // asset-less push costs zero requests). Pull materializes the folder now, so this is the rare
  // hand-copied case; deliberately emptying the remote takes an existing, empty assets/ folder.
  if (!await fs.stat(assetsDir).then(s => s.isDirectory()).catch(() => false)) return { kind: 'skipped' }
  const rels = await listFilesRec(assetsDir)

  const manifest = await fetchAssetManifest(target, { token: opts.token, timeoutMs })
  if ('error' in manifest) return { kind: 'sync-error', message: manifest.error }
  const remote = manifest.entries

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
      if (remoteMd5.get(rel) === md5hex(bytes)) { unchanged++; return }
      // No Content-Type header: the server derives the stored type from the extension
      // (TB-Assets-Push.md Invariant 9) — a client-asserted MIME is never trusted.
      const resp = await fetch(`${wireBase}/${encodeRel(rel)}`, {
        method: 'PUT', body: new Uint8Array(bytes),   // Buffer isn't BodyInit under DOM lib types
        headers: auth,
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

/** The whole transfer — assets and text — separated from CLI messaging/exit codes so every caller
 *  gets it (TB-Assets-Push.md Invariant 11: assets follow every gesture; the mirror's push icon
 *  calls this directly, and leaving the asset legs in `runPush` made that gesture text-only).
 *  Ordering is Invariant 5: sync uploads before the text PUT, prune orphans only after it commits;
 *  an asset sync failure refuses the push before the text moves. */
export async function pushBulb(target: PullTarget, opts: { token: string; force?: boolean; timeoutMs?: number }): Promise<PushOutcome> {
  const markdown = await fs.readFile(target.dest, 'utf-8')
  const { mtime } = await fs.stat(target.dest)

  const sync = await syncAssets(target, { token: opts.token, timeoutMs: opts.timeoutMs })
  if (sync.kind === 'sync-error') return { kind: 'asset-error', message: sync.message }
  const assets: AssetsSummary | undefined = sync.kind === 'synced'
    ? { uploaded: sync.uploaded, unchanged: sync.unchanged, deleted: [], base: sync.base }
    : undefined

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
  if (resp.status === 409) return { kind: 'conflict', message: errorFrom(body), assets }
  if (!resp.ok) return { kind: 'http-error', status: resp.status, message: errorFrom(body), assets }

  const r = JSON.parse(body) as { id: string; updatedAt: number; created: boolean; serverStripped: boolean }
  // Stamp mtime = the server's updatedAt: an unedited re-push stays non-stale, a remote edit
  // after this moment is stale. mtime IS the last-synced marker — no sidecar (Invariant 5).
  await fs.utimes(target.dest, new Date(), new Date(r.updatedAt))
  if (assets && sync.kind === 'synced' && sync.toDelete.length) {
    const prune = await pruneAssets(target, sync.toDelete, { token: opts.token, timeoutMs: opts.timeoutMs })
    assets.deleted = prune.deleted
    if (prune.error) assets.pruneError = prune.error
  }
  return { kind: 'pushed', created: r.created, serverStripped: r.serverStripped, updatedAt: r.updatedAt, assets }
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
    outcome = await pushBulb(target, { token, force: opts.force })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error((e as NodeJS.ErrnoException)?.code === 'ENOENT' ? `File not found: ${rel}` : `Could not push to ${target.origin}: ${msg}`)
    process.exitCode = 1
    return
  }

  if (outcome.kind !== 'asset-error' && outcome.assets)
    console.log(`assets: ${outcome.assets.uploaded} uploaded, ${outcome.assets.unchanged} unchanged → ${outcome.assets.base}`)

  switch (outcome.kind) {
    case 'asset-error':
      console.error(`assets sync failed: ${outcome.message}\npush refused: the bulb text was not pushed.`)
      process.exitCode = 1
      return
    case 'pushed': {
      console.log(`pushed ${rel} → ${bulbUrl}${outcome.created ? ' (created, unlisted)' : ''}`)
      if (outcome.serverStripped) console.log('note: the server.ts block was stripped on the server copy (CLI-only); your local file is untouched.')
      for (const d of outcome.assets?.deleted ?? []) console.log(`  deleted ${d} (no longer in assets/)`)
      if (outcome.assets?.pruneError) console.log(`note: asset cleanup incomplete — ${outcome.assets.pruneError}; the next push will retry.`)
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
