import { launchAgentViewer, type BulbServer } from '../serve/serverRegistry.js'
import { resolveAgent } from '../agentViewer/resolve.js'
import { bundledReadmePath, bundledDescriptionPath } from '../skill.js'

/**
 * `typebulb agent` (no `:target`) — the first command an agent runs. It prints (TB-Skill.md) a status
 * line carrying this project's mirror URL — a live mirror is reused, otherwise one is started detached
 * and windowless (`agent:<name> --no-open`) — and an `Agents:`-tagged directive to read the authoring
 * skill before writing a bulb (delivery details in the `skill` block below). It launches rather than
 * instructs because the user's kickoff sentence pre-approves exactly one command: stdout answering
 * "now run `agent:claude --no-open`" would send the agent back through the permission layer with a
 * command that approval never covered. It always exits 0: this is a status report, and even a launch
 * that failed is reported (with the manual command), never signalled as an error exit.
 *
 * The harness is RESOLVED, not hardcoded (resolveAgent): the agent that ran the command is detected
 * from its env marker, so a pi agent gets the pi mirror and a Claude agent the Claude mirror off the
 * one universal command. Only when the caller is a human AND two harnesses have sessions here is there
 * nothing to go on — that prints a pick-one message (still exit 0) instead of launching.
 */
export async function runAgent(version: string): Promise<void> {
  const choice = await resolveAgent(process.cwd())
  if ('ambiguous' in choice) return printAmbiguous(version, choice.ambiguous)
  const name = choice.name
  let viewer: BulbServer | undefined
  let failed: string | undefined
  try {
    viewer = await launchAgentViewer(name)
  } catch (e) {
    failed = e instanceof Error ? e.message : String(e)
  }

  // Minimal ANSI, applied only when stdout is a real terminal. When the agent harness captures stdout
  // (piped, not a TTY) the text stays clean for the model to read — so color is purely the human's
  // terminal nicety, never noise in the tool result.
  const tty = process.stdout.isTTY === true
  const sgr = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s)
  // One emphasis per screen: bold marks the actionable target — the URL to click (live) or the command
  // to run (failed). The headline is just orientation, so it stays regular. `link` is the URL: bold on
  // top of underlined cyan, so the click target is the one thing the eye lands on.
  const bold = sgr('1'), dim = sgr('2'), green = sgr('32'), yellow = sgr('33'), link = sgr('1;4;36')

  // Read-the-skill directive, shared by both the live and failed cases (an agent can author a bulb
  // either way; only the mirror link is conditional on a live mirror). The direct file paths are
  // ESSENTIAL, not a nicety: the agent reads them with its (ungated) Read tool, whereas `npx typebulb
  // skill` is a Bash command the host's permission classifier can gate or prompt on. Do NOT drop the
  // paths to avoid their deployed npm-cache length — the wrap is cosmetic only (the agent gets each
  // path as one clean line over non-TTY stdout); losing the no-prompt read route is a real regression.
  const skill = [
    `    Read the authoring skill before writing a bulb:`,
    `      ${dim('•')} npx typebulb skill ${dim('— assembles one SKILL.md')}`,
    `      ${dim('•')} or, open its parts:`,
    `          ${dim(bundledDescriptionPath())}`,
    `          ${dim(bundledReadmePath())}`,
  ]

  const body = viewer
    ? [
        `  Agent mirror is live`,
        `    ${green('●')} ${link(viewer.url)}`,
        `      ${dim('Embedded bulbs in CC sessions render live here.')}`,
        `  Agents:`,
        ...skill,
        `    End your reply with the mirror link above`,
        `      ${dim('•')} ${dim('easy to miss the link mid-message')}`,
      ]
    : [
        `  The mirror did not start ${dim(`(${failed})`)}`,
        `    ${yellow('●')} Start it manually: ${bold(`npx typebulb agent:${name}`)}`,
        `  Agents:`,
        ...skill,
      ]
  // A quiet version banner heads the agent's entry-point command: `npx` may serve a cached build, so
  // it disambiguates which typebulb is actually running (TB-CLI build hygiene).
  const lines = [`  ${dim(`typebulb v${version}`)}`, ...body, '']
  process.stdout.write(lines.join('\n') + '\n')
}

/**
 * The one branch where bare `agent` can't resolve a harness: a human (no env marker) in a project with
 * sessions for more than one harness, no mirror yet running. There's nothing to guess from, so name the
 * explicit commands and let the user choose. Still exit 0 — like the rest of `runAgent`, this is a
 * status report, not a failure. (An agent caller never reaches here: it's detected by its env marker.)
 */
function printAmbiguous(version: string, names: string[]): void {
  const tty = process.stdout.isTTY === true
  const sgr = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s)
  const dim = sgr('2'), bold = sgr('1')
  const lines = [
    `  ${dim(`typebulb v${version}`)}`,
    `  This project has sessions for more than one agent harness.`,
    `    Open the mirror for the one you want:`,
    ...names.map(n => `      ${dim('•')} ${bold(`npx typebulb agent:${n}`)}`),
    '',
  ]
  process.stdout.write(lines.join('\n') + '\n')
}
