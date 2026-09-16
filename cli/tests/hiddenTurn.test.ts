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
 * tool_result as a completion showed every background child as finished the moment it started.
 */
describe('settlesSpawns', () => {
  const a = new ClaudeAdapter()
  const toolResult = (id: string, toolUseResult?: unknown) =>
    ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id }] }, toolUseResult }) as never

  it('settles a foreground Agent call, whose one result IS the completion', () => {
    expect(a.settlesSpawns(toolResult('toolu_fg'))).toEqual(['toolu_fg'])
  })

  it('does NOT settle a background launch, which is answered before the agent runs', () => {
    expect(a.settlesSpawns(toolResult('toolu_bg', { isAsync: true, status: 'async_launched' }))).toEqual([])
  })

  it('settles on the task-notification that reports the background agent stopping', () => {
    const note = (status: string) => ({
      type: 'attachment',
      attachment: { type: 'queued_command', prompt: `<task-notification>\n<task-id>a1b2</task-id>\n<tool-use-id>toolu_bg</tool-use-id>\n<status>${status}</status>\n</task-notification>` },
    }) as never
    // Every status is terminal — the notification "fires each time this agent stops". The task-id
    // rides along too (some notifications carry no tool-use-id), so assert on membership.
    for (const status of ['completed', 'failed', 'killed', 'stopped']) {
      expect(a.settlesSpawns(note(status))).toContain('toolu_bg')
    }
  })

  it('settles nothing for an ordinary turn', () => {
    expect(a.settlesSpawns({ type: 'assistant', message: { content: [] } } as never)).toEqual([])
    expect(a.settlesSpawns({ type: 'user', message: { content: 'hello' } } as never)).toEqual([])
  })
})

/**
 * The three shapes a task-notification actually arrived in, all found stuck-green in one field
 * session (2026-09-16). Each was a silent miss: the agent showed as running for hours.
 */
describe('settlesSpawns reads a task-notification however it arrives', () => {
  const a = new ClaudeAdapter()
  const userTurn = (text: string) => ({ type: 'user', message: { content: text } }) as never

  it('reads one delivered as a plain user turn, not only as an attachment', () => {
    const text = '<task-notification>\n<task-id>a1b2</task-id>\n<tool-use-id>toolu_x</tool-use-id>\n<status>completed</status>\n</task-notification>'
    expect(a.settlesSpawns(userTurn(text))).toContain('toolu_x')
  })

  it('reads one written without a closing tag', () => {
    const text = '<task-notification>\n<task-id>a1b2</task-id>\n<tool-use-id>toolu_y</tool-use-id>\n<status>completed</status>'
    expect(a.settlesSpawns(userTurn(text))).toContain('toolu_y')
  })

  it('settles by task-id too, for the notifications that carry no tool-use-id', () => {
    const text = '<task-notification>\n<task-id>agentzzz</task-id>\n<status>completed</status>\n</task-notification>'
    expect(a.settlesSpawns(userTurn(text))).toContain('agentzzz')
  })

  // The enqueue record: written when the agent STOPS, not when the notification is delivered, so it
  // is the only carrier that arrives when the parent is idle with nobody to deliver to. It has no
  // uuid, so it reaches the adapter through the settlement scan and never through the chain.
  it('reads the queue-operation record CC writes at the moment the agent stops', () => {
    const enqueue = {
      type: 'queue-operation', operation: 'enqueue',
      content: '<task-notification>\n<task-id>a1b2</task-id>\n<tool-use-id>toolu_q</tool-use-id>\n<status>completed</status>\n</task-notification>',
    } as never
    expect(a.settlesSpawns(enqueue)).toContain('toolu_q')
  })

  it('still settles nothing for a user turn that merely mentions the words', () => {
    expect(a.settlesSpawns(userTurn('what does a task-notification look like?'))).toEqual([])
  })
})
