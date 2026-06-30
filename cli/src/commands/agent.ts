import { launchAgentViewer, type BulbServer } from '../serve/serverRegistry.js'
import { resolveAgent } from '../agentViewer/resolve.js'
import { bundledReadmePath, bundledDescriptionPath } from '../skill.js'

/**
 * `typebulb agent` (no `:target`) — the first command an agent runs. It prints (TB-Skill.md) a status
 * line carrying this project's mirror URL — a live mirror is reused, otherwise one is started detached
 * and windowless (`agent:<name> --no-open`) — and an `Agents:`-tagged block: the embed-vs-local rule
 * (the one decision agents most often get wrong — a weak model that under-reads the skill plans a
 * `.bulb.md` when asked to show something inline; this line is the guaranteed-delivery fix), how to verify an emitted embed (a *backgrounded* `wait` — the
 * render lands only on turn-end, so a foreground or pre-emit wait would deadlock; backgrounding fixes
 * both halves), and a directive to read the authoring skill before writing a bulb (delivery in `skill`
 * below). Every line is ≤57 chars — agents often run in narrow panes, where a longer line garbles. It launches
 * rather than instructs because the user's kickoff sentence pre-approves exactly one command: stdout
 * answering "now run `agent:claude --no-open`" would send the agent back through the permission layer with a
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

  // ANSI only when stdout is a real terminal — piped output (what the agent reads) stays clean. `lit`
  // (a bright "bulb-on" green) marks the actionable artifacts — what you *do*: the URL to click, the
  // commands to run, the file paths to open. Prose, headings, and decoration stay plain, so the eye
  // lands on the do-able tokens. No `dim` tier: lighting what's actionable is enough; dimming the rest
  // only bought per-line guesswork. Only the URL adds underline — it's the one genuine link/click.
  const tty = process.stdout.isTTY === true
  const sgr = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s)
  const lit = sgr('1;92'), litLink = sgr('1;4;92')   // bold bright green; the link adds underline
  const brand = sgr('38;5;135')                      // brand-color tint (purple) for the version banner

  // Read-the-skill directive, shared by both cases. The direct file paths are ESSENTIAL: the agent reads
  // them with its (ungated) Read tool, whereas `npx typebulb skill` is a Bash command the host's
  // permission classifier can gate. They're read by the agent, not clicked by a human, so they stay
  // plain — but don't drop them to save their npm-cache length; losing the no-prompt read route regresses.
  const skill = [
    `    Read the authoring skill before writing a bulb:`,
    `      • ${lit('npx typebulb skill')} — assembles one SKILL.md`,
    `      • or, open its parts:`,
    `          ${lit(bundledDescriptionPath())}`,
    `          ${lit(bundledReadmePath())}`,
  ]

  const body = viewer
    ? [
        `  Agent mirror is live`,
        `    ${lit('●')} ${litLink(viewer.url)}`,
        `      Embedded bulbs render live here.`,
        `  Agents:`,
        `    Reusable app/tool → write a ${lit('.bulb.md')}`,
        `    Show something inline → embed a bulb`,
        `      after emitting the bulb, background a wait:`,
        `      • ${lit('typebulb wait agent --match "[embed <name>"')}`,
        ...skill,
        `    End your reply with the mirror link above`,
        `      • easy to miss the link mid-message`,
      ]
    : [
        `  The mirror did not start (${failed})`,
        `    ● Start it manually: ${lit(`npx typebulb agent:${name}`)}`,
        `  Agents:`,
        ...skill,
      ]
  // A quiet version banner heads the entry-point command: npx may serve a cached build, so it
  // disambiguates which typebulb is actually running (TB-CLI build hygiene).
  const lines = [`  ${brand(`typebulb v${version}`)}`, ...body, '']
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
  const lit = sgr('1;92'), brand = sgr('38;5;135')
  const lines = [
    `  ${brand(`typebulb v${version}`)}`,
    `  This project has sessions for more than one agent harness.`,
    `    Open the mirror for the one you want:`,
    ...names.map(n => `      • ${lit(`npx typebulb agent:${n}`)}`),
    '',
  ]
  process.stdout.write(lines.join('\n') + '\n')
}
