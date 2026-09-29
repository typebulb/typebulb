import { describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
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

// A sub-agent's blocks are written while still streaming, stop_reason unset: an unfinished message
// is mid-turn, or the live turn flips to settled on every thinking block (the Raw/Reply wobble).
describe('chainWorking reads an unfinished message as mid-turn', () => {
  const a = new ClaudeAdapter()
  const leaf = (stop_reason: string | null, type = 'thinking') =>
    [{ type: 'assistant', message: { content: [{ type }], stop_reason } }] as never

  it('keeps working on a block with no stop_reason yet, or one whose tool call is coming', () => {
    expect(a.chainWorking(leaf(null))).toBe(true)
    expect(a.chainWorking(leaf('tool_use', 'text'))).toBe(true)
  })

  it('ends on a finished message', () => {
    expect(a.chainWorking(leaf('end_turn', 'text'))).toBe(false)
    expect(a.chainWorking(leaf('stop_sequence', 'text'))).toBe(false)
  })
})


// A child's running dot is this same answer read off its own file (TB-Agent-Children.md): every way
// CC wakes an agent delivers a turn there, so a delivered message is mid-turn whatever carried it.
describe('chainWorking reads a message delivered to an agent as a wake', () => {
  const a = new ClaudeAdapter()
  const done = { type: 'assistant', message: { content: [{ type: 'text', text: 'Recorded.' }], stop_reason: 'end_turn' } }

  it('wakes on the parent\'s message delivered after the agent stopped', () => {
    const delivered = { type: 'user', isMeta: true, message: { content: 'The coordinator sent a message while you were working:\nThe browser slot is yours.' } }
    expect(a.chainWorking([done] as never)).toBe(false)
    expect(a.chainWorking([done, delivered] as never)).toBe(true)
  })

  // Though isMeta, it is the parent's turn, not an injection: it renders, its lead-in dropped.
  it('renders that message as the parent\'s turn', () => {
    const delivered = { type: 'user', isMeta: true, message: { content: 'The coordinator sent a message while you were working:\nThe browser slot is yours.' } }
    expect(a.apply(delivered as never, 0).events).toEqual([{ type: 'user', text: 'The browser slot is yours.' }])
    expect(a.apply({ type: 'user', isMeta: true, message: { content: 'skill body' } } as never, 0).events).toEqual([])
  })
})

// A child is running only while mid-turn in a process that is still alive. Through CC 2.1.272 a
// finished child could end with no stop_reason, so its tail reads mid-turn forever; a `--resume`
// revives the session's process, and without this gate those children turned green again.
describe('listChildren gates a mid-turn tail on the live process', () => {
  const cwd = 'C:\Code\fixture'
  const root = mkdtempSync(join(tmpdir(), 'tb-claude-'))
  const kids = join(root, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), 'sess', 'subagents')
  mkdirSync(kids, { recursive: true })
  mkdirSync(join(root, 'sessions'))
  const kid = join(kids, 'agent-kid.jsonl')
  writeFileSync(kid, [
    { type: 'user', message: { content: 'Write a short story.' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'The chimpanzee sat in the fig tree.' }], stop_reason: null } },
  ].map(e => JSON.stringify(e)).join('\n') + '\n')
  writeFileSync(join(kids, 'agent-kid.meta.json'), JSON.stringify({ description: 'Story', toolUseId: 'toolu_k' }))
  const startedAt = Date.now()
  writeFileSync(join(root, 'sessions', '1.json'), JSON.stringify({ pid: process.pid, sessionId: 'sess', startedAt }))
  const running = () => new ClaudeAdapter(root).listChildren(cwd, 'sess')[0]?.running

  it('reads done when the child was last written before the live process started', () => {
    const before = new Date(startedAt - 60_000)
    utimesSync(kid, before, before)
    expect(running()).toBe(false)
  })

  it('reads running once the live process writes to it', () => {
    const after = new Date(startedAt + 1_000)
    utimesSync(kid, after, after)
    expect(running()).toBe(true)
  })
})
