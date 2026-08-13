import { describe, it, expect } from 'vitest'
import {
  parseBulb, tryParseBulb, serializeBulb, toBulbData, parseConfig, blocks, orderedKinds, kindFromPath,
  isJsonData, isXmlData, isYamlData, isStructuralData, splitIntoChunks, splitIntoChunksWithBoundaries,
  validateBulbStructure, findUnfencedBulbs, replaceBulbBlock, removeBulbBlock, extractDescription, hostedAssetsBase,
  forbiddenAssetExt, slugify, MODE, modeUnion,
} from '../src/index.js'

const CANONICAL = `---
format: typebulb/v1
name: Counter
---

**code.tsx**

\`\`\`tsx
console.log("hi")
\`\`\`

**styles.css**

\`\`\`css
.x { color: red }
\`\`\`
`

describe('parse — happy path', () => {
  it('parses frontmatter and blocks', () => {
    const p = parseBulb(CANONICAL)!
    expect(p).not.toBeNull()
    expect(p.frontmatter.name).toBe('Counter')
    expect(p.frontmatter.format).toBe('typebulb/v1')
    expect(p.files.get('code.tsx')).toBe('console.log("hi")')
    expect(p.files.get('styles.css')).toBe('.x { color: red }')
  })

  it('toBulbData fills missing blocks with empty string', () => {
    const d = toBulbData(parseBulb(CANONICAL)!)
    expect(d.code).toBe('console.log("hi")')
    expect(d.html).toBe('')
    expect(d.config).toBe('')
  })
})

describe('validateBulbStructure — unterminated fences', () => {
  it('a well-formed bulb has no warnings', () => {
    expect(validateBulbStructure(CANONICAL)).toEqual([])
  })

  it('flags an unterminated fence that swallowed a later block (the reported case)', () => {
    const malformed = `---
format: typebulb/v1
name: Demo
---

**code.tsx**

\`\`\`tsx
x
\`\`\`

**styles.css**

\`\`\`css
.a {}

**config.json**

\`\`\`json
{}
\`\`\`
`
    const w = validateBulbStructure(malformed)
    expect(w).toHaveLength(1)
    expect(w[0]).toContain('styles.css')
    expect(w[0]).toContain('config.json')
  })

  it('flags a fence left open at end of file', () => {
    const malformed = `---
format: typebulb/v1
name: Demo
---

**code.tsx**

\`\`\`tsx
never closed
`
    const w = validateBulbStructure(malformed)
    expect(w).toHaveLength(1)
    expect(w[0]).toContain('code.tsx')
    expect(w[0]).toContain('end of the file')
  })

  it('does not false-positive on a block name mentioned in prose (no fence after)', () => {
    const fine = `---
format: typebulb/v1
name: Demo
---

**code.tsx**

\`\`\`tsx
x
\`\`\`

**notes.md**

\`\`\`md
Set up your **config.json** with the deps you need.
\`\`\`
`
    expect(validateBulbStructure(fine)).toEqual([])
  })
})

