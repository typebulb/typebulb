import { describe, it, expect } from 'vitest'
import { lint } from '../../lint/src/index.js'

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
