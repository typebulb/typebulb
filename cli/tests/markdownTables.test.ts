import { describe, it, expect } from 'vitest'
import { mdRenderToHtml } from '../agents/claude/client/markdown.js'

/**
 * A markdown table chops onto its own row like an svg/bulb embed: the `table_open`/`table_close`
 * render rules wrap it in the same `<div class="embed table-embed">` the fence rule stamps on svg/bulb,
 * so it inherits the stripe-chop. Gated to assistant turns — a table in a user prompt (env.userMessage)
 * stays a plain `<table>` inside the opaque user card, where the chop would clash. Spread (lane breakout)
 * is a mount-time measurement (fitTableEmbeds), so it's not visible in this DOM-less render
 * (Specs/Typebulb-CLI-Agent-Viewer.md, "Rendering").
 */

const table = ['| a | b |', '| - | - |', '| 1 | 2 |'].join('\n')

describe('markdown table embed', () => {
  it('wraps an assistant-turn table in the chop embed', () => {
    const html = mdRenderToHtml(table)
    expect(html).toContain('<div class="embed table-embed">')
    expect(html).toContain('<table>')
    expect(html).toMatch(/<\/table>\s*<\/div>/)
  })

  it('leaves a user-turn table as a plain table (no chop against the user card)', () => {
    const html = mdRenderToHtml(table, { userMessage: true })
    expect(html).toContain('<table>')
    expect(html).not.toContain('table-embed')
  })

  it('does not start unspread — spread is decided at mount by measurement, not in the markup', () => {
    expect(mdRenderToHtml(table)).not.toContain('spread')
  })

  it('wraps each of two tables separately', () => {
    const html = mdRenderToHtml(`${table}\n\nprose\n\n${table}`)
    expect(html.match(/table-embed/g)?.length).toBe(2)
    expect(html).toContain('prose')
  })
})
