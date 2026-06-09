/**
 * Shared filesystem locations and the canonical bulb-path key. The server registry and the trust
 * store are siblings under one per-user home, so the home + the path-normalizer live here once
 * rather than being re-derived in each (which let them silently drift).
 */

import { realpathSync } from 'fs'
import { join, resolve } from 'path'
import { homedir } from 'os'

/**
 * Per-user typebulb home (`~/.typebulb`, the OS account's home via `os.homedir()` — NOT shared
 * across accounts). `TYPEBULB_SERVERS_DIR` points AT the servers dir, so home is its parent — one
 * env var redirects the registry and the trust store (a sibling file) together, which is what a
 * test that sets it relies on.
 */
export function typebulbHome(): string {
  const reg = process.env.TYPEBULB_SERVERS_DIR
  return reg ? join(reg, '..') : join(homedir(), '.typebulb')
}

/** The running-server registry dir (`~/.typebulb/servers`), overridable via `TYPEBULB_SERVERS_DIR`. */
export function serversDir(): string {
  return process.env.TYPEBULB_SERVERS_DIR || join(typebulbHome(), 'servers')
}

/**
 * Canonical key for a bulb file: resolved to absolute, case-canonicalized through the real
 * filesystem (`realpathSync.native`), forward-slashed. The one form used to compare and store bulb
 * paths across the registry and the trust store, so a path typed two ways still matches.
 *
 * Case matters because the key is security-bearing (trust membership): on a case-insensitive volume
 * (win32 always; macOS's default APFS) two casings of one file must collapse to one key, or an
 * `untrust` typed in a different casing silently no-ops and leaves the bulb Trusted (a fail-open).
 * Asking the FS for the on-disk path is volume-correct where a per-platform lowercase is not — a
 * macOS volume can be configured case-sensitive. When the file isn't on disk yet realpath throws, so
 * we fall back to the resolved string (lowercased on win32 to keep case-insensitive matching there).
 */
export function normalizeBulbPath(file: string): string {
  const abs = resolve(file)
  let real = abs
  try { real = realpathSync.native(abs) } catch { /* not on disk yet — keep the resolved string */ }
  return (process.platform === 'win32' ? real.toLowerCase() : real).replace(/\\/g, '/')
}

/**
 * Is `file` part of the project rooted at `cwd`? Used to scope running-bulb *listings* to the
 * current project — claude.bulb mirrors a CC project (cwd), so its launcher and the CLI's no-arg
 * `logs`/`stop` lists should show that project's bulbs, not every bulb on the machine. Mirrors the
 * file walk's scope: under cwd, `node_modules` excluded — which also drops a running claude.bulb
 * (it lives in the npx cache or `node_modules/typebulb`, never a project's own tree). Explicit
 * pid/file targeting stays global; only discovery is scoped.
 */
export function isUnderProject(file: string, cwd: string): boolean {
  const f = normalizeBulbPath(file)
  const root = normalizeBulbPath(cwd)
  if (!f.startsWith(root.endsWith('/') ? root : root + '/')) return false
  return !f.includes('/node_modules/')
}
