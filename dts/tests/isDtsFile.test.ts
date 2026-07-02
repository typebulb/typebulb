import { describe, it, expect } from 'vitest'
import { isDtsFile } from '../src/dtsConfig.js'

/**
 * The single "is this a type declaration" predicate (shared by the resolver's
 * relative-ref walk and the provider's fetch validation). Pins the two accepted
 * forms — a `.d.ts`/`.d.mts`/`.d.cts` path (trailing query/hash tolerated) and
 * esm.sh's bare `?dts` marker param — and that arbitrary `dts` substrings in a
 * query do NOT count (the old loose `search.includes('dts')` behavior).
 */
describe('isDtsFile', () => {
  it('accepts declaration files, with or without a trailing query/hash', () => {
    expect(isDtsFile('foo.d.ts')).toBe(true)
    expect(isDtsFile('foo.d.mts')).toBe(true)
    // echarts declares `types: "types/dist/echarts.d.cts"`; not recognizing it
    // cost 4 double-extension probes (echarts.d.d.ts, …) before the verbatim fetch.
    expect(isDtsFile('foo.d.cts')).toBe(true)
    expect(isDtsFile('/pkg/dist/index.d.ts?raw')).toBe(true)
    expect(isDtsFile('https://cdn.jsdelivr.net/npm/x@1/index.d.ts#frag')).toBe(true)
  })

  it('accepts esm.sh\'s bare ?dts marker param', () => {
    expect(isDtsFile('https://esm.sh/react@19.2.7?dts')).toBe(true)
    expect(isDtsFile('https://esm.sh/react@19.2.7?dts&target=es2022')).toBe(true)
    expect(isDtsFile('https://esm.sh/react@19.2.7?target=es2022&dts')).toBe(true)
  })

  it('rejects non-declarations and incidental "dts" substrings', () => {
    expect(isDtsFile('foo.ts')).toBe(false)
    expect(isDtsFile('foo.cts')).toBe(false)
    expect(isDtsFile('foo.js')).toBe(false)
    expect(isDtsFile('https://esm.sh/x?target=es2022')).toBe(false)
    expect(isDtsFile('https://esm.sh/x?bundle=dts-utils')).toBe(false)
    expect(isDtsFile('https://esm.sh/x?x=dts')).toBe(false)
  })
})
