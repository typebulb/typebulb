// Parity #12 (TB-Agent-Composer-Parity.md): RPC pi never shows the TUI trust prompt — with no
// stored decision and defaultProjectTrust unset it silently runs the project UNTRUSTED (.pi
// extensions/settings/skills don't load). This mirrors pi's own gate (dist/core/project-trust.js +
// trust-manager.js, verified 0.80.3) read-only, to surface that one silent case as a boot notice.
import { existsSync, readFileSync, realpathSync } from 'fs'
import { join, dirname, resolve } from 'path'
import { homedir } from 'os'

// pi's TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES — entries under <cwd>/.pi that gate on trust.
const TRUST_REQUIRING = ['settings.json', 'extensions', 'skills', 'prompts', 'themes', 'SYSTEM.md', 'APPEND_SYSTEM.md']

// pi's canonicalizePath: realpath when it exists, the raw (resolved) path otherwise.
const canonical = (p: string) => { try { return realpathSync(p) } catch { return p } }

const readJson = (file: string): Record<string, unknown> => {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return {} }
}

// pi's hasTrustRequiringProjectResources: <cwd>/.pi/<entry>, or .agents/skills in cwd/an ancestor
// (the user-global ~/.agents/skills is always-trusted and doesn't count).
function hasTrustRequiringResources(cwd: string, home: string): boolean {
  const piDir = join(cwd, '.pi')
  if (TRUST_REQUIRING.some(e => existsSync(join(piDir, e)))) return true
  const userSkills = join(home, '.agents', 'skills')
  for (let dir = cwd; ;) {
    const skills = join(dir, '.agents', 'skills')
    if (skills !== userSkills && existsSync(skills)) return true
    const parent = dirname(dir)
    if (parent === dir) return false
    dir = parent
  }
}

// pi's findNearestTrustEntry: any true/false on cwd or an ancestor is a remembered decision.
function hasDecision(trust: Record<string, unknown>, cwd: string): boolean {
  for (let dir = cwd; ;) {
    if (trust[dir] === true || trust[dir] === false) return true
    const parent = dirname(dir)
    if (parent === dir) return false
    dir = parent
  }
}

/** Non-null exactly when driven pi will silently fall back to untrusted: the project HAS
 *  trust-requiring resources, no trust.json decision covers it, and defaultProjectTrust is
 *  unset/'ask' (an explicit 'always'/'never' is the user's own configured default). Never throws. */
export function trustNotice(cwd: string, opts?: { agentDir?: string; home?: string }): string | null {
  try {
    const agentDir = opts?.agentDir ?? join(homedir(), '.pi', 'agent')
    const home = canonical(opts?.home ?? process.env.HOME ?? homedir())
    const dir = canonical(resolve(cwd))
    if (!hasTrustRequiringResources(dir, home)) return null
    const setting = readJson(join(agentDir, 'settings.json')).defaultProjectTrust
    if (setting === 'always' || setting === 'never') return null
    if (hasDecision(readJson(join(agentDir, 'trust.json')), dir)) return null
    return 'pi has no trust decision for this project — running untrusted; run `pi` once in a terminal to grant it'
  } catch { return null }
}
