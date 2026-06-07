import { describe, it, expect } from 'vitest'
import { blockToMarkdown, capText } from '../agents/claude/server.js'

/**
 * A base64 image block (a pasted screenshot, or a queued-while-busy paste) must render as an inline
 * image, never dump its raw base64 as text; anything else oversized is capped (server.ts toText).
 */

describe('blockToMarkdown', () => {
  it('turns a base64 image block into an inline markdown image', () => {
    const md = blockToMarkdown({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } })
    expect(md).toBe('![pasted image](data:image/png;base64,AAAA)')
  })

  it('defaults the media type when absent', () => {
    expect(blockToMarkdown({ type: 'image', source: { type: 'base64', data: 'BBBB' } })).toContain('data:image/png;base64,BBBB')
  })

  it('returns empty for a non-image block (so it is dropped, not stringified)', () => {
    expect(blockToMarkdown({ type: 'text', text: 'hi' })).toBe('')
    expect(blockToMarkdown({ type: 'tool_use', id: 'x' })).toBe('')
    expect(blockToMarkdown(undefined)).toBe('')
  })
})

describe('capText', () => {
  it('leaves normal-sized text untouched', () => {
    expect(capText('short output')).toBe('short output')
  })

  it('truncates a megabyte blob and marks how much was cut', () => {
    const huge = 'x'.repeat(1_000_000)
    const out = capText(huge)
    expect(out.length).toBeLessThan(60_000)
    expect(out).toContain('characters truncated')
  })
})
