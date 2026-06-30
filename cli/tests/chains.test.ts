import { describe, it, expect } from 'vitest'
import { supersededFlags, chainPositions } from '../agents/core/client/chains.js'

/**
 * The same-name chain rule (TB-Agent-Mirror-Embed.md, Iteration Invariant 4): a consecutive
 * run of same-named embeds folds all but its last; a differently-named or unnamed embed breaks the run.
 */
describe('supersededFlags', () => {
  it('folds all but the last of a consecutive same-name run', () => {
    expect(supersededFlags(['Cones', 'Cones', 'Cones'])).toEqual([true, true, false])
  })

  it('treats a differently-named embed as a run break', () => {
    expect(supersededFlags(['A', 'B', 'A'])).toEqual([false, false, false]) // B breaks it; the 2nd A is a fresh singleton
    expect(supersededFlags(['A', 'A', 'B'])).toEqual([true, false, false])  // the run is the two A's; B is its own
  })

  it('never folds unnamed embeds, even adjacent ones', () => {
    expect(supersededFlags([undefined, undefined])).toEqual([false, false])
    expect(supersededFlags(['', ''])).toEqual([false, false])
  })

  it('leaves a lone or empty list live', () => {
    expect(supersededFlags(['A'])).toEqual([false])
    expect(supersededFlags([])).toEqual([])
  })

  it('restarts a run after a break', () => {
    // A A A | B | A A  → first two fold, third is tail; B singleton; first of the last pair folds
    expect(supersededFlags(['A', 'A', 'A', 'B', 'A', 'A'])).toEqual([true, true, false, false, true, false])
  })
})

describe('chainPositions', () => {
  it('numbers each embed within its consecutive same-name run', () => {
    expect(chainPositions(['A', 'A', 'A'])).toEqual([1, 2, 3])
  })

  it('resets the count at a run break', () => {
    expect(chainPositions(['A', 'B', 'A'])).toEqual([1, 1, 1])
    expect(chainPositions(['A', 'A', 'B', 'A', 'A'])).toEqual([1, 2, 1, 1, 2])
  })

  it('treats unnamed embeds as singletons', () => {
    expect(chainPositions([undefined, undefined, 'A', 'A'])).toEqual([1, 1, 1, 2])
  })
})
