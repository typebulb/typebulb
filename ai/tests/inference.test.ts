import { describe, it, expect } from 'vitest'
import { sanitizeJsonOutput, buildInferencePrompt, encodeToHash, decodeFromHash } from '../src/inference.js'

describe('sanitizeJsonOutput', () => {
  describe('valid JSON (no fixes needed)', () => {
    it('parses a simple object', () => {
      const r = sanitizeJsonOutput('{"key": "value"}')
      expect(r.parsed).toEqual({ key: 'value' })
      expect(r.fixesApplied).toEqual([])
    })

    it('parses an array', () => {
      const r = sanitizeJsonOutput('[1, 2, 3]')
      expect(r.parsed).toEqual([1, 2, 3])
      expect(r.fixesApplied).toEqual([])
    })

    it('trims whitespace', () => {
      const r = sanitizeJsonOutput('  \n {"a": 1} \n  ')
      expect(r.parsed).toEqual({ a: 1 })
      expect(r.fixesApplied).toEqual([])
    })
  })

  describe('markdown fences at start', () => {
    it('strips ```json fences', () => {
      const r = sanitizeJsonOutput('```json\n{"key": "value"}\n```')
      expect(r.parsed).toEqual({ key: 'value' })
      expect(r.fixesApplied).toEqual(['markdown fences'])
    })

    it('strips bare ``` fences', () => {
      const r = sanitizeJsonOutput('```\n[1, 2]\n```')
      expect(r.parsed).toEqual([1, 2])
      expect(r.fixesApplied).toEqual(['markdown fences'])
    })

    it('strips fences with trailing whitespace', () => {
      const r = sanitizeJsonOutput('```json\n{"a": 1}\n```  ')
      expect(r.parsed).toEqual({ a: 1 })
      expect(r.fixesApplied).toEqual(['markdown fences'])
    })
  })

  describe('preamble before fenced JSON (Opus 4.6 reasoning leak)', () => {
    it('extracts JSON from fences after reasoning text', () => {
      const content = `I need to analyze this data carefully.
Let me think about the structure.

Now I have all the context I need. Let me construct the JSON:

\`\`\`json
{"quality": 85, "tags": ["insightful", "funny"]}
\`\`\``
      const r = sanitizeJsonOutput(content)
      expect(r.parsed).toEqual({ quality: 85, tags: ['insightful', 'funny'] })
      expect(r.fixesApplied).toContain('preamble before fenced JSON')
    })

    it('handles multi-line JSON in fences after preamble', () => {
      const content = `Some reasoning here.

\`\`\`json
{
  "replies": [
    {"author": "alice", "quality": 70},
    {"author": "bob", "quality": 45}
  ]
}
\`\`\``
      const r = sanitizeJsonOutput(content)
      expect(r.parsed).toEqual({
        replies: [
          { author: 'alice', quality: 70 },
          { author: 'bob', quality: 45 }
        ]
      })
      expect(r.fixesApplied).toContain('preamble before fenced JSON')
    })

    it('handles bare ``` fences (no json tag) after preamble', () => {
      const content = `Let me process this.

\`\`\`
{"result": true}
\`\`\``
      const r = sanitizeJsonOutput(content)
      expect(r.parsed).toEqual({ result: true })
      expect(r.fixesApplied).toContain('preamble before fenced JSON')
    })
  })

  describe('preamble before bare JSON (no fences)', () => {
    it('strips text before a JSON object', () => {
      const content = 'Here is the result:\n{"key": "value"}'
      const r = sanitizeJsonOutput(content)
      expect(r.parsed).toEqual({ key: 'value' })
      expect(r.fixesApplied).toContain('preamble text')
    })

    it('strips text before a JSON array', () => {
      const content = 'The output:\n[1, 2, 3]'
      const r = sanitizeJsonOutput(content)
      expect(r.parsed).toEqual([1, 2, 3])
      expect(r.fixesApplied).toContain('preamble text')
    })

    it('picks the earlier of { or [ when both present in preamble', () => {
      const content = 'Result:\n[{"a": 1}]'
      const r = sanitizeJsonOutput(content)
      expect(r.parsed).toEqual([{ a: 1 }])
      expect(r.fixesApplied).toContain('preamble text')
    })
  })

  describe('trailing character fixes', () => {
    it('fixes trailing }}', () => {
      const r = sanitizeJsonOutput('{"a": {"b": 1}}}')
      expect(r.parsed).toEqual({ a: { b: 1 } })
      expect(r.fixesApplied).toContain('trailing }')
    })

    it('fixes trailing ]]', () => {
      const r = sanitizeJsonOutput('[[1, 2]]]')
      expect(r.parsed).toEqual([[1, 2]])
      expect(r.fixesApplied).toContain('trailing ]')
    })

    it('fixes trailing comma in object', () => {
      const r = sanitizeJsonOutput('{"a": 1, "b": 2,}')
      expect(r.parsed).toEqual({ a: 1, b: 2 })
      expect(r.fixesApplied).toContain('trailing commas')
    })

    it('fixes trailing comma in array', () => {
      const r = sanitizeJsonOutput('[1, 2, 3,]')
      expect(r.parsed).toEqual([1, 2, 3])
      expect(r.fixesApplied).toContain('trailing commas')
    })

    it('fixes trailing commas inside nested objects (GPT-5.6 field failure, 2026-08)', () => {
      const content = `{
  "participants": {
    "BEN": { "novelty": 5, "summary": "no case offered", },
    "JOE": { "novelty": 5, "summary": "mirrors the claim", }
  },
  "headline": "JOE EDGES BEN!"
}`
      const r = sanitizeJsonOutput(content)
      expect(r.parsed).toEqual({
        participants: {
          BEN: { novelty: 5, summary: 'no case offered' },
          JOE: { novelty: 5, summary: 'mirrors the claim' },
        },
        headline: 'JOE EDGES BEN!',
      })
      expect(r.fixesApplied).toContain('trailing commas')
    })

    it('never touches a comma-before-brace inside a string literal', () => {
      const r = sanitizeJsonOutput('{"snippet": "so I said, }", "n": [1, 2,], }')
      expect(r.parsed).toEqual({ snippet: 'so I said, }', n: [1, 2] })
    })

    it('tracks string boundaries across escaped quotes when stripping trailing commas', () => {
      const r = sanitizeJsonOutput('{"quote": "he said \\"done,\\" twice", "n": 1, }')
      expect(r.parsed).toEqual({ quote: 'he said "done," twice', n: 1 })
      expect(r.fixesApplied).toContain('trailing commas')
    })
  })

  describe('composed fixes (preamble + trailing)', () => {
    it('handles preamble + fenced JSON + trailing comma', () => {
      const content = `Reasoning text here.

\`\`\`json
{"a": 1, "b": 2,}
\`\`\``
      const r = sanitizeJsonOutput(content)
      expect(r.parsed).toEqual({ a: 1, b: 2 })
      expect(r.fixesApplied).toContain('preamble before fenced JSON')
      expect(r.fixesApplied).toContain('trailing commas')
    })

    it('handles preamble + bare JSON + trailing brace', () => {
      const content = 'Here is the output:\n{"a": {"b": 1}}}'
      const r = sanitizeJsonOutput(content)
      expect(r.parsed).toEqual({ a: { b: 1 } })
      expect(r.fixesApplied).toContain('preamble text')
      expect(r.fixesApplied).toContain('trailing }')
    })
  })

  describe('unfixable content', () => {
    it('returns undefined for completely invalid content', () => {
      const r = sanitizeJsonOutput('this is not json at all')
      expect(r.parsed).toBeUndefined()
    })

    it('returns undefined for truncated JSON', () => {
      const r = sanitizeJsonOutput('{"key": "val')
      expect(r.parsed).toBeUndefined()
    })

    it('returns undefined for empty input', () => {
      const r = sanitizeJsonOutput('')
      expect(r.parsed).toBeUndefined()
    })
  })

  describe('multiple top-level JSON values (Opus 4.7 draft+revision)', () => {
    it('picks the last valid JSON when two are separated by prose', () => {
      const content = `{"source":"v1","_comment":"discarded"}

Wait, I need to reconsider. Let me regenerate properly.

{"source":"v2","label":"final"}`
      const r = sanitizeJsonOutput(content)
      expect(r.parsed).toEqual({ source: 'v2', label: 'final' })
      expect(r.fixesApplied).toContain('extracted last JSON value')
    })

    it('ignores braces inside string literals when scanning', () => {
      // First JSON contains `{` and `}` inside a string. The scanner must not
      // treat those as structural — otherwise it splits the first JSON in two.
      const content = `{"code":"function f() { return { a: 1 } }","_comment":"discarded"}

Reconsidering...

{"code":"const x = {}"}`
      const r = sanitizeJsonOutput(content)
      expect(r.parsed).toEqual({ code: 'const x = {}' })
    })

    it('falls back gracefully when only one JSON is present', () => {
      // Single valid JSON parses on the first try — fallback should not fire.
      const r = sanitizeJsonOutput('{"only": true}')
      expect(r.parsed).toEqual({ only: true })
      expect(r.fixesApplied).not.toContain('extracted last JSON value')
    })

    it('still returns undefined if no JSON value is balanced', () => {
      const r = sanitizeJsonOutput('thinking out loud {a: incomplete')
      expect(r.parsed).toBeUndefined()
    })
  })

  describe('orphan quote fix', () => {
    it('removes lines that are just a quote character', () => {
      const content = '"\n{"key": "value"}'
      const r = sanitizeJsonOutput(content)
      expect(r.parsed).toEqual({ key: 'value' })
    })
  })

  describe('arithmetic constants (cheap-model artifact: pi/e expressions in number position)', () => {
    it('repairs the verbatim Haiku 4.5 plot output (fences + 4 * pi range)', () => {
      const content = `\`\`\`json
{
  "title": "Sine Wave Function",
  "xLabel": "x (radians)",
  "yLabel": "sin(x)",
  "explanation": "The sine function oscillates between -1 and 1 with a period of 2π radians.",
  "equations": [
    {
      "label": "sin(x)",
      "expression": "sin(x)",
      "variable": "x",
      "range": [0, 4 * pi],
      "steps": 400
    }
  ]
}
\`\`\``
      const r = sanitizeJsonOutput(content)
      expect(r.parsed).not.toBeUndefined()
      const parsed = r.parsed as { equations: Array<{ range: [number, number] }> }
      expect(parsed.equations[0].range[1]).toBeCloseTo(4 * Math.PI)
      expect(r.fixesApplied).toEqual(['markdown fences', 'arithmetic constants'])
    })

    it('never touches string contents — pi in an explanation stays verbatim', () => {
      const r = sanitizeJsonOutput('{"explanation": "period of 2*pi radians", "range": [0, pi]}')
      expect(r.parsed).toEqual({ explanation: 'period of 2*pi radians', range: [0, Math.PI] })
    })

    it('folds unary and division forms (-pi/2, 360/57.3)', () => {
      const r = sanitizeJsonOutput('{"a": -pi/2, "b": 360/57.3}')
      const parsed = r.parsed as { a: number; b: number }
      expect(parsed.a).toBeCloseTo(-Math.PI / 2)
      expect(parsed.b).toBeCloseTo(360 / 57.3)
    })

    it('leaves exponent-notation numbers and boolean literals alone', () => {
      // Valid on first parse — the strategy must not even be consulted.
      const r = sanitizeJsonOutput('{"tiny": 1e-5, "big": 2e3, "flag": true}')
      expect(r.parsed).toEqual({ tiny: 1e-5, big: 2e3, flag: true })
      expect(r.fixesApplied).toEqual([])
    })
  })
})

