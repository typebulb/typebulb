import { describe, it, expect } from 'vitest'
import { ensureDeclaredDependencies } from '../src/bulb/deriveDeps.js'
import { parseBulb } from '../../format/src/index.js'

// breakout calls ensureDeclaredDependencies so a promoted embed satisfies the authored-config contract
// even when the author omitted config.json (the GLM case): every bare import gets a `dependencies`
// entry, derived as "latest" (the version the import-driven resolver already uses for an undeclared
// import). The embed render path stays forgiving; this is where the real file is made correct.

const wrap = (code: string, config?: string) =>
  `---\nformat: typebulb/v1\nname: T\n---\n\n**code.tsx**\n\n\`\`\`tsx\n${code}\n\`\`\`\n` +
  (config ? `\n**config.json**\n\n\`\`\`json\n${config}\n\`\`\`\n` : '')

const depsOf = (source: string): Record<string, string> => {
  const cfg = parseBulb(source)?.files.get('config.json')
  return cfg ? (JSON.parse(cfg).dependencies ?? {}) : {}
}

describe('ensureDeclaredDependencies (breakout config derivation)', () => {
  it('derives a dependencies block for a config-less bulb, by import root', () => {
    const out = ensureDeclaredDependencies(wrap(`import React from "react"\nimport { createRoot } from "react-dom/client"`))
    expect(depsOf(out)).toEqual({ react: 'latest', 'react-dom': 'latest' })
  })

  it('adds only the missing roots and preserves existing pinned versions', () => {
    const out = ensureDeclaredDependencies(
      wrap(`import React from "react"\nimport { createRoot } from "react-dom/client"`, `{ "dependencies": { "react": "^19.2.7" } }`),
    )
    expect(depsOf(out)).toEqual({ react: '^19.2.7', 'react-dom': 'latest' })
  })

  it('is a byte-for-byte no-op when every import is already declared', () => {
    const input = wrap(`import React from "react"`, `{ "dependencies": { "react": "^19.2.7" } }`)
    expect(ensureDeclaredDependencies(input)).toBe(input)
  })

  it('is a no-op for an import-less bulb', () => {
    const input = wrap(`document.getElementById('app')!.textContent = 'hi'`)
    expect(ensureDeclaredDependencies(input)).toBe(input)
  })

  it('ignores non-bare specifiers (relative / URL) — not config deps', () => {
    const input = wrap(`import a from "./local"\nimport b from "https://esm.sh/x"\nconsole.log(a, b)`)
    expect(ensureDeclaredDependencies(input)).toBe(input)
  })

  it('leaves a non-bulb string untouched', () => {
    expect(ensureDeclaredDependencies('not a bulb')).toBe('not a bulb')
  })
})
