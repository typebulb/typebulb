import { describe, it, expect } from 'vitest'
import { EmbedStatusDedup } from '../agents/core/server/embedStatusLog.js'

/**
 * The mirror's tag-keyed embed-status forward (TB-Agent-Mirror-Embed.md, Iteration Invariant 7):
 * a refresh re-forwards every embed's identical outcome, so repeats collapse per tag while distinct states
 * still log — including a re-emit's, whose chain version makes its line differ even when the text repeats.
 */
describe('EmbedStatusDedup', () => {
  it('accepts the first line for a tag and drops an identical repeat', () => {
    const d = new EmbedStatusDedup()
    const line = '[embed Dice Roller v1] runtime error: setupTheme is not defined'
    expect(d.accept('Dice Roller', line)).toBe(true)
    expect(d.accept('Dice Roller', line)).toBe(false)   // a refresh re-forwarding the same error
    expect(d.accept('Dice Roller', line)).toBe(false)
  })

  it('logs anew when the state changes for the same tag', () => {
    const d = new EmbedStatusDedup()
    expect(d.accept('Mixer', '[embed Mixer v1] compile error: Unexpected token')).toBe(true)
    expect(d.accept('Mixer', '[embed Mixer v1] runtime error: x is undefined')).toBe(true)  // different failure
    expect(d.accept('Mixer', '[embed Mixer v1] runtime error: x is undefined')).toBe(false) // now a repeat
    expect(d.accept('Mixer', '[embed Mixer v2] ok')).toBe(true)                             // the fix landed
  })

  it('accepts a re-emit with identical text — the version makes the line fresh', () => {
    const d = new EmbedStatusDedup()
    expect(d.accept('Chess', '[embed Chess v1] ok')).toBe(true)
    expect(d.accept('Chess', '[embed Chess v1] ok')).toBe(false)  // replay of the same render
    expect(d.accept('Chess', '[embed Chess v2] ok')).toBe(true)   // a re-emit must wake a waiting agent
  })

  it('keys per tag, so two embeds never mask each other', () => {
    const d = new EmbedStatusDedup()
    expect(d.accept('A', '[embed A v1] runtime error: boom')).toBe(true)
    expect(d.accept('B', '[embed B v1] runtime error: boom')).toBe(true)   // same text, different tag → logs
    expect(d.accept('A', '[embed A v1] runtime error: boom')).toBe(false)  // still deduped within its own tag
  })
})
