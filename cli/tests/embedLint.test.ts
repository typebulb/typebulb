import { describe, it, expect } from 'vitest'
import { renderBulb } from '../src/render.js'

// An embed is client-only, so renderBulb runs the same `typebulb/lint` browser ruleset `typebulb check`
// uses — patterns that compile but break in the sandboxed iframe (dynamic import, URL/version imports,
// navigation). A violation becomes a render error, which the mirror surfaces to the user AND forwards to
// `typebulb logs claude` via the existing compile-error readback (TB-Agent-Mirror-Embed.md, Iteration).

const wrap = (code: string) =>
  `---\nformat: typebulb/v1\nname: T\n---\n\n**code.tsx**\n\n\`\`\`tsx\n${code}\n\`\`\`\n`

describe('renderBulb lints client code (the embed path)', () => {
  it('blocks a dynamic import, naming the rule and line', async () => {
    const r = await renderBulb(wrap(`import('react').then(() => {})`))
    expect(r.error).toMatch(/Lint failed/)
    expect(r.error).toMatch(/DYNAMIC_IMPORT \(line 1\)/)
    expect(r.html).toBeUndefined()
  })

  it('blocks a URL import', async () => {
    const r = await renderBulb(wrap(`import x from "https://esm.sh/x"\nconsole.log(x)`))
    expect(r.error).toMatch(/URL_IMPORT/)
    expect(r.html).toBeUndefined()
  })

  it('blocks sandbox-breaking navigation', async () => {
    const r = await renderBulb(wrap(`window.location.reload()`))
    expect(r.error).toMatch(/NAVIGATION/)
  })

  it('lets lint-clean code through to render', async () => {
    // No imports → no network; proves the lint pass is a gate, not a blanket block.
    const r = await renderBulb(wrap(`document.getElementById('app')!.textContent = 'hi'`))
    expect(r.error).toBeUndefined()
    expect(r.html).toBeTruthy()
  })
})
