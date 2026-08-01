import { describe, it, expect } from 'vitest'
import { InlineStatusDedup } from '../agents/core/server/inlineStatusLog.js'

/**
 * The mirror's tag-keyed inline bulb-status forward (TB-Agent-Mirror-Inline.md, Iteration Invariant 7):
 * a refresh re-forwards every inline bulb's identical outcome, so repeats collapse per tag while distinct states
 * still log — including a re-emit's, whose chain version makes its line differ even when the text repeats.
 */
describe('InlineStatusDedup', () => {
  it('accepts the first line for a tag and drops an identical repeat', () => {
    const d = new InlineStatusDedup()
    const line = '[inline Dice Roller v1] runtime error: setupTheme is not defined'
    expect(d.accept('Dice Roller', line)).toBe(true)
    expect(d.accept('Dice Roller', line)).toBe(false)   // a refresh re-forwarding the same error
    expect(d.accept('Dice Roller', line)).toBe(false)
  })

  it('logs anew when the state changes for the same tag', () => {
    const d = new InlineStatusDedup()
    expect(d.accept('Mixer', '[inline Mixer v1] compile error: Unexpected token')).toBe(true)
    expect(d.accept('Mixer', '[inline Mixer v1] runtime error: x is undefined')).toBe(true)  // different failure
    expect(d.accept('Mixer', '[inline Mixer v1] runtime error: x is undefined')).toBe(false) // now a repeat
    expect(d.accept('Mixer', '[inline Mixer v2] ok')).toBe(true)                             // the fix landed
  })

  it('accepts a re-emit with identical text — the version makes the line fresh', () => {
    const d = new InlineStatusDedup()
    expect(d.accept('Chess', '[inline Chess v1] ok')).toBe(true)
    expect(d.accept('Chess', '[inline Chess v1] ok')).toBe(false)  // replay of the same render
    expect(d.accept('Chess', '[inline Chess v2] ok')).toBe(true)   // a re-emit must wake a waiting agent
  })

  it('keys per tag, so two inline bulbs never mask each other', () => {
    const d = new InlineStatusDedup()
    expect(d.accept('A', '[inline A v1] runtime error: boom')).toBe(true)
    expect(d.accept('B', '[inline B v1] runtime error: boom')).toBe(true)   // same text, different tag → logs
    expect(d.accept('A', '[inline A v1] runtime error: boom')).toBe(false)  // still deduped within its own tag
  })
})
