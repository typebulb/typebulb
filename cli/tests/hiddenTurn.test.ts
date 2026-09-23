import { describe, it, expect } from 'vitest'
import { isHiddenTurn } from '../agents/claude/server.js'
import { ClaudeAdapter } from '../agents/claude/server/adapter.js'

/**
 * The mirror hides non-conversational turns structurally (TB-Agent-Mirror.md):
 * CC's isMeta injections — a launched skill's full body, slash-command caveats, /loop resume
 * nudges. This is what keeps a `Skill claude-api` row from being followed by 20 pages of the
 * skill's body. Anchored on CC's own flags, not a content heuristic.
 *
 * Which THREAD an entry belongs to is a separate question, asked against the view rather than as a
 * display filter (TB-Agent-Children.md): a transcript file never mixes threads, and a child's own
 * file is all sidechain, so the flag only means "off-thread" relative to what is being rendered.
 */
describe('isHiddenTurn', () => {
  it('hides CC isMeta injections (skill body, caveat, resume nudge)', () => {
    expect(isHiddenTurn({ isMeta: true })).toBe(true)
  })

  it('keeps an ordinary human-authored turn (neither flag set)', () => {
    expect(isHiddenTurn({})).toBe(false)
    expect(isHiddenTurn({ isMeta: false })).toBe(false)
  })
})

describe('isSidechain is relative to the rendered thread', () => {
  const a = new ClaudeAdapter()

  it('drops a sidechain entry from the session view, keeps an ordinary one', () => {
    expect(a.isSidechain({ isSidechain: true } as never, 'main')).toBe(true)
    expect(a.isSidechain({} as never, 'main')).toBe(false)
  })

  it('inverts inside a child transcript, whose every entry is sidechain', () => {
    expect(a.isSidechain({ isSidechain: true } as never, 'child')).toBe(false)
    expect(a.isSidechain({} as never, 'child')).toBe(true)
  })
})

/**
 * What settles a spawn, which is what marks a child finished (TB-Agent-Children.md). CC answers a
 * FOREGROUND Agent call when its agent finishes, but a BACKGROUND one at launch — so reading every
 * tool_result as a completion showed every background child as finished the moment it started. And
 * a stop is not final: a SendMessage wakes a finished background agent, which notifies again.
 */
describe('spawnSignals', () => {
  const a = new ClaudeAdapter()
  // The ids an entry says have STOPPED; a wake is asserted on the signal itself.
  const settles = (e: never) => a.spawnSignals(e).filter(s => s.stopped).map(s => s.id)
  const toolResult = (id: string, toolUseResult?: unknown) =>
    ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id }] }, toolUseResult }) as never

  it('settles a foreground Agent call, whose one result IS the completion', () => {
    expect(settles(toolResult('toolu_fg'))).toEqual(['toolu_fg'])
  })

  it('does NOT settle a background launch, which is answered before the agent runs', () => {
    expect(settles(toolResult('toolu_bg', { isAsync: true, status: 'async_launched' }))).toEqual([])
  })

  it('wakes, not settles, the agent a SendMessage resumed — it runs on and notifies again', () => {
    const resume = {
      type: 'user', timestamp: '2026-09-22T12:08:54.378Z',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_send' }] },
      toolUseResult: { success: true, message: 'Resuming agent afc5957', resumedAgentId: 'afc5957b70afd1cdf' },
    } as never
    expect(a.spawnSignals(resume)).toEqual([{ id: 'afc5957b70afd1cdf', stopped: false, at: Date.parse('2026-09-22T12:08:54.378Z') }])
  })

  // The parent records nothing: the child's own Bash watcher finished after it stopped, and CC
  // delivered that into the child's file, where the child ran on for half an hour.
  it('wakes a child that its own background task resumed, from the child\'s own file', () => {
    const selfWake = {
      type: 'user', isMeta: true, agentId: 'a82ce4ac8d0bef413', origin: { kind: 'task-notification' },
      timestamp: '2026-09-23T20:14:35.806Z',
      message: { content: '[SYSTEM NOTIFICATION - NOT USER INPUT]\n\n<task-notification>\n<task-id>bopnno3i5</task-id>\n<tool-use-id>toolu_bash</tool-use-id>\n<status>completed</status>' },
    } as never
    expect(a.spawnSignals(selfWake)).toContainEqual({ id: 'a82ce4ac8d0bef413', stopped: false, at: Date.parse('2026-09-23T20:14:35.806Z') })
  })

  it('settles on the task-notification that reports the background agent stopping', () => {
    const note = (status: string) => ({
      type: 'attachment',
      attachment: { type: 'queued_command', prompt: `<task-notification>\n<task-id>a1b2</task-id>\n<tool-use-id>toolu_bg</tool-use-id>\n<status>${status}</status>\n</task-notification>` },
    }) as never
    // Every status is terminal — the notification "fires each time this agent stops". The task-id
    // rides along too (some notifications carry no tool-use-id), so assert on membership.
    for (const status of ['completed', 'failed', 'killed', 'stopped']) {
      expect(settles(note(status))).toContain('toolu_bg')
    }
  })

  it('settles nothing for an ordinary turn', () => {
    expect(settles({ type: 'assistant', message: { content: [] } } as never)).toEqual([])
    expect(settles({ type: 'user', message: { content: 'hello' } } as never)).toEqual([])
  })
})

