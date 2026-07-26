import { describe, it, expect } from 'vitest'
import { lint, bareImportRoots } from '../../lint/src/index.js'
import { toBulbPositions } from '../src/commands/check.js'

// The UNDECLARED_IMPORT rule is the CLI's authored-config contract: the resolver is import-driven and
// would CDN-resolve any bare import whether or not config.json declares it, so without this rule a
// config-less bulb runs on non-reproducible "latest" (the GLM incident — a model omitted config.json
// and the bulb rendered/broke out anyway). The rule fires only when the caller supplies `dependencies`;
// typebulb.com omits it (it derives config.json from the imports), so the rule stays dormant there.

const code = `import React from "react"\nimport { createRoot } from "react-dom/client"\nconsole.log(React, createRoot)`

describe('UNDECLARED_IMPORT lint rule', () => {
  it('does not fire when dependencies is omitted (typebulb.com derives config)', () => {
    const issues = lint(code, { target: 'client' })
    expect(issues.some(i => i.type === 'UNDECLARED_IMPORT')).toBe(false)
  })

  it('flags every bare import absent from a supplied (empty) dependencies set, by root', () => {
    const issues = lint(code, { target: 'client', dependencies: {} })
      .filter(i => i.type === 'UNDECLARED_IMPORT')
    expect(issues.map(i => i.message.split('\n')[0])).toEqual([
      'Import "react" is not declared in config.json dependencies! Found on line 1.',
      // subpath import resolves to its root: react-dom/client → react-dom
      'Import "react-dom" is not declared in config.json dependencies! Found on line 2.',
    ])
  })

  it('passes when every import root is declared (version value is irrelevant)', () => {
    const issues = lint(code, { target: 'client', dependencies: { react: '^19.2.7', 'react-dom': '*' } })
    expect(issues.some(i => i.type === 'UNDECLARED_IMPORT')).toBe(false)
  })

  // The line number has to shift with the block's position in its .bulb.md, and it's baked into the
  // message prose — so the offset is an input, not a rewrite of the output, or the header and body
  // would disagree (TB-Lint-Transpile.md Invariant 8).
  it('reports .bulb.md coordinates when given the block offset', () => {
    const issues = lint(code, { target: 'client', dependencies: {}, lineOffset: 12 })
      .filter(i => i.type === 'UNDECLARED_IMPORT')
    expect(issues.map(i => i.lineNumber)).toEqual([12, 13])
    expect(issues[0].message.split('\n')[0]).toContain('Found on line 12.')
  })

  it('shifts rule issues by the block offset too', () => {
    const [issue] = lint('import { mat4 } from "https://esm.sh/gl-matrix"', { target: 'client', lineOffset: 30 })
    expect(issue.lineNumber).toBe(30)
    expect(issue.message).toContain('Found on line 30.')
  })

  // Import-shaped text that isn't an import. An inline Web Worker's source in a template literal is
  // the pattern a WebGL/WASM bulb needs, and firing URL_IMPORT on it means that bulb can never pass
  // `check` (TB-Lint-Transpile.md Invariant 9).
  describe('the code view — rules read code, not every string in the file', () => {
    const worker = 'function workerSrc() { return `\nimport { mat4 } from "https://esm.sh/gl-matrix";\nself.onmessage = () => {};\n` }'

    it('does not flag a URL import inside a template literal', () => {
      expect(lint(worker, { target: 'client' })).toEqual([])
    })

    it('does not derive a dependency from a bare import inside a template literal', () => {
      expect(bareImportRoots('const src = `import React from "react"`')).toEqual([])
      expect(lint('const src = `import React from "react"`', { target: 'client', dependencies: {} })).toEqual([])
    })

    it('ignores commented-out code', () => {
      expect(lint('// import x from "https://esm.sh/x"', { target: 'client' })).toEqual([])
      expect(lint('/*\nimport x from "https://esm.sh/x"\n*/', { target: 'client' })).toEqual([])
    })

    it('still flags the real import beside the blanked text, on its true line', () => {
      const src = `const src = \`\nimport { mat4 } from "https://esm.sh/gl-matrix"\n\`\nimport x from "https://esm.sh/real"`
      const issues = lint(src, { target: 'client' })
      expect(issues.map(i => [i.type, i.lineNumber])).toEqual([['URL_IMPORT', 4]])
      // lineContent quotes the real source, not the blanked view.
      expect(issues[0].lineContent).toBe('import x from "https://esm.sh/real"')
    })

    it('tracks a regex literal, so a backtick inside one cannot blank the code after it', () => {
      const src = 'const parts = text.split(/`/)\nimport x from "https://esm.sh/gl-matrix"'
      expect(lint(src, { target: 'client' }).map(i => [i.type, i.lineNumber])).toEqual([['URL_IMPORT', 2]])
    })

    it('does not mistake division for a regex', () => {
      const src = 'const ratio = miles / hours\nimport x from "https://esm.sh/x"'
      expect(lint(src, { target: 'client' }).map(i => [i.type, i.lineNumber])).toEqual([['URL_IMPORT', 2]])
    })
  })

  it('reports a repeated import once, on its first line', () => {
    const dup = `import { a } from "lodash"\nimport { b } from "lodash"`
    const issues = lint(dup, { target: 'client', dependencies: {} })
      .filter(i => i.type === 'UNDECLARED_IMPORT')
    expect(issues).toHaveLength(1)
    expect(issues[0].lineNumber).toBe(1)
  })

  it('ignores non-bare specifiers — relative, absolute, and URL imports are not config deps', () => {
    const nonBare = `import a from "./local"\nimport b from "/abs"\nimport c from "https://esm.sh/x"`
    const issues = lint(nonBare, { target: 'client', dependencies: {} })
      .filter(i => i.type === 'UNDECLARED_IMPORT')
    expect(issues).toHaveLength(0)
  })

  it('never fires on the server target (server deps are npm-installed by name)', () => {
    const issues = lint(code, { target: 'server', dependencies: {} })
    expect(issues.some(i => i.type === 'UNDECLARED_IMPORT')).toBe(false)
  })
})