describe('findUnfencedBulbs — naked bulbs in prose (no enclosing fence)', () => {
  // The Kimi failure mode: the bulb is dumped straight into the message, framed by `---` thematic
  // breaks instead of a ````bulb```` fence, with trailing prose after it.
  const KIMI = `Here's a fireworks bulb, rendered inline below.

---

---
format: typebulb/v1
name: Fireworks
---

**code.tsx**

\`\`\`tsx
console.log("boom")
\`\`\`

**config.json**

\`\`\`json
{ "description": "fireworks" }
\`\`\`

---

The agent mirror is live at http://localhost:3000.`

  it('finds the bulb framed by --- and parses it', () => {
    const found = findUnfencedBulbs(KIMI)
    expect(found).toHaveLength(1)
    const p = parseBulb(found[0].source)!
    expect(p).not.toBeNull()
    expect(p.frontmatter.name).toBe('Fireworks')
    expect(p.files.get('code.tsx')).toBe('console.log("boom")')
    expect(p.files.get('config.json')).toBe('{ "description": "fireworks" }')
  })

  it('does not swallow trailing prose into the source', () => {
    const [b] = findUnfencedBulbs(KIMI)
    expect(b.source).not.toContain('The agent mirror is live')
    // The closing `---` thematic break is past the last block, so it stays out of the bulb too.
    const lines = KIMI.split('\n')
    expect(lines.slice(0, b.start).join('\n')).toContain("Here's a fireworks bulb")
    expect(lines.slice(b.end).join('\n')).toContain('The agent mirror is live')
  })

  it('ignores a lone --- frontmatter region with no blocks', () => {
    expect(findUnfencedBulbs('intro\n\n---\nformat: typebulb/v1\nname: x\n---\n\nmore prose')).toEqual([])
  })

  it('does not fire on ordinary prose with horizontal rules', () => {
    expect(findUnfencedBulbs('one\n\n---\n\ntwo\n\n---\n\nthree')).toEqual([])
  })

  it('reports bodyEndLine just past the last captured block, not end of content', () => {
    const src = '---\nformat: typebulb/v1\nname: x\n---\n\n**code.tsx**\n\n```tsx\nok\n```\n\ntrailing prose\nmore'
    const p = parseBulb(src)!
    // closing ``` is line index 9 (0-based); bodyEndLine points just past it.
    expect(src.split('\n')[p.bodyEndLine - 1]).toBe('```')
    expect(src.split('\n').slice(p.bodyEndLine).join('\n')).toContain('trailing prose')
  })

  // Each block's first content line in the .bulb.md — the offset that maps a tool's block-relative
  // position (tsc, lint, a stack trace) onto the file the user actually edits.
  it('records each block\'s first content line, 1-based, in the .bulb.md', () => {
    const src = '---\nformat: typebulb/v1\nname: x\n---\n\n**code.tsx**\n\n```tsx\nfirst\nsecond\n```\n\n**styles.css**\n\n```css\nbody {}\n```'
    const p = parseBulb(src)!
    const lines = src.split('\n')
    expect(lines[p.starts.get('code.tsx')! - 1]).toBe('first')
    expect(lines[p.starts.get('styles.css')! - 1]).toBe('body {}')
  })
})

describe('parse — strictness (settled behaviour, do not regress)', () => {
  it('returns undefined without a leading ---', () => {
    expect(tryParseBulb('name: x\n')).toBeUndefined()
  })
  it('returns undefined with an unterminated frontmatter', () => {
    expect(tryParseBulb('---\nname: x\n')).toBeUndefined()
  })
  it('returns undefined when format does not start with "typebulb"', () => {
    expect(tryParseBulb('---\nformat: other/v1\nname: x\n---\n')).toBeUndefined()
  })
  it('returns undefined when name is missing', () => {
    expect(tryParseBulb('---\nformat: typebulb/v1\n---\n')).toBeUndefined()
  })
  it('accepts any format starting with "typebulb" (version-tolerant)', () => {
    expect(parseBulb('---\nformat: typebulb/v2\nname: x\n---\n')!.frontmatter.format).toBe('typebulb/v2')
  })
})

// The throwing half of the same walk: every rejection above carries a reason, and they are the whole set.
describe('parseBulb — the throw names what is wrong', () => {
  const why = (src: string) => {
    try { parseBulb(src); return undefined } catch (e) { return (e as Error).message }
  }
  it('names the missing opening ---', () => {
    expect(why('name: x\n')).toContain("expected '---' on line 1")
  })
  it('points at a frontmatter pushed down the file (a patch applied at the wrong offset)', () => {
    const src = 'const VOCAB = 50257\n\n---\nformat: typebulb/v1\nname: x\n---\n\n**code.tsx**\n\n```\nok\n```\n'
    expect(why(src)).toContain('starts on line 3')
  })
  it('names an unterminated frontmatter', () => {
    expect(why('---\nname: x\n')).toContain('never closed')
  })
  it('separates an unrecognized format from a missing one', () => {
    expect(why('---\nformat: other/v1\nname: x\n---\n')).toContain('not a typebulb format')
    expect(why('---\nname: x\n---\n')).toContain("no 'format:'")
  })
  it('names a missing name', () => {
    expect(why('---\nformat: typebulb/v1\n---\n')).toContain("no 'name:'")
  })
  it('returns the bulb on success', () => {
    expect(parseBulb('---\nformat: typebulb/v1\nname: x\n---\n').frontmatter.name).toBe('x')
  })
})

describe('parse — relaxedness (settled behaviour, do not regress)', () => {
  it('tolerates blank lines between marker and fence', () => {
    const src = '---\nformat: typebulb/v1\nname: x\n---\n\n**code.tsx**\n\n\n\n```\nok\n```\n'
    expect(parseBulb(src)!.files.get('code.tsx')).toBe('ok')
  })
  it('tolerates trailing whitespace on the fence line', () => {
    const src = '---\nformat: typebulb/v1\nname: x\n---\n\n**code.tsx**\n\n```tsx   \nok\n```  \n'
    expect(parseBulb(src)!.files.get('code.tsx')).toBe('ok')
  })
  it('skips a marker with no following fence rather than failing', () => {
    const src = '---\nformat: typebulb/v1\nname: x\n---\n\n**code.tsx**\nnot a fence\n\n**styles.css**\n\n```css\nok\n```\n'
    const p = parseBulb(src)!
    expect(p).not.toBeNull()
    expect(p.files.get('styles.css')).toBe('ok')
  })
})

