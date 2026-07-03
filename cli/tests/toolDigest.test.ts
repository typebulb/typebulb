import { describe, it, expect } from 'vitest'
import { toolResultDigest, firstLineDigest } from '../agents/claude/server.js'

/**
 * The collapsed tool row's OUT digest: toolResultDigest maps CC's structured toolUseResult shapes
 * (the same objects CC's own condensed UI renders from) to one-line summaries; unknown shapes fall
 * back to firstLineDigest over the raw result text. Shapes here mirror real ~/.claude transcripts.
 */

describe('toolResultDigest', () => {
  it('Read (text) → line count', () => {
    expect(toolResultDigest({ type: 'text', file: { filePath: 'x.ts', content: '…', numLines: 463 } }, '')).toBe('463 lines')
    expect(toolResultDigest({ type: 'text', file: { numLines: 1 } }, '')).toBe('1 line')
  })

  it('Read (image / unchanged)', () => {
    expect(toolResultDigest({ type: 'image', file: { originalSize: 43_008 } }, '')).toBe('image (42KB)')
    expect(toolResultDigest({ type: 'file_unchanged' }, '')).toBe('unchanged since last read')
  })

  it('Grep by mode', () => {
    expect(toolResultDigest({ mode: 'files_with_matches', filenames: ['a', 'b'], numFiles: 2 }, '')).toBe('2 files')
    expect(toolResultDigest({ mode: 'content', numFiles: 0, filenames: [], content: '…', numLines: 14 }, '')).toBe('14 lines')
    expect(toolResultDigest({ mode: 'count', numMatches: 7, numFiles: 3 }, '')).toBe('7 matches (3 files)')
  })

  it('Glob (no mode) → file count', () => {
    expect(toolResultDigest({ filenames: ['a'], numFiles: 1, durationMs: 12, truncated: false }, '')).toBe('1 file')
  })

  it('Edit → +added −removed from structuredPatch hunks', () => {
    const patch = [{ lines: ['ctx', '-old line', '+new line', '+another', ' ctx'] }]
    expect(toolResultDigest({ filePath: 'x.ts', oldString: 'a', newString: 'b', structuredPatch: patch }, '')).toBe('+2 −1')
  })

  it('Write (create) → created + line count, not the all-additions patch', () => {
    expect(toolResultDigest({ type: 'create', filePath: 'x.md', content: 'a\nb\nc', structuredPatch: [] }, '')).toBe('created, 3 lines')
  })

  it('Bash → first stdout line with +K tail; stderr / background / silence handled', () => {
    expect(toolResultDigest({ stdout: 'Done in 2.1s\nline2\nline3', stderr: '', interrupted: false, isImage: false }, '')).toBe('Done in 2.1s (+2 lines)')
    expect(toolResultDigest({ stdout: '', stderr: 'warning: foo', interrupted: false, isImage: false }, '')).toBe('warning: foo')
    expect(toolResultDigest({ stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' }, '')).toBe('running in background')
    expect(toolResultDigest({ stdout: '', stderr: '', interrupted: false, isImage: false }, '')).toBe('no output')
  })

  it('WebFetch → status line', () => {
    expect(toolResultDigest({ bytes: 0, code: 404, codeText: 'Not Found', result: '…', durationMs: 1646, url: 'https://x' }, '')).toBe('404 Not Found')
  })

  it('a string toolUseResult (error text) → its first line', () => {
    expect(toolResultDigest('Error: Exit code 127\n/usr/bin/bash: line 1: gh: command not found', '')).toBe('Error: Exit code 127 (+1 line)')
  })

  it('unknown shape → falls back to the raw content first line', () => {
    expect(toolResultDigest({ somethingNew: true }, 'patched 3 hunks\ndetail')).toBe('patched 3 hunks (+1 line)')
    expect(toolResultDigest(undefined, 'ok')).toBe('ok')
  })
})

describe('firstLineDigest', () => {
  it('caps a long first line and counts the rest', () => {
    const out = firstLineDigest('x'.repeat(200) + '\n\n  second  \nthird')
    expect(out.length).toBeLessThan(120)
    expect(out).toContain('…')
    expect(out).toContain('(+2 lines)')
  })

  it('strips ANSI color codes', () => {
    expect(firstLineDigest('\u001b[32mPASS\u001b[0m all tests')).toBe('PASS all tests')
  })

  it('returns empty for whitespace-only output (row shows nothing, not a blank dot)', () => {
    expect(firstLineDigest('  \n \n')).toBe('')
  })
})