/**
 * The three shapes a task-notification actually arrived in, all found stuck-green in one field
 * session (2026-09-16). Each was a silent miss: the agent showed as running for hours.
 */
describe('spawnSignals reads a task-notification however it arrives', () => {
  const a = new ClaudeAdapter()
  const settles = (e: never) => a.spawnSignals(e).filter(s => s.stopped).map(s => s.id)
  const userTurn = (text: string) => ({ type: 'user', message: { content: text } }) as never

  it('reads one delivered as a plain user turn, not only as an attachment', () => {
    const text = '<task-notification>\n<task-id>a1b2</task-id>\n<tool-use-id>toolu_x</tool-use-id>\n<status>completed</status>\n</task-notification>'
    expect(settles(userTurn(text))).toContain('toolu_x')
  })

  it('reads one written without a closing tag', () => {
    const text = '<task-notification>\n<task-id>a1b2</task-id>\n<tool-use-id>toolu_y</tool-use-id>\n<status>completed</status>'
    expect(settles(userTurn(text))).toContain('toolu_y')
  })

  it('settles by task-id too, for the notifications that carry no tool-use-id', () => {
    const text = '<task-notification>\n<task-id>agentzzz</task-id>\n<status>completed</status>\n</task-notification>'
    expect(settles(userTurn(text))).toContain('agentzzz')
  })

  // The enqueue record: written when the agent STOPS, not when the notification is delivered, so it
  // is the only carrier that arrives when the parent is idle with nobody to deliver to. It has no
  // uuid, so it reaches the adapter through the settlement scan and never through the chain.
  it('reads the queue-operation record CC writes at the moment the agent stops', () => {
    const enqueue = {
      type: 'queue-operation', operation: 'enqueue',
      content: '<task-notification>\n<task-id>a1b2</task-id>\n<tool-use-id>toolu_q</tool-use-id>\n<status>completed</status>\n</task-notification>',
    } as never
    expect(settles(enqueue)).toContain('toolu_q')
  })

  // The `remove` written at delivery re-carries the text under the removal's own timestamp, which in
  // the field landed 200ms after a resume of that very agent: counted, it would undo the wake.
  it('ignores the queue removal, which is the delivery and not the stop', () => {
    const remove = {
      type: 'queue-operation', operation: 'remove', timestamp: '2026-09-22T12:10:45.963Z',
      content: '<task-notification>\n<task-id>a1b2</task-id>\n<tool-use-id>toolu_q</tool-use-id>\n<status>completed</status>\n</task-notification>',
    } as never
    expect(a.spawnSignals(remove)).toEqual([])
  })

  it('still settles nothing for a user turn that merely mentions the words', () => {
    expect(settles(userTurn('what does a task-notification look like?'))).toEqual([])
  })
})
