import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/**
 * A watcher error must never crash the server (TB-Assets.md § Watch): chokidar emits 'error'
 * for e.g. a Windows EBUSY on a file still mid-download in a watched assets/ dir, and an
 * unhandled 'error' on an EventEmitter throws out of emit — which took down a live bulb
 * server in the field. Chokidar is mocked so the error is deterministic.
 */

const emitters: FakeWatcher[] = []
class FakeWatcher extends EventEmitter {
  close = vi.fn(async () => {})
}

vi.mock('chokidar', () => ({
  default: { watch: () => { const w = new FakeWatcher(); emitters.push(w); return w } },
}))

const { watchPath, watchAssets } = await import('../src/serve/watcher.js')

describe('watchPath error resilience', () => {
  it('survives a watcher error and keeps delivering changes', async () => {
    const onChange = vi.fn()
    const cleanup = watchPath({ target: 'x', onChange, events: 'all', debounceMs: 0 })
    const w = emitters.at(-1)!

    expect(() => w.emit('error', new Error('EBUSY: resource busy or locked'))).not.toThrow()

    w.emit('all', 'add', 'assets/pic.jpg')
    await new Promise(r => setTimeout(r, 10))
    expect(onChange).toHaveBeenCalledTimes(1)

    cleanup()
    expect(w.close).toHaveBeenCalled()
  })
})

/**
 * Watching `assets/` itself pinned the bulb's folder: Windows refuses a rename or move of every
 * ancestor of a watched directory (TB-Assets.md § Watch), so the folder couldn't be moved while
 * the bulb ran. Rooting the watch at the folder keeps it movable. Real fs — the pin is the OS's.
 */
describe('watchAssets', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-assets-watch-'))
  const bulbDir = path.join(root, 'birds')
  const assets = path.join(bulbDir, 'assets')
  // Linux before Node 20 has no recursive watch and falls back to chokidar, mocked in this file.
  const recursive = (() => {
    try { fs.watch(root, { recursive: true }, () => {}).close(); return true } catch { return false }
  })()

  it('leaves the bulb folder movable while it watches', async () => {
    fs.mkdirSync(assets, { recursive: true })
    fs.writeFileSync(path.join(assets, 'robin.png'), 'x')
    const cleanup = watchAssets(bulbDir, () => {})
    expect(() => fs.renameSync(bulbDir, `${bulbDir}-moved`)).not.toThrow()
    fs.renameSync(`${bulbDir}-moved`, bulbDir)
    cleanup()
  })

  it.skipIf(!recursive)('reloads on an asset save but not on the bulb folder\'s other files', async () => {
    fs.mkdirSync(assets, { recursive: true })
    const onChange = vi.fn()
    const cleanup = watchAssets(bulbDir, onChange, 10)
    const settle = () => new Promise(r => setTimeout(r, 400))

    fs.writeFileSync(path.join(bulbDir, 'run.json'), '{}')   // tb.fs output: never a reload
    await settle()
    expect(onChange).not.toHaveBeenCalled()

    fs.writeFileSync(path.join(assets, 'robin.png'), 'new bytes')
    await settle()
    expect(onChange).toHaveBeenCalled()
    cleanup()
  })
})
