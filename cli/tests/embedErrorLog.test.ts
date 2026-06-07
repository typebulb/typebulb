import { describe, it, expect } from 'vitest'
import { EmbedErrorDedup } from '../agents/claude/embedErrorLog.js'

/**
 * The viewer's name-keyed embed-error forward (Specs/Typebulb-CLI-Agent-Viewer-Embed-Iterate.md Invariant 7,
 * Guard B): a refresh re-forwards a still-broken embed's identical error, so repeats collapse per tag while
 * distinct failures still log.
 */
describe('EmbedErrorDedup', () => {
  it('accepts the first line for a tag and drops an identical repeat', () => {
    const d = new EmbedErrorDedup()
    const line = '[embed Dice Roller] runtime error: setupTheme is not defined'
    expect(d.accept('Dice Roller', line)).toBe(true)
    expect(d.accept('Dice Roller', line)).toBe(false)   // a refresh re-forwarding the same error
    expect(d.accept('Dice Roller', line)).toBe(false)
  })

  it('logs anew when the error text changes for the same tag', () => {
    const d = new EmbedErrorDedup()
    expect(d.accept('Mixer', '[embed Mixer] compile error: Unexpected token')).toBe(true)
    expect(d.accept('Mixer', '[embed Mixer] runtime error: x is undefined')).toBe(true)  // different failure
    expect(d.accept('Mixer', '[embed Mixer] runtime error: x is undefined')).toBe(false) // now a repeat
  })

  it('keys per tag, so two embeds never mask each other', () => {
    const d = new EmbedErrorDedup()
    expect(d.accept('A', '[embed A] runtime error: boom')).toBe(true)
    expect(d.accept('B', '[embed B] runtime error: boom')).toBe(true)   // same text, different tag → logs
    expect(d.accept('A', '[embed A] runtime error: boom')).toBe(false)  // still deduped within its own tag
  })
})
