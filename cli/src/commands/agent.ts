import * as readline from 'readline'
import { launchAgentViewer, type BulbServer } from '../serve/serverRegistry.js'
import { resolveAgent } from '../agentViewer/resolve.js'
import { bundledReadmePath, bundledDescriptionPath } from '../skill.js'

/**
 * The one place the CLI's colors are defined. ANSI only when stdout is a real terminal — piped output
 * (what the agent reads) stays clean. `lit` (a warm "bulb-on" lime) marks the actionable artifacts —
 * what you *do*: the URL to click, the commands to run, the file paths to open. Prose, headings, and
 * decoration stay plain, so the eye lands on the do-able tokens. No `dim` tier: lighting what's
 * actionable is enough. Only the URL adds underline — it's the one genuine link/click. `brand` tints
 * the version banner (purple). Pass `tty=false` to no-op every code (the piped-output path).
 */
function palette(tty: boolean) {
  const sgr = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s)
  return { lit: sgr('38;5;70'), litLink: sgr('4;38;5;70'), brand: sgr('38;5;135') }
}

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
 * The pi extension's TB_MIRROR_BLOCK (agents/pi/server/piExtension.ts) re-delivers this block's lines into
 * mirror-driven (composer) sessions via the system prompt. The wording here is hard-won — if a line
 * changes, change it there too; don't let the two drift into paraphrase.
 *
 * The harness is RESOLVED, not hardcoded (resolveAgent): the agent that ran the command is detected
 * from its env marker, so a pi agent gets the pi mirror and a Claude agent the Claude mirror off the
 * one universal command. Only when the caller is a human AND more than one harness is installed on the
 * machine is there nothing decisive to go on: on an interactive terminal that asks (then launches the
 * pick like any resolved run), the picker ordered so this cwd's active harness is the Enter default;
 * off a TTY it prints a pick-one message (still exit 0) instead of launching.
 */
export async function runAgent(version: string): Promise<void> {
  const choice = resolveAgent(process.cwd())
  if ('ambiguous' in choice) {
    // A human in a multi-harness project. On an interactive terminal, ask — then launch like any
    // resolved run (same detached spawn, same async exit-0 report), which restores the bare-`agent`
    // ergonomics the printed pick-one message threw away. Off a TTY (piped/CI) there's no one to ask,
    // so fall back to that message. An agent caller never reaches here (it's resolved by its env marker
    // at step 1), so this prompt is human-only by construction; the isTTY gate is a second guard.
    const picked = await promptHarness(version, choice.ambiguous)
    if (!picked) return printAmbiguous(version, choice.ambiguous)
    return launchAndReport(version, picked)
  }
  return launchAndReport(version, choice.name)
}

/**
 * Launch (or reuse) the resolved harness's mirror and print the status report. Shared by the resolved
 * path and the post-prompt path, so an interactively-picked harness gets the identical detached launch
 * and async exit-0 report as an env-marker-resolved one.
 */
async function launchAndReport(version: string, name: string): Promise<void> {
  let viewer: BulbServer | undefined
  let failed: string | undefined
  try {
    viewer = await launchAgentViewer(name)
  } catch (e) {
    failed = e instanceof Error ? e.message : String(e)
  }

  const { lit, litLink, brand } = palette(process.stdout.isTTY === true)

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
        `  Agent mirror (${name}) is live💡`,
        `    ${lit('●')} ${litLink(viewer.url)}`,
        `      Embedded bulbs render live here.`,
        `  Agents:`,
        `    Reusable app/tool → write a ${lit('.bulb.md')}`,
        `    Show something inline → embed a bulb`,
        // "background" told pi agents to shell-'&' the wait, decoupling the wake (TB-Wait.md).
        name === 'pi'
          ? `      arm a wait for its render verdict — run it plainly:`
          : `      background a wait for its render verdict:`,
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
 * Interactive disambiguation for the ambiguous branch — TTY-only. Returns the chosen harness name, or
 * `undefined` to defer to the printed message (no terminal to prompt on, or no usable answer). One shot,
 * no re-ask loop: Enter takes the default (first), a number picks by position, a bare harness name picks
 * directly. Reachable only by a human — an agent is resolved by its env marker before this point — and
 * the stdin/stdout `isTTY` gate is the belt-and-suspenders second check that keeps it off any agent.
 */
async function promptHarness(version: string, names: string[]): Promise<string | undefined> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return undefined
  const { lit, brand } = palette(true)   // reached only on a TTY (guarded above)
  const menu = [
    `  ${brand(`typebulb v${version}`)}`,
    `  More than one agent harness is available here.`,
    ...names.map((n, i) => `      ${lit(String(i + 1))}) ${n}`),
    '',
  ]
  process.stdout.write(menu.join('\n') + '\n')
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = (await new Promise<string>(res => rl.question('  Open which? [1]: ', res))).trim()
    if (answer === '') return names[0]                          // Enter ⇒ default (first registered)
    const n = Number(answer)
    if (Number.isInteger(n) && n >= 1 && n <= names.length) return names[n - 1]
    return names.find(name => name === answer.toLowerCase())    // a harness name typed directly, or undefined
  } finally {
    rl.close()
  }
}

/**
 * The non-TTY fallback for the one branch where bare `agent` can't resolve a harness: a human (no env
 * marker) with more than one harness in play (sessions here, or installed on a fresh project), and no terminal
 * to prompt on (`promptHarness` returned undefined). Nothing to guess from, so name the explicit commands
 * and let the user choose. Still exit 0 — like the rest of `runAgent`, this is a status report, not a
 * failure. (An agent caller never reaches here: it's detected by its env marker.)
 */
function printAmbiguous(version: string, names: string[]): void {
  const { lit, brand } = palette(process.stdout.isTTY === true)
  const lines = [
    `  ${brand(`typebulb v${version}`)}`,
    `  More than one agent harness is available here.`,
    `    Open the mirror for the one you want:`,
    ...names.map(n => `      • ${lit(`npx typebulb agent:${n}`)}`),
    '',
  ]
  process.stdout.write(lines.join('\n') + '\n')
}
