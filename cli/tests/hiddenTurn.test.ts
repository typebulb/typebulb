import { describe, it, expect } from 'vitest'
import { appendFileSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { isHiddenTurn } from '../agents/claude/server.js'
import { ClaudeAdapter } from '../agents/claude/server/adapter.js'
import { readTranscript } from '../agents/core/server/transcript.js'

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

// A fresh CC config root holding one session's sub-agent folder.
const cwd = 'C:\\Code\\fixture'
function subagents() {
  const root = mkdtempSync(join(tmpdir(), 'tb-claude-'))
  const kids = join(root, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), 'sess', 'subagents')
  mkdirSync(kids, { recursive: true })
  return { root, kids }
}

// A child is running only while mid-turn in a process that is still alive. Through CC 2.1.272 a
// finished child could end with no stop_reason, so its tail reads mid-turn forever; a `--resume`
// revives the session's process, and without this gate those children turned green again.
describe('listChildren gates a mid-turn tail on the live process', () => {
  const { root, kids } = subagents()
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

// A child's token figure and its running state are read from the file's tail. One tool result can
// fill that window (an image read runs to 600KB), leaving no response in it, or no turn at all.
describe('listChildren reads past tool results that fill the tail window', () => {
  const { root, kids } = subagents()
  const kid = join(kids, 'agent-kid.jsonl')
  const line = (e: unknown) => JSON.stringify(e) + '\n'
  // The small entry CC writes after each result is what keeps the window from reading as one line.
  const result = line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'x'.repeat(300 * 1024) }] } })
    + line({ type: 'attachment' })
  writeFileSync(kid,
    line({ type: 'user', message: { content: 'Read the sheets.' } }) +
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: 'Read', input: {} }], stop_reason: 'tool_use', usage: { input_tokens: 2, output_tokens: 8, cache_read_input_tokens: 400 } } }) +
    result)
  const kidRow = () => { const { tokens, running } = new ClaudeAdapter(root).listChildren(cwd, 'sess')[0]!; return { tokens, running } }

  it('widens on a first read, then carries the count and still reads the turn as more results land', () => {
    expect(kidRow()).toEqual({ tokens: 410, running: true })
    appendFileSync(kid, result)
    expect(kidRow()).toEqual({ tokens: 410, running: true })
  })
})

// CC records a failed request as a reply of its own. A child with nothing else has no count to show,
// but its row still names its model, from the attachment at the head of its file, and says it fails.
describe('listChildren reads a child whose only reply is an API error', () => {
  const { root, kids } = subagents()
  writeFileSync(join(kids, 'agent-kid.jsonl'), [
    { type: 'user', message: { content: 'Drive the run.' } },
    { type: 'attachment', attachment: { type: 'model', identity: { modelId: 'claude-opus-5-5' } } },
    { type: 'assistant', isApiErrorMessage: true, message: { model: '<synthetic>', content: [{ type: 'text', text: 'API Error: 529 Overloaded.' }], stop_reason: 'stop_sequence', usage: { input_tokens: 0, output_tokens: 0 } } },
  ].map(e => JSON.stringify(e)).join('\n') + '\n')

  it('names the model, shows no tokens, and reads as failing', () => {
    const { model, tokens, failing } = new ClaudeAdapter(root).listChildren(cwd, 'sess')[0]!
    expect({ model, tokens, failing }).toEqual({ model: 'opus-5-5', tokens: undefined, failing: true })
  })
})

// From CC 2.1.289 a finished child's last entry is its SubagentHandback's result, with no closing
// reply after it. A message the parent sends later is a new user turn, and wakes it.
describe('listChildren reads a child ended by its hand-back as done', () => {
  const { root, kids } = subagents()
  const kid = join(kids, 'agent-kid.jsonl')
  const line = (e: unknown) => JSON.stringify(e) + '\n'
  writeFileSync(kid,
    line({ type: 'user', message: { content: 'Map the split.' } }) +
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'h', name: 'SubagentHandback', input: { message: 'Done.' } }], stop_reason: null } }) +
    line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'h', content: 'Report delivered to your caller.' }] } }))
  const running = () => new ClaudeAdapter(root).listChildren(cwd, 'sess')[0]?.running

  it('is done after the hand-back, and running again once messaged', () => {
    expect(running()).toBe(false)
    appendFileSync(kid, line({ type: 'user', message: { content: 'One more check, please.' } }))
    expect(running()).toBe(true)
  })
})

