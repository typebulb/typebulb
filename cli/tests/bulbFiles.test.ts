import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, stat, utimes } from 'fs/promises'
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
    await writeFile(path.join(dir, 'claude.bulb.md'), '---\nname: My Notes\n---\n')   // named `claude` yet not special-cased — an ordinary user bulb
    await mkdir(path.join(dir, 'node_modules', 'pkg'), { recursive: true })
    await writeFile(path.join(dir, 'node_modules', 'pkg', 'dep.bulb.md'), '---\nname: Dep\n---\n')

    const names = listBulbFiles(dir).map(f => f.name).sort()
    expect(names).toEqual(['My App', 'My Notes'])   // both user bulbs; node_modules skipped
    expect(names).not.toContain('Dep')
  })

  it('flags a headless (server.ts, no code.tsx) bulb as serverOnly', async () => {
    const web = ['---', 'format: typebulb/v1', 'name: Web', '---', '', '**code.tsx**', '', '```tsx', 'export {}', '```', ''].join('\n')
    const headless = ['---', 'format: typebulb/v1', 'name: Headless', '---', '', '**server.ts**', '', '```ts', 'export function go() {}', '```', ''].join('\n')
    await writeFile(path.join(dir, 'web.bulb.md'), web)
    await writeFile(path.join(dir, 'headless.bulb.md'), headless)

    const byName = new Map(listBulbFiles(dir).map(f => [f.name, f.serverOnly]))
    expect(byName.get('Web')).toBe(false)
    expect(byName.get('Headless')).toBe(true)
  })

  it('re-parses only when mtime changes (the poll-beat cache)', async () => {
    const file = path.join(dir, 'cached.bulb.md')
    await writeFile(file, '---\nname: Before\n---\n')
    // Pin a whole-ms mtime first: utimes can't restore NTFS's sub-ms fraction, and the cache
    // compares mtimeMs exactly.
    const { atime, mtime } = await stat(file)
    const pinned = new Date(Math.floor(mtime.getTime()))
    await utimes(file, atime, pinned)
    expect(listBulbFiles(dir)[0].name).toBe('Before')

    // Rewrite but restore the pinned mtime: the cache must serve the old parse (mtime is the key).
    await writeFile(file, '---\nname: After\n---\n')
    await utimes(file, atime, pinned)
    expect(listBulbFiles(dir)[0].name).toBe('Before')

    // A real mtime bump re-parses.
    await utimes(file, atime, new Date(pinned.getTime() + 1000))
    expect(listBulbFiles(dir)[0].name).toBe('After')
  })
})
