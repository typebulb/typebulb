import { existsSync } from 'fs'
import { join } from 'path'
import { typebulbBinPath } from '../../../src/servers.js'
import { readJsonFile, writeJsonFile, ensureGitignored } from './switcher.js'

// Babysit under Claude Code's Stop hook (TB-Agent-Babysit.md § Lifecycle): CC starts it after each turn
// and its exit 2 wakes the session, so the agent arms nothing.
const ARGS = 'babysit --hook'
// Seconds. CC's default of 600 ends a hook mid-watch; this is babysit's own 12-hour cap.
const TIMEOUT_S = 12 * 60 * 60

const settingsFile = (project: string) => join(project, '.claude', 'settings.local.json')
const quoted = (p: string) => `"${p.replace(/\\/g, '/')}"`
const ours = (group: any) => Array.isArray(group?.hooks) && group.hooks.some((h: any) => typeof h?.command === 'string' && h.command.endsWith(ARGS))

/** `settings` with the hook in place under `Stop`, its other hooks kept; undefined when it already is. */
export function withBabysitHook(settings: any, command: string): any | undefined {
  const want = { hooks: [{ type: 'command', command, asyncRewake: true, timeout: TIMEOUT_S }] }
  const stop: any[] = Array.isArray(settings?.hooks?.Stop) ? settings.hooks.Stop : []
  const at = stop.findIndex(ours)
  if (at >= 0 && JSON.stringify(stop[at]) === JSON.stringify(want)) return undefined
  return { ...settings, hooks: { ...settings?.hooks, Stop: at >= 0 ? stop.map((g, i) => i === at ? want : g) : [...stop, want] } }
}

export const hasBabysitHook = (project: string) => !!readJsonFile(settingsFile(project))?.hooks?.Stop?.some?.(ours)

/** Keep the hook in the project's local settings, on this typebulb. Idempotent by content; never throws. */
export function ensureBabysitHook(project: string): void {
  try {
    const file = settingsFile(project)
    const existed = existsSync(file)
    const settings = existed ? readJsonFile(file) : {}
    // Unparsable settings are the user's to fix, never ours to overwrite.
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return
    const next = withBabysitHook(settings, `${quoted(process.execPath)} ${quoted(typebulbBinPath())} ${ARGS}`)
    if (!next) return
    writeJsonFile(file, next)
    if (!existed && existsSync(join(project, '.gitignore')))
      ensureGitignored(project, ['.claude/settings.local.json'], '# typebulb (local Claude Code settings)')
  } catch {}
}