describe('nested fences round-trip', () => {
  it('serialize bumps the outer fence past inner backticks and parse recovers it', () => {
    const code = 'const md = `\\`\\`\\`js\\nx\\n\\`\\`\\``'
    const inner = '```js\nx\n```'
    const text = serializeBulb({ name: 'Nested', code: inner })
    expect(text).toContain('````') // outer fence longer than the inner ```
    expect(parseBulb(text)!.files.get('code.tsx')).toBe(inner)
    void code
  })

  it('round-trips a canonical bulb', () => {
    const p = parseBulb(CANONICAL)!
    const round = parseBulb(serializeBulb({ name: p.frontmatter.name, code: p.files.get('code.tsx'), css: p.files.get('styles.css') }))!
    expect(round.files.get('code.tsx')).toBe(p.files.get('code.tsx'))
    expect(round.files.get('styles.css')).toBe(p.files.get('styles.css'))
  })

  it('quotes a name containing a colon', () => {
    const text = serializeBulb({ name: 'a: b', code: 'x' })
    expect(text).toContain('name: "a: b"')
    expect(parseBulb(text)!.frontmatter.name).toBe('a: b')
  })
})

describe('parseConfig', () => {
  it('empty → {}', () => expect(parseConfig('')).toEqual({}))
  it('malformed → {}', () => expect(parseConfig('{not json')).toEqual({}))
  it('reads nested ts.jsxImportSource', () => {
    expect(parseConfig('{"ts":{"jsxImportSource":"preact"}}').ts?.jsxImportSource).toBe('preact')
  })
  it('reads dependencies', () => {
    expect(parseConfig('{"dependencies":{"react":"^19"}}').dependencies).toEqual({ react: '^19' })
  })
})

describe('hostedAssetsBase', () => {
  it('derives from identity, URL-encoded', () => {
    expect(hostedAssetsBase('ben', 'birds')).toBe('https://assets.typebulb.com/u/ben/birds/')
    expect(hostedAssetsBase('bén', 'my birds')).toBe('https://assets.typebulb.com/u/b%C3%A9n/my%20birds/')
  })
})

describe('forbiddenAssetExt', () => {
  it('names code/markup extensions, case-insensitive', () => {
    expect(forbiddenAssetExt('evil.html')).toBe('.html')
    expect(forbiddenAssetExt('sub/Evil.JS')).toBe('.js')
  })
  it('passes media, data, and unknown extensions', () => {
    for (const p of ['robin.png', 'weights.json', 'data.xml', 'donut.safetensors', 'LICENSE']) {
      expect(forbiddenAssetExt(p), p).toBeUndefined()
    }
  })
})

describe('extractDescription', () => {
  it('missing/empty → default', () => {
    expect(extractDescription(undefined)).toBe('A Typebulb bulb.')
    expect(extractDescription('{}')).toBe('A Typebulb bulb.')
  })
  it('strips markdown and flattens newlines', () => {
    expect(extractDescription('{"description":"Uses the **Boids algorithm** by [Craig](https://x.com)\\nwith `code`."}'))
      .toBe('Uses the Boids algorithm by Craig with code.')
  })
  it('truncates to 200 chars', () => {
    const desc = 'x'.repeat(250)
    expect(extractDescription(JSON.stringify({ description: desc }))).toHaveLength(200)
  })
})

describe('structural detection', () => {
  it('detects JSON', () => { expect(isJsonData('{"a":1}')).toBe(true); expect(isJsonData('nope')).toBe(false) })
  it('detects XML', () => { expect(isXmlData('<root><a/></root>')).toBe(true); expect(isXmlData('{"a":1}')).toBe(false) })
  it('detects YAML', () => { expect(isYamlData('a: 1\nb: 2')).toBe(true); expect(isYamlData('just text')).toBe(false) })
  it('isStructuralData is the union', () => {
    expect(isStructuralData('{"a":1}')).toBe(true)
    expect(isStructuralData('plain prose here')).toBe(false)
  })
})