describe('buildInferencePrompt', () => {
  it('includes all four sections when present', () => {
    const prompt = buildInferencePrompt(
      { infer: 'Score each item.', insight: '{"score": 1}', code: 'const x = tb.insight()' },
      ['item one']
    )
    expect(prompt).toContain('Instructions:\nScore each item.')
    expect(prompt).toContain('Example output:\n{"score": 1}')
    expect(prompt).toContain('Code that will consume your output:\nconst x = tb.insight()')
    expect(prompt).toContain('<data>\nitem one\n</data>')
  })

  it('labels multiple chunks and omits empty sections', () => {
    const prompt = buildInferencePrompt({ infer: 'Process.' }, ['a', 'b'])
    expect(prompt).toContain('[Chunk 1]\na')
    expect(prompt).toContain('[Chunk 2]\nb')
    expect(prompt).not.toContain('Example output:')
    expect(prompt).not.toContain('Code that will consume')
  })

  it('omits the data section when there are no chunks', () => {
    const prompt = buildInferencePrompt({ infer: 'Process.' }, [])
    expect(prompt).not.toContain('<data>')
    expect(prompt).toContain('Output only valid JSON.')
  })
})

describe('encodeToHash / decodeFromHash', () => {
  it('round-trips a result', () => {
    const result = {
      insight: { scores: [1, 2, 3], label: 'ünïcode ✓' },
      insightJson: JSON.stringify({ scores: [1, 2, 3], label: 'ünïcode ✓' }, null, 2),
      data: ['chunk one', '{"chunk": 2}']
    }
    const hash = encodeToHash(result)
    expect(hash.startsWith('#tb=1:')).toBe(true)
    const decoded = decodeFromHash(hash)
    expect(decoded).not.toBeUndefined()
    expect(decoded!.insight).toEqual(result.insight)
    expect(decoded!.data).toEqual(result.data)
  })

  it('returns empty string when the payload exceeds the URL ceiling', () => {
    // Incompressible payload (xorshift over the printable range) comfortably past the 60K encoded cap.
    let s = 88172645463325252n
    const next = () => { s ^= s << 13n; s ^= s >> 7n; s ^= s << 17n; s &= 0xffffffffffffffffn; return Number(s % 94n) }
    const big = Array.from({ length: 150000 }, () => String.fromCharCode(33 + next())).join('')
    const hash = encodeToHash({ insight: { big }, insightJson: '', data: [] })
    expect(hash).toBe('')
  })

  it('rejects a corrupted fragment', () => {
    const hash = encodeToHash({ insight: { a: 1 }, insightJson: '{"a":1}', data: [] })
    expect(decodeFromHash(hash.slice(0, hash.length - 8))).toBeUndefined()
  })

  it('rejects a non-tb fragment and an unknown version', () => {
    expect(decodeFromHash('#section-2')).toBeUndefined()
    expect(decodeFromHash('#tb=9:abc')).toBeUndefined()
  })
})
