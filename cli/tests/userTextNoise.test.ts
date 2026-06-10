import { describe, it, expect } from 'vitest'
import { cleanUserText } from '../agents/claude/server.js'

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
