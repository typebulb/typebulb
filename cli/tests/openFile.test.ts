import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { fileURLToPath } from 'url'
import { openFile } from '../agents/claude/server.js'
import { citationTarget } from '../agents/core/client/markdown.js'

/**
 * The mirror's openFile RPC routes a clicked file-citation path to the editor. That path is
 * attacker-influenced — it rides a markdown link in the rendered transcript (assistant text,
 * web-fetched content, MCP / sub-agent output, or a tool-input path) — so openFile confines it to a
 * real file. openInEditor already runs no shell (editor.test.ts), but refusing a non-file is the
 * version-independent backstop (the Windows launch still hops through cmd.exe): a citation names an
 * existing file by contract, and an injection payload like `src/app.ts & <cmd>` is not one.
 */
describe('openFile — confines a citation to a real file (M5 backstop)', () => {
  const saved = { ...process.env }
  // A bogus editor so the liveness case never launches a real IDE.
  beforeAll(() => { process.env.TYPEBULB_EDITOR = 'tb-no-such-editor-xyz' })
  afterAll(() => { process.env = { ...saved } })

  it('refuses a path that is not an existing file', async () => {
    expect(await openFile('src/app.ts & echo pwned')).toEqual({ ok: false, error: 'file not found' })
    expect(await openFile('../../../../etc/passwd-does-not-exist')).toEqual({ ok: false, error: 'file not found' })
  })

  it('opens an existing real file (liveness — the fix must not over-restrict)', async () => {
    expect(await openFile(fileURLToPath(import.meta.url))).toEqual({ ok: true })
  })
})

/**
 * The client half of the same path: which hrefs are citations, and what path + line reach openFile.
 * Agents cite files in spellings neither of them asked us about — Claude Code a relative path with
 * `#Lnnn`, Codex an absolute one with `:line` — so the parse takes both rather than the transcript
 * being rewritten per harness.
 */
describe('citationTarget — the href spellings that open a file', () => {
  it('takes a relative path with a #Lnnn anchor (Claude Code)', () => {
    expect(citationTarget('src/engine.ts')).toEqual({ path: 'src/engine.ts', line: undefined })
    expect(citationTarget('src/engine.ts#L105')).toEqual({ path: 'src/engine.ts', line: 105 })
    expect(citationTarget('src/engine.ts#L555-L940')).toEqual({ path: 'src/engine.ts', line: 555 })
  })

  it('takes an absolute path with a :line suffix (Codex)', () => {
    expect(citationTarget('C:/p/src/App.tsx:68')).toEqual({ path: 'C:/p/src/App.tsx', line: 68 })
    expect(citationTarget('C:/p/src/App.tsx:68:5')).toEqual({ path: 'C:/p/src/App.tsx', line: 68 })
    // A bare drive colon is not a line anchor — the digits are what distinguish them.
    expect(citationTarget('C:/p/docs/Bench.md')).toEqual({ path: 'C:/p/docs/Bench.md', line: undefined })
  })

  it('strips a file URL leading slash off a drive path', () => {
    // Left on, the browser resolves it against the page origin — the http://localhost:<port>/C:/… case.
    expect(citationTarget('/C:/p/docs/Handoff.md')).toEqual({ path: 'C:/p/docs/Handoff.md', line: undefined })
    expect(citationTarget('/C:/p/docs/Handoff.md:12')).toEqual({ path: 'C:/p/docs/Handoff.md', line: 12 })
    // A posix absolute path keeps its slash.
    expect(citationTarget('/var/log/app.log')).toEqual({ path: '/var/log/app.log', line: undefined })
  })

  it('leaves anything with a scheme to the browser', () => {
    for (const href of ['https://example.com/a.md', 'http://localhost:3000/x', '//cdn/x.js', '#section', 'mailto:a@b.c', ''])
      expect(citationTarget(href)).toBeUndefined()
  })

  it('percent-decodes the path, as the href carries it encoded', () => {
    expect(citationTarget('docs/my%20plan.md#L3')).toEqual({ path: 'docs/my plan.md', line: 3 })
  })
})