// CC parents each parallel call's result on its own call, so the file is a graph and a walk from the
// leaf passes through one branch. The linker chains a message's entries in the order written.
describe('a parallel tool call keeps every result', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'tb-claude-')), 'session.jsonl')
  const call = (uuid: string, parentUuid: string, id: string) =>
    ({ type: 'assistant', uuid, parentUuid, message: { id: 'msg_1', content: [{ type: 'tool_use', id, name: 'Read', input: {} }], stop_reason: 'tool_use' } })
  const result = (uuid: string, parentUuid: string, id: string) =>
    ({ type: 'user', uuid, parentUuid, message: { content: [{ type: 'tool_result', tool_use_id: id, content: id }] } })
  writeFileSync(file, [
    { type: 'user', uuid: 'u', message: { content: 'Read both.' } },
    call('a1', 'u', 't1'),
    call('a2', 'a1', 't2'),
    result('r1', 'a1', 't1'),
    result('r2', 'a2', 't2'),
    { type: 'assistant', uuid: 'a3', parentUuid: 'r2', message: { id: 'msg_2', content: [{ type: 'text', text: 'Read.' }], stop_reason: 'end_turn' } },
  ].map(e => JSON.stringify(e)).join('\n') + '\n')

  it('reads both results, not only the one on the leaf\'s own branch', () => {
    const results = readTranscript(new ClaudeAdapter(), file, 'main').filter(e => e.type === 'tool_result')
    expect(results.map(e => e.type === 'tool_result' && e.id)).toEqual(['t1', 't2'])
  })
})

// What a child's Status reads (TB-Agent-Children.md): a background call stays open until CC's notice
// names it, an error with no exit never ran, and neither carrier of the notice renders.
describe('apply gives the child Status its call outcomes', () => {
  const a = new ClaudeAdapter()
  const notice = '<task-notification>\n<task-id>b1</task-id>\n<tool-use-id>t1</tool-use-id>\n<output-file>C:\tmp\b1.output</output-file>\n<status>failed</status>\n<summary>Background command "npm test" failed with exit code 2</summary>\n</task-notification>'
  const result = (content: string, is_error = false) =>
    ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content, is_error }] } }) as never

  it('reads the notice from either carrier as the call\'s end, with its exit code', () => {
    const done = { type: 'task_done', id: 't1', outcome: 'failed', exit: 2, output: 'C:\tmp\b1.output' }
    expect(a.apply({ type: 'attachment', attachment: { type: 'queued_command', prompt: notice } } as never, 0).events).toEqual([done])
    expect(a.apply({ type: 'user', isMeta: true, message: { content: notice } } as never, 0).events).toEqual([done])
  })

  it('marks a backgrounded result, a failed run\'s exit, and an error that never ran', () => {
    const [bg] = a.apply(result('Command running in background with ID: b1. Output is being written to: x'), 0).events as never as { background?: boolean }[]
    const [ran] = a.apply(result('Exit code 1\nFAIL src/a.test.ts', true), 0).events as never as { exit?: number; refused?: boolean }[]
    const [blocked] = a.apply(result('<tool_use_error>Blocked: sleep 30 followed by: cat</tool_use_error>', true), 0).events as never as { exit?: number; refused?: boolean }[]
    expect(bg!.background).toBe(true)
    expect([ran!.exit, ran!.refused]).toEqual([1, undefined])
    expect([blocked!.exit, blocked!.refused]).toEqual([undefined, true])
  })
})

describe('a tool result quoting a task notification', () => {
  // A reviewer grepping transcripts printed notices; read as one, its result vanished and the call
  // read as interrupted for good.
  it('stays a tool result', () => {
    const a = new ClaudeAdapter()
    const quoted = '<task-notification>\n<tool-use-id>t9</tool-use-id>\n<status>completed</status>\n</task-notification>'
    const events = a.apply({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: quoted }] } } as never, 0).events
    expect(events.map(e => e.type)).toEqual(['tool_result'])
  })
})
