import { describe, it, expect, vi, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { parseArgs } from '../src/args.js'
import { parseBlockKind, parseBlockPairs } from '../src/blockPairs.js'
import { applyPuts } from '../src/commands/put.js'
import { normalizeContent } from '../src/payload.js'
import { runGet } from '../src/commands/get.js'
import { parseBulb } from 'typebulb/format'

// TB-Get-Put.md: `typebulb get/put` — block I/O from the terminal.

const FIXTURE = `---
format: typebulb/v1
name: Fixture
---

Prose between blocks that a parse→serialize round trip would drop.

**code.tsx**

\`\`\`tsx
console.log(tb.data(0))
\`\`\`

**data.txt**

\`\`\`txt
old data
\`\`\`
`

describe('parseArgs: get/put subcommands', () => {
  it('put captures the file and kind=source pairs in order', () => {
    const a = parseArgs(['put', 'report.bulb.md', 'data=results.json', 'insight=i.json'])
    expect(a.subcommand).toBe('put')
    expect(a.file).toBe('report.bulb.md')
    expect(a.blockPairs).toEqual([
      { kind: 'data', source: 'results.json' },
      { kind: 'insight', source: 'i.json' },
    ])
  })

  it('get captures the file and kind', () => {
    const a = parseArgs(['get', 'report.bulb.md', 'data'])
    expect(a.subcommand).toBe('get')
    expect(a.file).toBe('report.bulb.md')
    expect(a.blockKind).toBe('data')
  })
})

describe('parseBlockPairs', () => {
  it('splits on the first = only (a source path may contain =)', () => {
    expect(parseBlockPairs(['data=a=b.json'])).toEqual([{ kind: 'data', source: 'a=b.json' }])
  })

  it('accepts a stdin source', () => {
    expect(parseBlockPairs(['data=-'])).toEqual([{ kind: 'data', source: '-' }])
  })

  it('rejects an unknown kind, naming the valid set', () => {
    expect(() => parseBlockKind('dta')).toThrow(/one of: code, css/)
  })

  it('rejects a duplicate kind', () => {
    expect(() => parseBlockPairs(['data=a.json', 'data=b.json'])).toThrow(/Duplicate/)
  })

  it('rejects a second stdin source (stdin holds one payload)', () => {
    expect(() => parseBlockPairs(['data=-', 'insight=-'])).toThrow(/stdin/)
  })

  it('rejects a malformed pair', () => {
    expect(() => parseBlockPairs(['data'])).toThrow(/kind>=<source/)
    expect(() => parseBlockPairs(['data='])).toThrow(/kind>=<source/)
  })
})

describe('applyPuts', () => {
  it('replaces a block surgically — prose and other blocks preserved verbatim', () => {
    const out = applyPuts(FIXTURE, [{ kind: 'data', content: '{"fresh": true}' }])
    expect(out.written).toEqual([{ kind: 'data', action: 'replaced', chars: 15 }])
    expect(out.text).toContain('Prose between blocks')
    expect(out.text).toContain('console.log(tb.data(0))')
    expect(parseBulb(out.text)!.files.get('data.txt')).toBe('{"fresh": true}')
  })

  it('appends the block when absent (upsert — the first promotion must work)', () => {
    const out = applyPuts(FIXTURE, [{ kind: 'insight', content: '{"a": 1}' }])
    expect(out.written).toEqual([{ kind: 'insight', action: 'created', chars: 8 }])
    expect(parseBulb(out.text)!.files.get('insight.json')).toBe('{"a": 1}')
  })

  it('identical content is a no-op — nothing to write', () => {
    const out = applyPuts(FIXTURE, [{ kind: 'data', content: 'old data' }])
    expect(out.written).toEqual([])
    expect(out.upToDate).toEqual(['data'])
    expect(out.text).toBe(FIXTURE)
  })

  it('a line-ending-only difference is a no-op, not a rewrite', () => {
    const out = applyPuts(FIXTURE, [{ kind: 'data', content: normalizeContent('old data\r\n') }])
    expect(out.written).toEqual([])
    expect(out.upToDate).toEqual(['data'])
  })

  it('an unterminated target fence throws — atomically, discarding a prior good pair', () => {
    const broken = FIXTURE.replace(/\`\`\`\n$/, '')
    expect(() =>
      applyPuts(broken, [
        { kind: 'code', content: 'changed()' },
        { kind: 'data', content: 'x' },
      ]),
    ).toThrow(/unterminated/)
  })

  it('a non-bulb throws, naming what is wrong with it', () => {
    expect(() => applyPuts('just some text', [{ kind: 'data', content: 'x' }])).toThrow(/Invalid \.bulb\.md file format/)
  })

  it('empty content removes the block — empty === absent, so removal is its canonical spelling', () => {
    const out = applyPuts(FIXTURE, [{ kind: 'data', content: '' }])
    expect(out.written).toEqual([{ kind: 'data', action: 'removed', chars: 0 }])
    expect(out.text).not.toContain('data.txt')
    expect(out.text).toContain('Prose between blocks')
    expect(parseBulb(out.text)!.files.get('code.tsx')).toBe('console.log(tb.data(0))')
  })

  it('whitespace-only content removes the block (normalization trims it to empty)', () => {
    const out = applyPuts(FIXTURE, [{ kind: 'data', content: normalizeContent('  \n\n \n') }])
    expect(out.written).toEqual([{ kind: 'data', action: 'removed', chars: 0 }])
  })

  it('empty content for an already-absent block is a no-op (the state already holds)', () => {
    const out = applyPuts(FIXTURE, [{ kind: 'insight', content: '' }])
    expect(out.written).toEqual([])
    expect(out.upToDate).toEqual(['insight'])
    expect(out.text).toBe(FIXTURE)
  })

  it('removal is idempotent across invocations', () => {
    const once = applyPuts(FIXTURE, [{ kind: 'data', content: '' }]).text
    const twice = applyPuts(once, [{ kind: 'data', content: '' }])
    expect(twice.written).toEqual([])
    expect(twice.text).toBe(once)
  })

  it('grows the fence past backtick runs in the content', () => {
    const out = applyPuts(FIXTURE, [{ kind: 'data', content: 'has ``` inside' }])
    expect(parseBulb(out.text)!.files.get('data.txt')).toBe('has ``` inside')
  })
})

describe('runGet exit codes — the probe answer (2) is distinguishable from real errors (1)', () => {
  afterEach(() => vi.restoreAllMocks())

  /** Trap process.exit as a throw so the exit code is assertable. */
  const trapExit = () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
      throw new Error(`exit ${code}`)
    }) as never)
  }

  it('absent block exits 2', async () => {
    const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'getput-')), 'x.bulb.md')
    await fs.writeFile(file, FIXTURE)
    trapExit()
    await expect(runGet(file, 'insight')).rejects.toThrow('exit 2')
  })

  it('an empty block exits 2 too — one logical state, one exit code', async () => {
    const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'getput-')), 'x.bulb.md')
    await fs.writeFile(file, FIXTURE.replace('old data', ''))
    trapExit()
    await expect(runGet(file, 'data')).rejects.toThrow('exit 2')
  })

  // The 2-vs-1 distinction is intact: `get` owns exit 2, and every throw reaches main()'s handler,
  // which prints `Error: <message>` and exits 1.
  it('a non-bulb throws (main() reports it as exit 1)', async () => {
    const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'getput-')), 'x.bulb.md')
    await fs.writeFile(file, 'just some text')
    await expect(runGet(file, 'data')).rejects.toThrow(/Invalid \.bulb\.md file format/)
  })
})

describe('normalizeContent', () => {
  it('CRLF→LF, trailing whitespace trimmed', () => {
    expect(normalizeContent('a\r\nb\r\n\r\n')).toBe('a\nb')
    expect(normalizeContent('a  \n')).toBe('a')
  })

  it('strips a leading BOM (PowerShell utf8 writes one; JSON.parse chokes on it)', () => {
    expect(normalizeContent(String.fromCharCode(0xfeff) + '{"a": 1}')).toBe('{"a": 1}')
  })
})
