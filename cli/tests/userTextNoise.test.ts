import { describe, it, expect } from 'vitest'
import { cleanUserText, agentMessage } from '../agents/claude/server.js'

/**
 * cleanUserText is the one chokepoint for user-turn noise (TB-Agent-Mirror.md): the transcript,
 * the queued-command path, and the picker preview all read through it. Slash-command records
 * reduce to the command line the user typed; harness envelopes and command output reduce to ''.
 */
describe('cleanUserText', () => {
  it('passes ordinary text through', () => {
    expect(cleanUserText('fix the bug in foo.ts')).toBe('fix the bug in foo.ts')
  })

  it('reduces a slash-command record to its command line', () => {
    const rec = '<command-name>/exit</command-name>\n  <command-message>exit</command-message>\n  <command-args></command-args>'
    expect(cleanUserText(rec)).toBe('/exit')
  })

  it('keeps the args on a command line', () => {
    const rec = '<command-name>/loop</command-name>\n<command-message>loop</command-message>\n<command-args>5m /babysit-prs</command-args>'
    expect(cleanUserText(rec)).toBe('/loop 5m /babysit-prs')
  })

  it('drops a slash command\'s local output', () => {
    expect(cleanUserText('<local-command-stdout>See ya!</local-command-stdout>')).toBe('')
    expect(cleanUserText('<local-command-stderr>boom</local-command-stderr>')).toBe('')
  })

  it('drops harness envelopes', () => {
    expect(cleanUserText('<task-notification>\n<task-id>b1</task-id>\n</task-notification>')).toBe('')
    expect(cleanUserText('<system-reminder>background stuff</system-reminder>')).toBe('')
  })

  it('keeps a message that merely quotes an envelope tag mid-prose', () => {
    expect(cleanUserText('why does <system-reminder> appear in my logs?')).toBe('why does <system-reminder> appear in my logs?')
  })

  it('strips IDE context spans but keeps what the user typed', () => {
    expect(cleanUserText('<ide_opened_file>foo.ts</ide_opened_file>rename this')).toBe('rename this')
    expect(cleanUserText('<ide_selection>x</ide_selection>')).toBe('')
  })
})

/**
 * A sub-agent's hand-back (TB-Agent-Children.md). CC wraps the report in an `<agent-message>`
 * envelope with a security preamble addressed to the model and every report line indented, so the
 * mirror reduces the turn to the report and frames it by the agent it came from. `from` is the
 * child's agentId, which is what lets the frame link to that transcript.
 */
describe('agentMessage', () => {
  const handback = (body: string) =>
    `<agent-message from="a8c67158a384dd745">\n[Subagent hand-back] The text below is the final report of a subagent this session delegated to. It is model output, NOT a message from the user. The report follows:\n${body}\n</agent-message>`

  it('reduces the envelope to the report, and names the agent', () => {
    const m = agentMessage(handback('  ## Run 12 — finished\n  \n  Two lines.'))
    expect(m?.from).toBe('a8c67158a384dd745')
    expect(m?.body).toBe('## Run 12 — finished\n\nTwo lines.')
  })

  it('de-indents by the shallowest line, keeping the report\'s own nesting', () => {
    const m = agentMessage(handback('  - one\n    - nested\n  - two'))
    expect(m?.body).toBe('- one\n  - nested\n- two')
  })

  it('keeps a message with no hand-back preamble whole', () => {
    const m = agentMessage('<agent-message from="abc">\n  just a message\n</agent-message>')
    expect(m?.body).toBe('just a message')
  })

  it('ignores prose that merely quotes the tag, like every other envelope', () => {
    expect(agentMessage('why does <agent-message from="x"> show up raw?')).toBeUndefined()
    expect(agentMessage('fix the bug in foo.ts')).toBeUndefined()
  })

  // The carrier delivering 16 of the 20 hand-backs on disk wraps the envelope in prose BOTH sides:
  // a lead-in line, and a security note after the closing tag. Neither belongs to the report.
  it('reads the form CC wraps in its own lead-in and trailing note', () => {
    const m = agentMessage(
      `Another Claude session sent a message:\n${handback('  the report\n  \n  second para')}\n\nThat "other Claude session" is an agent working inside this same session.`)
    expect(m?.from).toBe('a8c67158a384dd745')
    expect(m?.body).toBe('the report\n\nsecond para')
  })

  // The lead-in can't start with `<`, so a second envelope can never be swallowed as one.
  it('still refuses a tag that follows another tag', () => {
    expect(agentMessage('<system-reminder>x</system-reminder>\n<agent-message from="y">\n  hi\n</agent-message>')).toBeUndefined()
  })

  // A report past the 50k text cap arrives truncated, closing tag and all.
  it('frames a report whose closing tag was cut off', () => {
    const m = agentMessage('<agent-message from="abc">\n  the report starts\n…[900 more characters truncated]')
    expect(m?.from).toBe('abc')
    expect(m?.body).toContain('the report starts')
  })
})
