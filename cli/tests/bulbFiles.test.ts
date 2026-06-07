import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import * as path from 'path'
import { listBulbFiles } from '../src/serve/bulbFiles.js'

/**
 * The project walk lists every `*.bulb.md` under cwd with its frontmatter name. No filename is
 * special-cased: a user file named `claude.bulb.md` is an ordinary user bulb, listed like any other.
 * (Self-exclusion of the running mirror lives in the server registry via the `agent` field, not in
 * this file walk — TB-Agent-Mirror.md.)
 */
describe('listBulbFiles', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'tb-walk-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('lists user bulbs with their frontmatter names, skipping node_modules', async () => {
    await writeFile(path.join(dir, 'my-app.bulb.md'), '---\nname: My App\n---\n')
    await writeFile(path.join(dir, 'claude.bulb.md'), '---\nname: Claude Bulb\n---\n')   // just a user bulb now
    await mkdir(path.join(dir, 'node_modules', 'pkg'), { recursive: true })
    await writeFile(path.join(dir, 'node_modules', 'pkg', 'dep.bulb.md'), '---\nname: Dep\n---\n')

    const names = listBulbFiles(dir).map(f => f.name).sort()
    expect(names).toEqual(['Claude Bulb', 'My App'])   // both user bulbs; node_modules skipped
    expect(names).not.toContain('Dep')
  })
})
