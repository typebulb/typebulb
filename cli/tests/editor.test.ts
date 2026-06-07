import { describe, it, expect, afterEach } from 'vitest'
import { editorCommand } from '../src/serve/editor.js'

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
