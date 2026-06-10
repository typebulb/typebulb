import { listAgentNames } from '../agentViewer/registry.js'
import { launchAgentViewer, type BulbServer } from '../serve/serverRegistry.js'
import { bundledReadmePath, bundledDescriptionPath } from '../skill.js'

/**
 * `typebulb agent` (no `:target`) — the first command an agent runs. It prints two sections
 * (TB-Skill.md): a **neutral status line** carrying this project's mirror URL — a live mirror is
 * reused, otherwise one is started detached and windowless (`agent:<name> --no-open`) — then, after
 * a blank line, an **`Agents:`-tagged directive** to read the authoring skill (assembled via
 * `typebulb skill`, or its two on-disk parts) before writing a bulb. It launches rather than
 * instructs because the user's kickoff sentence pre-approves exactly one command: stdout answering
 * "now run `agent:claude --no-open`" would send the agent back through the permission layer with a
 * command that approval never covered. It always exits 0: this is a status report, and even a launch
 * that failed is reported (with the manual command), never signalled as an error exit.
 */
export async function runAgent(): Promise<void> {
  const [name] = listAgentNames() // the sole registered agent — nothing to select (TB-Skill.md)
  let viewer: BulbServer | undefined
  let failed: string | undefined
  try {
    viewer = await launchAgentViewer(name)
  } catch (e) {
    failed = e instanceof Error ? e.message : String(e)
  }

  const status = viewer
    ? `Mirror '${name}' is up at ${viewer.url} — the embedded bulbs render live there.`
    : `The mirror did not start (${failed}) — start it manually with \`npx typebulb agent:${name}\`.`
  const lines = [
    status,
    '',
    'Agents: Read the bulb-authoring skill before writing a bulb — get it assembled as one SKILL.md ' +
    'with `npx typebulb skill`, or read its parts directly:',
    `  - description: ${bundledDescriptionPath()}`,
    `  - skill body (the README is the skill): ${bundledReadmePath()}`,
    "Agents: End your reply with the mirror link — it is the user's next click, and a link buried " +
    'mid-message gets missed.',
  ]
  process.stdout.write(lines.join('\n') + '\n')
}
