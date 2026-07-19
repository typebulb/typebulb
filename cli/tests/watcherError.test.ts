import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'events'

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

const { watchPath } = await import('../src/serve/watcher.js')

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
