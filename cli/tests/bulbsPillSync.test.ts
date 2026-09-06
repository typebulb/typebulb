import { afterEach, describe, expect, it, vi } from 'vitest'
import { BulbsPill } from '../agents/core/client/bulbsPill.js'
import { pathKey } from '../agents/core/client/util.js'

const row = { path: 'C:/project/typebulbs/u/ben/counter.bulb.md', name: 'Counter', recent: 0 }

function setup(verb: 'push' | 'pull', result: { ok: boolean; conflict?: boolean; error?: string }) {
  vi.useFakeTimers()
  vi.stubGlobal('tb', { server: {
    pushLocalBulb: vi.fn().mockResolvedValue(result),
    pullRemoteBulb: vi.fn().mockResolvedValue(result),
  } })
  const pill = new BulbsPill()
  const key = `${pathKey(row.path)}:${verb}`
  const frames: { busy: boolean; done: boolean; conflict: boolean }[] = []
  vi.spyOn(pill, 'update').mockImplementation(() => {
    frames.push({ busy: pill.syncBusy.has(key), done: pill.syncDone.has(key), conflict: !!pill.pendingOverwrite })
  })
  // The follow-up listing is independent of the transfer and can outlast the entire tick.
  let finishRefresh!: () => void
  const refresh = new Promise<void>(resolve => { finishRefresh = resolve })
  vi.spyOn(pill, verb === 'push' ? 'refreshMine' : 'refreshFiles').mockReturnValue(refresh)
  return { pill, frames, finishRefresh }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('launcher transfer acknowledgment', () => {
  it.each(['push', 'pull'] as const)('%s renders its success tick before a slow listing refresh', async verb => {
    const { pill, frames, finishRefresh } = setup(verb, { ok: true })
    const transfer = pill.syncRow(row, verb)
    expect(frames.at(-1)).toMatchObject({ busy: true, done: false })
    await vi.advanceTimersByTimeAsync(0)
    expect(frames.at(-1)).toMatchObject({ busy: false, done: true })
    await vi.advanceTimersByTimeAsync(1199)
    expect(frames.at(-1)).toMatchObject({ busy: false, done: true })
    await vi.advanceTimersByTimeAsync(1)
    expect(frames.at(-1)).toMatchObject({ busy: false, done: false })
    finishRefresh()
    await transfer
    expect(frames.at(-1)).toMatchObject({ busy: false, done: false })
  })

  it('renders a conflict without waiting for the listing, and never ticks success', async () => {
    const { pill, frames, finishRefresh } = setup('push', { ok: false, conflict: true })
    const transfer = pill.syncRow(row, 'push')
    await vi.advanceTimersByTimeAsync(0)
    expect(frames.at(-1)).toEqual({ busy: false, done: false, conflict: true })
    finishRefresh()
    await transfer
  })
})
