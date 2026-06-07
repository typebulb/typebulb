/**
 * Cross-platform editor launcher — the agent-agnostic sibling of browser.ts's openBrowser.
 * Any mirror bulb that renders file citations wants click-to-open, so the detached-spawn
 * boilerplate and editor resolution live here once rather than being re-derived per mirror.
 */

import { spawn } from 'child_process'
import { basename } from 'path'

// The editor to open file citations in: VS Code (`code`) by default — claude.bulb's mirror runs in a
// VS Code context, and `code` also fronts the Cursor/codium-family forks. Overridable ONLY by the
// typebulb-specific `TYPEBULB_EDITOR`. We deliberately do NOT consult `$VISUAL`/`$EDITOR`: those name
// the *git / terminal commit* editor (vim, or on Windows often Notepad), which is the wrong tool for
// "open this file in my IDE" — honoring them opened Notepad on file-citation clicks (a real regression).
function resolveEditor(): string {
  return process.env.TYPEBULB_EDITOR || 'code'
}

// The VS Code family takes `-g file:line`; the vi/emacs/nano family takes `+line file`.
// Classify by command basename so the line jump lands whichever editor resolves.
const VSCODE_FAMILY = /^(code|code-insiders|codium|vscodium|cursor|windsurf)(\.cmd|\.exe)?$/i

function editorArgs(editor: string, filePath: string, line?: number): string[] {
  if (line == null) return [filePath]
  return VSCODE_FAMILY.test(basename(editor))
    ? ['-g', `${filePath}:${line}`]
    : [`+${line}`, filePath]
}

/** The command to open `filePath` (optionally at `line`) in the user's editor. Pure (no spawn) so
 *  the editor resolution and per-family line-jump syntax are unit-testable. */
export function editorCommand(filePath: string, line?: number): { command: string; args: string[] } {
  const editor = resolveEditor()
  return { command: editor, args: editorArgs(editor, filePath, line) }
}

/** Open `filePath` (optionally at `line`) in the user's editor, detached. Defaults to VS Code
 *  (`code`); override with `TYPEBULB_EDITOR`. Fire-and-forget (a launch failure logs, never throws). */
export function openInEditor(filePath: string, line?: number): void {
  const { command, args } = editorCommand(filePath, line)
  // shell:true so Windows resolves `code.cmd`/`cursor.cmd`; detached+unref so it outlives the
  // caller; stdio ignored so it holds none of the caller's streams.
  const proc = spawn(command, args, { shell: true, detached: true, stdio: 'ignore' })
  proc.on('error', err => console.error('[typebulb] editor launch failed:', (err as Error)?.message ?? err))
  proc.unref()
}
