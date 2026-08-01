/**
 * Per-user trust memory: which bulbs this OS account has elevated to Trusted, so a later run doesn't
 * re-require `--trust`. This is the *policy* layer that pairs with the CLI's trust *gate* (the
 * enforcement, in server.ts) — moved here, into the CLI, so it isn't a GUI concern: an agent can
 * query and set it from the terminal (`typebulb trust`/`untrust`), and a bare `typebulb <file>`
 * honours a remembered decision. claude.bulb's launcher delegates to this same store, so the GUI
 * and the CLI share one source of truth instead of two.
 *
 * Scope is per-user and cross-project: one list spanning all of this account's projects, stored
 * under the OS account's home (~/.typebulb/, a sibling of the server registry). NOT per-machine —
 * a second OS account (its own homedir) has its own store and inherits nothing. Keys are absolute,
 * normalized paths, case-canonicalized through the real filesystem so two casings of one file can't
 * split a trust decision on a case-insensitive volume (see normalizeBulbPath).
 * Written ONLY by explicit user/agent action; never by bulb code (a bulb can't grant itself trust).
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { typebulbHome, normalizeBulbPath } from './paths.js'

// trust.json sits beside the servers/ dir (not inside it) under the shared home, so one
// TYPEBULB_SERVERS_DIR override redirects both.
function trustPath(): string {
  return join(typebulbHome(), 'trust.json')
}

function readSet(): Set<string> {
  try {
    const arr = JSON.parse(readFileSync(trustPath(), 'utf8'))
    return new Set(Array.isArray(arr) ? (arr as string[]) : [])
  } catch {
    return new Set() // absent / unreadable ⇒ nothing trusted
  }
}

function writeSet(set: Set<string>): void {
  // Loud, unlike the home's bookkeeping writes (TB-CLI.md): this store's entire job is to persist
  // a user decision, so an unwritable home is an error here, never a silent degradation.
  try {
    mkdirSync(typebulbHome(), { recursive: true })
    writeFileSync(trustPath(), JSON.stringify([...set]))
  } catch (e) {
    throw new Error(`can't write ${trustPath()} — trust not remembered (unwritable home; sandboxed shell?): ${(e as Error).message}`)
  }
}

/** Is this bulb remembered as Trusted? */
export function isBulbTrusted(file: string): boolean {
  return readSet().has(normalizeBulbPath(file))
}

/** Set or clear a bulb's remembered trust. Idempotent; only ever called by a user/agent action. */
export function setBulbTrusted(file: string, trust: boolean): void {
  const set = readSet()
  const key = normalizeBulbPath(file)
  if (trust ? set.has(key) : !set.has(key)) return // no change
  if (trust) set.add(key); else set.delete(key)
  writeSet(set)
}

/** Every remembered-trusted bulb path (absolute, normalized). */
export function listTrustedBulbs(): string[] {
  return [...readSet()]
}
