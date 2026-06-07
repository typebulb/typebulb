import { describe, it, expect } from 'vitest'
import { isHiddenTurn } from '../agents/claude/server.js'

/**
 * The viewer hides non-conversational turns structurally (Specs/Typebulb-CLI-Agent-Viewer.md):
 * sub-agent sidechains and CC's isMeta injections — a launched skill's full body, slash-command
 * caveats, /loop resume nudges. This is what keeps a `Skill claude-api` row from being followed by
 * 20 pages of the skill's body. Anchored on CC's own flags, not a content heuristic.
 */
describe('isHiddenTurn', () => {
  it('hides CC isMeta injections (skill body, caveat, resume nudge)', () => {
    expect(isHiddenTurn({ isMeta: true })).toBe(true)
  })

  it('hides sub-agent sidechains', () => {
    expect(isHiddenTurn({ isSidechain: true })).toBe(true)
  })

  it('keeps an ordinary human-authored turn (neither flag set)', () => {
    expect(isHiddenTurn({})).toBe(false)
    expect(isHiddenTurn({ isSidechain: false, isMeta: false })).toBe(false)
  })
})
