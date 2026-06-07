import { describe, it, expect } from 'vitest'
import {
  parseBulb, serializeBulb, toBulbData, parseConfig, blocks, orderedKinds, kindFromPath,
  isJsonData, isXmlData, isYamlData, isStructuralData, splitIntoChunks, splitIntoChunksWithBoundaries,
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

describe('parse — strictness (settled behaviour, do not regress)', () => {
  it('returns null without a leading ---', () => {
    expect(parseBulb('name: x\n')).toBeNull()
  })
  it('returns null with an unterminated frontmatter', () => {
    expect(parseBulb('---\nname: x\n')).toBeNull()
  })
  it('returns null when format does not start with "typebulb"', () => {
    expect(parseBulb('---\nformat: other/v1\nname: x\n---\n')).toBeNull()
  })
  it('returns null when name is missing', () => {
    expect(parseBulb('---\nformat: typebulb/v1\n---\n')).toBeNull()
  })
  it('accepts any format starting with "typebulb" (version-tolerant)', () => {
    expect(parseBulb('---\nformat: typebulb/v2\nname: x\n---\n')!.frontmatter.format).toBe('typebulb/v2')
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
