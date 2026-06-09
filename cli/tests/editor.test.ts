import { describe, it, expect, afterEach } from 'vitest'
import { editorCommand, openInEditor } from '../src/serve/editor.js'
import { existsSync, rmSync, mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

/**
 * Click-to-open resolves to VS Code by default and is overridable ONLY by TYPEBULB_EDITOR. It must
 * NOT fall back to $VISUAL/$EDITOR — those name the git/terminal commit editor (Notepad on Windows),
 * which is the wrong tool for opening a file citation, and honoring them was a real regression.
 */
describe('editorCommand', () => {
  const saved = { ...process.env }
  afterEach(() => { process.env = { ...saved } })

  it('defaults to `code`, with VS Code `-g file:line` line syntax', () => {
    delete process.env.TYPEBULB_EDITOR
    expect(editorCommand('/a.bulb.md', 12)).toEqual({ command: 'code', args: ['-g', '/a.bulb.md:12'] })
    expect(editorCommand('/a.bulb.md')).toEqual({ command: 'code', args: ['/a.bulb.md'] })
  })

  it('ignores $EDITOR and $VISUAL (the Notepad regression)', () => {
    delete process.env.TYPEBULB_EDITOR
    process.env.EDITOR = 'notepad'
    process.env.VISUAL = 'vim'
    expect(editorCommand('/a.bulb.md').command).toBe('code')
  })

  it('honors an explicit TYPEBULB_EDITOR, with vi-family `+line file` syntax', () => {
    process.env.TYPEBULB_EDITOR = 'vim'
    expect(editorCommand('/a.bulb.md', 12)).toEqual({ command: 'vim', args: ['+12', '/a.bulb.md'] })
  })
})

/**
 * The file path handed to the editor is attacker-influenced: it rides a markdown link in the mirror's
 * rendered transcript (assistant text, web-fetched content, MCP / sub-agent output), and a clicked
 * citation calls tb.server.openFile → openInEditor with it verbatim. So the path must be an INERT
 * single argument — never a shell fragment. If it is shell-interpreted, a citation like
 *   [src/server.ts:42](src/server.ts & <command>)
 * is one-click RCE through the privileged mirror, bypassing Claude Code's own permission layer.
 */
describe('openInEditor — the path is never shell-interpreted', () => {
  const saved = { ...process.env }
  let sentinel = ''
  afterEach(() => {
    process.env = { ...saved }
    if (sentinel && existsSync(sentinel)) rmSync(sentinel)
    sentinel = ''
  })

  const waitForFile = async (p: string, deadlineMs: number): Promise<void> => {
    const stop = Date.now() + deadlineMs
    // Poll the filesystem side effect (the spawn is detached/async) — never a fetch/return signal.
    while (Date.now() < stop) {
      if (existsSync(p)) return
      await new Promise(r => setTimeout(r, 50))
    }
  }

  it('does not execute a command injected via shell metacharacters in the path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tb-editor-'))
    sentinel = join(dir, 'pwned.txt')
    // A bogus editor so a red run launches no real IDE; the injection rides the path arg regardless of
    // whether the editor command itself resolves (cmd/sh still process the `&` separator).
    process.env.TYPEBULB_EDITOR = 'tb-no-such-editor-xyz'
    // `&` is a command separator in both cmd.exe and /bin/sh; the redirect drops a sentinel if it runs.
    openInEditor(`harmless & echo pwned > "${sentinel}"`)
    // Generous margin: when the injection fires (red), the echo lands in well under a second; the
    // full wait only elapses on green, confirming nothing ran.
    await waitForFile(sentinel, 1500)
    expect(existsSync(sentinel)).toBe(false)
  })
})