describe('data chunking', () => {
  it('empty → []', () => expect(splitIntoChunks('')).toEqual([]))
  it('a structural blob stays one chunk (internal blank lines preserved)', () => {
    const json = '{\n  "a": 1,\n\n\n  "b": 2\n}'
    expect(splitIntoChunks(json)).toEqual([json])
  })
  it('plain text splits on 2+ blank lines', () => {
    expect(splitIntoChunks('one\n\n\ntwo\n\n\nthree')).toEqual(['one', 'two', 'three'])
  })
  it('reports 1-based line boundaries', () => {
    const [a, b] = splitIntoChunksWithBoundaries('one\n\n\nthree')
    expect(a).toMatchObject({ text: 'one', startLine: 1 })
    expect(b.text).toBe('three')
  })
})

describe('registry', () => {
  it('covers the 8 portable blocks (server.ts is cli-only, not a kind)', () => {
    expect(orderedKinds).toHaveLength(8)
    expect(orderedKinds).not.toContain('server')
  })
  it('kindFromPath round-trips every block', () => {
    for (const kind of orderedKinds) expect(kindFromPath(blocks[kind].path)).toBe(kind)
  })
})

describe('replaceBulbBlock', () => {
  const bulb = `---
format: typebulb/v1
name: Plot
---

Some prose the author left between blocks.

**data.txt**

\`\`\`txt
old data
\`\`\`

**insight.json**

\`\`\`json
{"old": true}
\`\`\`
`

  it('replaces fence content surgically, preserving prose and sibling blocks', () => {
    const out = replaceBulbBlock(bulb, 'insight', '{"new": 1}')
    expect(out).toContain('Some prose the author left between blocks.')
    expect(out).toContain('old data')
    expect(out).toContain('{"new": 1}')
    expect(out).not.toContain('{"old": true}')
    expect(toBulbData(parseBulb(out)!).insight).toBe('{"new": 1}')
  })

  it('appends the block when absent', () => {
    const noInsight = replaceBulbBlock(bulb.replace(/\*\*insight[\s\S]*$/, ''), 'insight', '{"a": 1}')
    expect(toBulbData(parseBulb(noInsight)!).insight).toBe('{"a": 1}')
  })

  it('grows the fence when the new content contains backtick runs', () => {
    const out = replaceBulbBlock(bulb, 'data', 'has a ``` fence inside')
    expect(toBulbData(parseBulb(out)!).data).toBe('has a ``` fence inside')
  })

  it('leaves an unterminated block untouched', () => {
    const broken = '---\nformat: typebulb/v1\nname: P\n---\n\n**data.txt**\n\n```txt\nruns to eof'
    expect(replaceBulbBlock(broken, 'data', 'x')).toBe(broken)
  })

  it('removeBulbBlock drops the block, keeping prose and siblings — and leaves no gap', () => {
    const out = removeBulbBlock(bulb, 'data')
    expect(out).toContain('Some prose the author left between blocks.')
    expect(out).not.toContain('data.txt')
    expect(out).not.toContain('old data')
    expect(toBulbData(parseBulb(out)!).insight).toBe('{"old": true}')
    expect(out).not.toMatch(/\n{3}/)
  })

  it('removeBulbBlock drops a trailing block, leaving one final newline', () => {
    const out = removeBulbBlock(bulb, 'insight')
    expect(toBulbData(parseBulb(out)!).data).toBe('old data')
    expect(out.endsWith('```\n')).toBe(true)
  })

  it('removeBulbBlock leaves an absent or unterminated block untouched', () => {
    const noInsight = bulb.replace(/\*\*insight[\s\S]*$/, '')
    expect(removeBulbBlock(noInsight, 'insight')).toBe(noInsight)
    const broken = '---\nformat: typebulb/v1\nname: P\n---\n\n**data.txt**\n\n```txt\nruns to eof'
    expect(removeBulbBlock(broken, 'data')).toBe(broken)
  })
})

describe('slugify', () => {
  it('is the one derivation every surface shares — the cases a hand-rolled regex got wrong', () => {
    expect(slugify('Rock & Roll')).toBe('rock-and-roll')      // transliterates; a regex yields rock-roll
    expect(slugify('café')).toBe('cafe')                      // folds accents; a regex strips them (caf)
    expect(slugify("Prisoner's Dilemma")).toBe('prisoners-dilemma')   // apostrophe collapses, not hyphenates
  })
})

describe('tb.mode values', () => {
  it('generates the emitted typings union from MODE, in declaration order', () => {
    expect(modeUnion).toBe(`'local' | 'ide' | 'published' | 'inline'`)
    expect(Object.keys(MODE)).toEqual(Object.values(MODE))   // key and value never drift apart
  })
})
