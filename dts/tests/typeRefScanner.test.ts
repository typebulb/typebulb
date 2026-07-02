import { describe, it, expect } from 'vitest'
import { TypeRefScanner } from '../src/typeRefScanner.js'

// The scanner harvests module refs from .d.ts text for relative-ref expansion
// and bare-dep prefetch. Pins that imports quoted inside comments (JSDoc
// @example blocks, // lines) are NOT harvested — each phantom ref costs a
// fan-out of guaranteed-404 CDN probes, and phantoms can crowd real deps out
// of the maxBareDeps slice. The filter is line-based on purpose: stripping
// block comments as a start/end region would mangle `declare module 'x/*'`,
// whose string literal contains a literal `/*` (echarts@6 types hit both cases).
describe('TypeRefScanner', () => {
  const scanner = new TypeRefScanner()

  it('collects relative and bare refs from real statements', () => {
    const text = [
      `import { A } from './a.js';`,
      `import type { B } from '../b/index.js';`,
      `export * from './c.js';`,
      `import { z } from 'zod';`,
    ].join('\n')
    expect(scanner.collectRelativeTypeRefs(text)).toEqual(['./a.js', '../b/index.js', './c.js'])
    expect(scanner.collectBareModuleRefs(text)).toEqual(['zod'])
  })

  it('ignores imports quoted in JSDoc example blocks (echarts@6 shape)', () => {
    const text = [
      `/**`,
      ` * @example`,
      ` * import {ComponentOption} from '../model/option.js';`,
      ` * import {inheritDefaultOption} from '../util/component.js';`,
      ` * import {XxxModel, XxxOption} from './XxxModel.js';`,
      ` */`,
      `export declare function use(ext: unknown): void;`,
      `import { real } from './real.js';`,
    ].join('\n')
    expect(scanner.collectRelativeTypeRefs(text)).toEqual(['./real.js'])
  })

  it('ignores // comment lines and single-line block comments', () => {
    const text = [
      `// import { old } from './removed.js';`,
      `/* import { doc } from './doc.js'; */`,
      `import { kept } from './kept.js';`,
    ].join('\n')
    expect(scanner.collectRelativeTypeRefs(text)).toEqual(['./kept.js'])
  })

  it(`does not let a wildcard declare module 'x/*' swallow following statements`, () => {
    const text = [
      `declare module 'three/examples/*';`,
      `import { after } from './after.js';`,
    ].join('\n')
    expect(scanner.collectRelativeTypeRefs(text)).toEqual(['./after.js'])
  })
})
