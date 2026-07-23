import { describe, it, expect } from 'vitest'
import { parseArgs } from '../src/args.js'
import { parsePositionalArgs, parseArgsJson, serializeResult } from '../src/run/call.js'

// TB-Call.md: `typebulb call <file> <fn> [arg…]` — the terminal-facing twin of the browser bridge.

describe('parseArgs: call subcommand', () => {
  it('captures file, fn, and trailing positional args in order', () => {
    const a = parseArgs(['call', 'db.bulb.md', 'query', 'select 1'])
    expect(a.subcommand).toBe('call')
    expect(a.file).toBe('db.bulb.md')
    expect(a.fn).toBe('query')
    expect(a.callArgs).toEqual(['select 1'])
    expect(a.hasArgsFlag).toBe(false)
  })

  it('takes no positional args (a zero-arg export)', () => {
    const a = parseArgs(['call', 'db.bulb.md', 'overview'])
    expect(a.fn).toBe('overview')
    expect(a.callArgs).toEqual([])
  })

  it('--args sets the escape hatch and is not mistaken for a positional', () => {
    const a = parseArgs(['call', 'app.bulb.md', 'doThing', '--args', '[{"id":1},"go"]'])
    expect(a.fn).toBe('doThing')
    expect(a.callArgs).toEqual([])
    expect(a.hasArgsFlag).toBe(true)
    expect(a.argsJson).toBe('[{"id":1},"go"]')
  })

  it('supports the --args=<json> form', () => {
    const a = parseArgs(['call', 'app.bulb.md', 'doThing', '--args=[1,2]'])
    expect(a.hasArgsFlag).toBe(true)
    expect(a.argsJson).toBe('[1,2]')
  })

  it('--args - consumes the dash as the stdin sentinel, not a positional', () => {
    const a = parseArgs(['call', 'app.bulb.md', 'doThing', '--args', '-'])
    expect(a.argsJson).toBe('-')
    expect(a.callArgs).toEqual([])
  })

  it('carries --trust / --mode through alongside the call', () => {
    const a = parseArgs(['call', 'db.bulb.md', 'query', '--trust', '--mode', 'staging', 'select 1'])
    expect(a.trust).toBe(true)
    expect(a.mode).toBe('staging')
    expect(a.fn).toBe('query')
    expect(a.callArgs).toEqual(['select 1'])
  })

  it('--batch scopes the run to a named batch, normalizing a trailing slash', () => {
    const a = parseArgs(['call', 'probe.bulb.md', 'run', '--batch', 'pilot/', '--trust'])
    expect(a.batch).toBe('pilot')
    expect(a.fn).toBe('run')
    expect(a.callArgs).toEqual([])
  })
})

describe('parsePositionalArgs: JSON-or-string heuristic', () => {
  it('parses JSON-shaped args and keeps bare strings as strings', () => {
    expect(parsePositionalArgs(['select * from t', '{"a":1}', '42', 'true', '[1,2]'])).toEqual([
      'select * from t',
      { a: 1 },
      42,
      true,
      [1, 2],
    ])
  })

  it('footgun: a string whose content is valid JSON parses to that value', () => {
    // Documented in TB-Call.md — use --args for a literal "42".
    expect(parsePositionalArgs(['42'])).toEqual([42])
  })
})

describe('parseArgsJson: strict escape hatch', () => {
  it('parses a JSON array verbatim', () => {
    expect(parseArgsJson('[{"id":1},"go"]')).toEqual([{ id: 1 }, 'go'])
  })

  it('rejects a non-array (object)', () => {
    expect(() => parseArgsJson('{"a":1}')).toThrow(/must be a JSON array/)
  })

  it('rejects a non-array (null)', () => {
    expect(() => parseArgsJson('null')).toThrow(/must be a JSON array/)
  })

  it('rejects malformed JSON', () => {
    expect(() => parseArgsJson('[1,')).toThrow(/must be a JSON array/)
  })
})

describe('serializeResult: the stdout contract', () => {
  it('pretty-prints (2-space) JSON', () => {
    expect(serializeResult({ a: 1 })).toBe('{\n  "a": 1\n}')
  })

  it('coerces BigInt to a string (Postgres int8/bigint)', () => {
    expect(serializeResult({ n: 10n })).toBe('{\n  "n": "10"\n}')
  })

  it('returns undefined for a void function (nothing to print)', () => {
    expect(serializeResult(undefined)).toBeUndefined()
  })

  it('drops a bare function/symbol (JSON.stringify yields nothing)', () => {
    expect(serializeResult(() => {})).toBeUndefined()
  })
})
