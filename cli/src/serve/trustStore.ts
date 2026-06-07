/**
 * Per-machine trust memory: which bulbs have been elevated to Trusted, so a later run doesn't
 * re-require `--trust`. This is the *policy* layer that pairs with the CLI's trust *gate* (the
 * enforcement, in server.ts) — moved here, into the CLI, so it isn't a GUI concern: an agent can
 * query and set it from the terminal (`typebulb trust`/`untrust`), and a bare `typebulb <file>`
 * honours a remembered decision. claude.bulb's launcher delegates to this same store, so the GUI
 * and the CLI share one source of truth instead of two.
 *
 * Global (one list across projects), a sibling of the server registry under ~/.typebulb/. Keys are
 * absolute, normalized paths (lowercased on win32 — case-insensitive FS — and forward-slashed).
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
  mkdirSync(typebulbHome(), { recursive: true })
  writeFileSync(trustPath(), JSON.stringify([...set]))
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