// The extraction the breakout config-derivation reuses, so a derived config.json matches exactly what
// the UNDECLARED_IMPORT rule would demand (same IMPORT_FROM / importRoot).
describe('bareImportRoots', () => {
  it('returns unique roots in first-seen order, subpaths reduced to their root', () => {
    expect(bareImportRoots(code)).toEqual(['react', 'react-dom'])
  })
  it('excludes relative / absolute / URL specifiers', () => {
    expect(bareImportRoots(`import a from "./x"\nimport b from "/y"\nimport c from "https://esm.sh/z"`)).toEqual([])
  })
  it('keeps a scoped package whole', () => {
    expect(bareImportRoots(`import x from "@scope/pkg/sub"`)).toEqual(['@scope/pkg'])
  })
})

// The third coordinate-space surface (TB-Dts.md Invariant 8): tsc's `code.tsx(l,c)` / `server.ts(l,c)`
// rewritten to the bulb's own file and line. Positions in other files (node_modules types) are real
// and stay untouched.
describe('tsc diagnostics map to .bulb.md coordinates', () => {
  const startOf = (blockFile: string) => (blockFile === 'code.tsx' ? 9 : 40)

  it('rewrites both block names, adding each block\'s start line', () => {
    expect(toBulbPositions("code.tsx(94,7): error TS2304: Cannot find name 'x'.", 'birds.bulb.md', startOf))
      .toBe("birds.bulb.md(102,7): error TS2304: Cannot find name 'x'.")
    expect(toBulbPositions('server.ts(2,1): error TS1005.', 'birds.bulb.md', startOf))
      .toBe('birds.bulb.md(41,1): error TS1005.')
  })

  it('leaves positions in other files alone', () => {
    const line = 'node_modules/@types/react/index.d.ts(310,9): error TS2717.'
    expect(toBulbPositions(line, 'birds.bulb.md', startOf)).toBe(line)
  })
})
