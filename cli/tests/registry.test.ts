import { describe, it, expect } from 'vitest'
import { isKnownAgent, listAgentNames } from '../src/agentViewer/registry.js'

/**
 * The agents registry (Specs/Typebulb-CLI-Agent-Viewer.md): the set of reserved agent names the dispatch
 * validates `agent:<name>` against.
 */
describe('isKnownAgent', () => {
  it('recognises the reserved `claude` agent', () => {
    expect(isKnownAgent('claude')).toBe(true)
  })

  it('rejects an unknown name', () => {
    expect(isKnownAgent('not-an-agent')).toBe(false)
    expect(isKnownAgent('')).toBe(false)
  })
})

describe('listAgentNames', () => {
  it('lists the launchable agents', () => {
    expect(listAgentNames()).toContain('claude')
  })
})
