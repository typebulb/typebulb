import { describe, it, expect } from 'vitest'
import { predictTrust } from '../src/bulb/predictTrust.js'

/**
 * The proactive trust predictor (TB-Security.md "Proactive prediction").
 * It is a hint, not a gate: a clean result NEVER means "safe" (the server-side trustGate
 * enforces), and a false positive is intentionally cheap. These tests pin the common
 * positives, the ungated-log carve-out, and that benign client-only code stays clean.
 */
describe('predictTrust', () => {
  const bulb = (code: string, server = '', infer = '') => ({ code, server, infer })

  it('flags a server.ts block structurally, regardless of code', () => {
    expect(predictTrust(bulb('export default () => null', 'export const x = 1'))).toBe('server-side code (server.ts)')
  })

  it('flags tb.fs / tb.ai usage in client code', () => {
    expect(predictTrust(bulb('await tb.fs.read("a.txt")'))).toBe('the filesystem')
    expect(predictTrust(bulb('const r = await tb.ai({ prompt })'))).toBe('AI (your API keys)')
  })

  it('flags raw privileged endpoint fetches (the bypass the gate still catches)', () => {
    expect(predictTrust(bulb("fetch('/__fs/write?path=x')"))).toBe('the filesystem')
    expect(predictTrust(bulb("fetch('/__ai', {})"))).toBe('AI (your API keys)')
  })

  it('flags every tb.server.<fn>; the ungated tb.log does not flag', () => {
    expect(predictTrust(bulb('await tb.server.query(1)'))).toBe('server-side code (server.ts)')
    // A `log` export is an ordinary gated export now — the ungated diagnostic moved to tb.log.
    expect(predictTrust(bulb('tb.server.log("hi")'))).toBe('server-side code (server.ts)')
    expect(predictTrust(bulb('tb.log("hi")'))).toBeUndefined()
  })

  it('flags an infer.md block structurally, and tb.infer usage in code', () => {
    expect(predictTrust(bulb('render()', '', 'Score each item 1-10.'))).toBe('AI (your API keys)')
    expect(predictTrust(bulb('await tb.infer()'))).toBe('AI (your API keys)')
  })

  it('returns undefined for benign client-only bulbs (a clean scan is not "safe")', () => {
    expect(predictTrust(bulb('const data = tb.data(0); tb.copy(data)'))).toBeUndefined()
    expect(predictTrust(bulb(''))).toBeUndefined()
  })

  it('tolerates whitespace around the member access', () => {
    expect(predictTrust(bulb('tb . fs . read("a")'))).toBe('the filesystem')
  })
})
