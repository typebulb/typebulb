import { normalizeBulbPath } from '../serve/paths.js'
import { listBulbServers, type BulbServer } from '../serve/serverRegistry.js'
import { bundledReadmePath, bundledDescriptionPath } from '../skill.js'

/**
 * Find the agent mirror serving THIS project, optionally narrowed to a specific agent (`agent:<name>`).
 *
 * Scope to the cwd, not the machine: a mirror reflects the cwd it was launched in (it tails that
 * project's CC sessions), so only a mirror for this cwd will render this agent's embeds — one open for
 * a *different* project is a false "up". Match on the registered launch cwd plus the entry's `agent`
 * field — a mirror has no project path to match on (TB-Agent-Mirror.md).
 * A pre-cwd entry (no `s.cwd`) can't be claimed, so it's skipped. With `agent`, match that mirror;
 * without, any mirror.
 */
export async function findProjectViewer(cwd: string, agent?: string): Promise<BulbServer | undefined> {
  const here = normalizeBulbPath(cwd)
  return (await listBulbServers()).find(s =>
    s.cwd != null && normalizeBulbPath(s.cwd) === here &&
    (agent ? s.agent === agent : s.agent != null))
}

/**
 * `typebulb agent` (no `:target`) — the first command an agent runs. It prints two sections
 * (TB-Skill.md): a **neutral status line** — the agent-mirror's URL when one is up,
 * or how to start one (`agent:claude --no-open`) when none is — phrased so it reads sensibly to agent
 * or user alike, then, after a blank line, an **`Agents:`-tagged directive** to read the authoring
 * skill (assembled via `typebulb skill`, or its two on-disk parts) before writing a bulb. The mirror
 * line is positioning needed up front, not after: it is the surface embedded bulbs render in, and its
 * localhost link opens the mirror. The status depends on whether a mirror is running **for this
 * project** — when one is, the line carries its URL so it can be opened without polling the mirror's
 * startup output. It always exits 0: this is a status report, and "no mirror running" is a normal,
 * benign state (a switched-off lamp isn't a broken one), not a failure an agent should treat as one.
 */
export async function runAgent(): Promise<void> {
  const viewer = await findProjectViewer(process.cwd())
  const running = viewer?.agent

  const status = running
    ? `Mirror '${running}' is up at ${viewer?.url} — the embedded bulbs render live there.`
    : 'No mirror is running — to render embedded bulbs live inline, start one with ' +
      '`npx typebulb agent:claude --no-open`; it prints a localhost link that opens the mirror.'
  const lines = [
    status,
    '',
    'Agents: Read the bulb-authoring skill before writing a bulb — get it assembled as one SKILL.md ' +
    'with `npx typebulb skill`, or read its parts directly:',
    `  - description: ${bundledDescriptionPath()}`,
    `  - skill body (the README is the skill): ${bundledReadmePath()}`,
  ]
  process.stdout.write(lines.join('\n') + '\n')
}
