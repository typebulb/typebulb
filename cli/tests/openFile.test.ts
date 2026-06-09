import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { fileURLToPath } from 'url'
import { openFile } from '../agents/claude/server.js'

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
