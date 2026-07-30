import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'fs/promises'
import { realpathSync, unwatchFile } from 'fs'
import { tmpdir, homedir } from 'os'
import { join, dirname } from 'path'
import type { ChildProcess } from 'child_process'
import { PiRpcDriver } from '../agents/pi/server/driver.js'
import { trustNotice } from '../agents/pi/server/trust.js'
import { piExtensionSource } from '../agents/pi/server/piExtension.js'
import { writeOllamaProvider } from '../agents/pi/server/ollama.js'
import { applyPatch, discoverDiffKeys, patchOwnership } from '../agents/pi/server/piPatcherExtension.js'
import { createMirror } from '../agents/core/server/mirror.js'
import { AgentAdapter, type AgentDriver } from '../agents/core/server/adapter.js'
import type { SessionFile } from '../agents/core/events.js'

/**
 * The composer's pi driver (TB-Agent-Composer.md): the JSONL protocol logic over an injected fake
 * child, no pi install. Covers the routing (prompt idle / steer mid-turn), the draft lifecycle
 * (accumulate → retain on message_end → clearCompletedDraft), the toolkit layer (ambient status,
 * the dialog queue + respondUi, the allowlisted rpc passthrough — TB-Agent-Composer-Toolkit.md), and
 * death surfacing. The real spawn is a thin wrapper the test skips.
 */

class FakeChild extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  exitCode: number | null = null
  killed = false
  pid = 4242
  kill() { this.killed = true; return true }
}

// Driver + its fake, with the command lines the driver writes captured as parsed JSON.
function makeDriver(sessionFile?: string) {
  const child = new FakeChild()
  const sent: Record<string, unknown>[] = []
  let buf = ''
  child.stdin.on('data', (b: Buffer) => {
    buf += b.toString()
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (line.trim()) sent.push(JSON.parse(line))
    }
  })
  let command = ''
  const driver = new PiRpcDriver('C:\\proj', sessionFile, (cmd) => {
    command = cmd
    return child as unknown as ChildProcess
  })
  const emit = (e: Record<string, unknown>) => { child.stdout.write(JSON.stringify(e) + '\n') }
  const settle = () => new Promise<void>(res => setTimeout(res, 0))
  return { driver, child, sent, emit, settle, getCommand: () => command }
}

describe('PiRpcDriver', () => {
  it('spawns with --session for a bound file, without for a sessionless one, and resolves get_state', async () => {
    const bound = makeDriver('C:\\Users\\t\\.pi\\agent\\sessions\\--C--proj--\\2026_abc.jsonl')
    expect(bound.getCommand()).toBe('pi --mode rpc --session "C:\\Users\\t\\.pi\\agent\\sessions\\--C--proj--\\2026_abc.jsonl"')
    const blank = makeDriver()
    expect(blank.getCommand()).toBe('pi --mode rpc')
    await blank.settle()
    // Boot issues get_state; answering it resolves the created session file.
    const gs = blank.sent.find(c => c.type === 'get_state')!
    expect(gs).toBeDefined()
    blank.emit({ type: 'response', id: gs.id, success: true, data: { sessionFile: 'C:\\new.jsonl' } })
    await blank.settle()
    expect(blank.driver.sessionFile).toBe('C:\\new.jsonl')
  })

  it('routes send as prompt when idle and steer mid-turn', async () => {
    const { driver, sent, emit, settle } = makeDriver('C:\\s.jsonl')
    const p1 = driver.send('hello')
    await settle()
    const prompt = sent.find(c => c.type === 'prompt')!
    expect(prompt.message).toBe('hello')
    emit({ type: 'response', id: prompt.id, success: true })
    expect(await p1).toEqual({ ok: true })
    expect(driver.streaming).toBe(true)                       // optimistic until agent_start/agent_end

    emit({ type: 'agent_start' })
    await settle()
    const p2 = driver.send('actually, stop and do X')
    await settle()
    const steer = sent.find(c => c.type === 'steer')!
    expect(steer.message).toBe('actually, stop and do X')
    emit({ type: 'response', id: steer.id, success: true })
    expect(await p2).toEqual({ ok: true })

    emit({ type: 'agent_end' })
    await settle()
    expect(driver.streaming).toBe(false)
  })

  it('routes a mid-turn slash command as prompt+streamingBehavior (steer rejects extension commands)', async () => {
    const { driver, sent, emit, settle } = makeDriver('C:\\s.jsonl')
    emit({ type: 'agent_start' })
    await settle()
    const p = driver.send('/loud-noises now please')
    await settle()
    const prompt = sent.find(c => c.type === 'prompt')!
    expect(prompt).toBeDefined()
    expect(prompt.streamingBehavior).toBe('steer')
    expect(sent.find(c => c.type === 'steer')).toBeUndefined()
    emit({ type: 'response', id: prompt.id, success: true })
    expect(await p).toEqual({ ok: true })
    expect(driver.streaming).toBe(true)          // no optimistic overwrite — already streaming
  })

  it('routes a follow-up send: follow_up mid-turn, prompt+followUp for a mid-turn slash, plain prompt idle', async () => {
    const { driver, sent, emit, settle } = makeDriver('C:\\s.jsonl')
    // Idle: nothing to follow — an ordinary prompt, no streamingBehavior.
    const p0 = driver.send('do it', { followUp: true })
    await settle()
    const idle = sent.find(c => c.type === 'prompt')!
    expect(idle.streamingBehavior).toBeUndefined()
    emit({ type: 'response', id: idle.id, success: true })
    expect(await p0).toEqual({ ok: true })

    emit({ type: 'agent_start' })
    await settle()
    const p1 = driver.send('after that, also X', { followUp: true })
    await settle()
    const fu = sent.find(c => c.type === 'follow_up')!
    expect(fu.message).toBe('after that, also X')
    emit({ type: 'response', id: fu.id, success: true })
    expect(await p1).toEqual({ ok: true })

    // A mid-turn slash follow-up still must be a prompt (follow_up rejects extension commands).
    const p2 = driver.send('/cmd args', { followUp: true })
    await settle()
    const slash = sent.filter(c => c.type === 'prompt')[1]!
    expect(slash.streamingBehavior).toBe('followUp')
    emit({ type: 'response', id: slash.id, success: true })
    expect(await p2).toEqual({ ok: true })
  })

  it('tracks the pending queue from queue_update, clears when drained and on agent_end', async () => {
    const { driver, emit, settle } = makeDriver('C:\\s.jsonl')
    expect(driver.queue).toBeNull()
    emit({ type: 'queue_update', steering: ['focus on errors'], followUp: ['then summarize'] })
    await settle()
    expect(driver.queue).toEqual({ steering: ['focus on errors'], followUp: ['then summarize'] })
    emit({ type: 'queue_update', steering: [], followUp: [] })
    await settle()
    expect(driver.queue).toBeNull()
    emit({ type: 'queue_update', steering: ['x'], followUp: [] })
    emit({ type: 'agent_end' })
    await settle()
    expect(driver.queue).toBeNull()                            // belt: a finished turn has nothing queued
  })

  it('surfaces a rejected prompt as the send result, not a driver error', async () => {
    const { driver, sent, emit, settle } = makeDriver('C:\\s.jsonl')
    const p = driver.send('hi')
    await settle()
    const prompt = sent.find(c => c.type === 'prompt')!
    emit({ type: 'response', id: prompt.id, success: false, error: 'no model configured' })
    expect(await p).toEqual({ ok: false, error: 'no model configured' })
    expect(driver.error).toBeUndefined()
  })

  it('accumulates the draft from partials, retains it past message_end, clears only when completed', async () => {
    const { driver, emit, settle } = makeDriver('C:\\s.jsonl')
    emit({ type: 'agent_start' })
    emit({ type: 'message_start', message: { role: 'assistant', content: [] } })
    emit({ type: 'message_update', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'Hel' }] } })
    await settle()
    expect(driver.draft).toEqual({ text: 'Hel', thinking: 'hmm' })
    // Mid-accumulation, the engine's clear is a no-op (the durable row it saw was an older message).
    driver.clearCompletedDraft()
    expect(driver.draft).not.toBeNull()
    emit({ type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] } })
    emit({ type: 'message_end' })
    await settle()
    expect(driver.draft).toEqual({ text: 'Hello', thinking: '' })   // retained until the tail emits it
    driver.clearCompletedDraft()
    expect(driver.draft).toBeNull()
  })

  it('echoes an idle prompt until clearEcho; not steers, not slash commands', async () => {
    const { driver, sent, emit, settle } = makeDriver('C:\\s.jsonl')
    const p = driver.send('hello there')
    await settle()
    emit({ type: 'response', id: sent.find(c => c.type === 'prompt')!.id, success: true })
    expect(await p).toEqual({ ok: true })
    expect(driver.echo).toBe('hello there')                    // held until the durable row drains
    driver.clearEcho()
    expect(driver.echo).toBeNull()

    emit({ type: 'agent_start' })
    await settle()
    const p2 = driver.send('steer this')                       // mid-turn: the queue strip shows it
    await settle()
    emit({ type: 'response', id: sent.find(c => c.type === 'steer')!.id, success: true })
    expect(await p2).toEqual({ ok: true })
    expect(driver.echo).toBeNull()
    emit({ type: 'agent_end' })
    await settle()

    const p3 = driver.send('/model')                           // may run no turn — nothing to hand off to
    await settle()
    emit({ type: 'response', id: sent.filter(c => c.type === 'prompt')[1]!.id, success: true })
    expect(await p3).toEqual({ ok: true })
    expect(driver.echo).toBeNull()
  })

  it('queues blocking extension dialogs and answers them via respondUi', async () => {
    const { driver, sent, emit, settle } = makeDriver('C:\\s.jsonl')
    emit({ type: 'extension_ui_request', id: 'u1', method: 'select', title: 'Allow?', options: ['Allow', 'Block'] })
    emit({ type: 'extension_ui_request', id: 'u2', method: 'confirm', title: 'Clear session?', message: 'All messages will be lost.' })
    await settle()
    // Nothing auto-cancelled; the FIFO head is exposed.
    expect(sent.filter(c => c.type === 'extension_ui_response')).toEqual([])
    expect(driver.dialog).toMatchObject({ id: 'u1', method: 'select', title: 'Allow?', options: ['Allow', 'Block'] })
    expect(driver.respondUi('u1', { value: 'Allow' })).toEqual({ ok: true })
    await settle()
    expect(sent.find(c => c.type === 'extension_ui_response' && c.id === 'u1')).toEqual(
      { type: 'extension_ui_response', id: 'u1', value: 'Allow' })
    // Head advances to the confirm; a confirm answers with `confirmed`, not `value`.
    expect(driver.dialog).toMatchObject({ id: 'u2', method: 'confirm' })
    expect(driver.respondUi('u2', { confirmed: false })).toEqual({ ok: true })
    await settle()
    expect(sent.find(c => c.type === 'extension_ui_response' && c.id === 'u2')).toEqual(
      { type: 'extension_ui_response', id: 'u2', confirmed: false })
    expect(driver.dialog).toBeNull()
    // Unknown/expired ids are a soft error, no write.
    expect(driver.respondUi('u1', { cancelled: true }).ok).toBe(false)
  })

  it('composes ambient status: retry/compaction operations, notify notices, setStatus entries', async () => {
    const { driver, emit, settle } = makeDriver('C:\\s.jsonl')
    expect(driver.status).toBeNull()
    emit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: '529 overloaded' })
    await settle()
    expect(driver.status).toMatchObject({ kind: 'warning' })
    expect(driver.status!.text).toContain('attempt 1/3')
    emit({ type: 'auto_retry_end', success: true, attempt: 2 })
    await settle()
    expect(driver.status).toBeNull()
    emit({ type: 'compaction_start', reason: 'threshold' })
    await settle()
    expect(driver.status).toMatchObject({ kind: 'info', text: 'compacting context…' })
    emit({ type: 'compaction_end', reason: 'threshold', result: { tokensBefore: 150000, estimatedTokensAfter: 32000 }, aborted: false, willRetry: false })
    await settle()
    expect(driver.status!.text).toContain('~150k → ~32k')
    // Extension setStatus persists (outlives the transient notice window logically — keyed, not timed).
    emit({ type: 'extension_ui_request', id: 'u3', method: 'setStatus', statusKey: 'ext', statusText: 'Turn 3 running…' })
    emit({ type: 'extension_ui_request', id: 'u4', method: 'notify', message: 'heads up', notifyType: 'warning' })
    await settle()
    expect(driver.status).toMatchObject({ kind: 'warning', text: 'heads up' })   // fresh notice wins over setStatus
    emit({ type: 'extension_ui_request', id: 'u5', method: 'setStatus', statusKey: 'ext' })   // cleared per key
    await settle()
    // (notice still fresh here; its expiry is time-based and covered by the getter's until check)
  })

  it('rpc forwards allowlisted commands and refuses everything else', async () => {
    const { driver, sent, emit, settle } = makeDriver('C:\\s.jsonl')
    const p = driver.rpc({ type: 'get_available_models' })
    await settle()
    const cmd = sent.find(c => c.type === 'get_available_models')!
    expect(cmd).toBeDefined()
    emit({ type: 'response', id: cmd.id, success: true, data: { models: [{ provider: 'anthropic', id: 'x' }] } })
    expect(await p).toEqual({ ok: true, data: { models: [{ provider: 'anthropic', id: 'x' }] } })
    // prompt/steer/follow_up are NOT reachable through rpc — one message door (T2).
    const refused = await driver.rpc({ type: 'prompt', message: 'sneaky' })
    expect(refused.ok).toBe(false)
    expect(refused.error).toContain('not allowed')
    expect(sent.find(c => c.type === 'prompt')).toBeUndefined()
  })

  it('fetches pi session stats at boot and refreshes on agent_end (parity #5)', async () => {
    const { driver, sent, emit, settle } = makeDriver('C:\\s.jsonl')
    await settle()
    expect(driver.stats).toBeNull()
    const boot = sent.find(c => c.type === 'get_session_stats')!
    expect(boot).toBeDefined()
    emit({ type: 'response', id: boot.id, success: true,
      data: { cost: 0.12, contextUsage: { tokens: 60000, contextWindow: 200000, percent: 30 } } })
    await settle()
    expect(driver.stats).toEqual({ cost: 0.12, contextTokens: 60000, contextPercent: 30 })
    emit({ type: 'agent_end' })
    await settle()
    const next = sent.filter(c => c.type === 'get_session_stats')[1]!
    expect(next).toBeDefined()
    // Post-compaction shape: pi reports null tokens/percent until the next response — kept as null.
    emit({ type: 'response', id: next.id, success: true,
      data: { cost: 0.45, contextUsage: { tokens: null, contextWindow: 200000, percent: null } } })
    await settle()
    expect(driver.stats).toEqual({ cost: 0.45, contextTokens: null, contextPercent: null })
  })

  it('resolves the configured model at boot and updates it on set_model (model pill)', async () => {
    const { driver, sent, emit, settle } = makeDriver('C:\\s.jsonl')
    await settle()
    expect(driver.model).toBeNull()
    const gs = sent.find(c => c.type === 'get_state')!
    emit({ type: 'response', id: gs.id, success: true,
      data: { sessionFile: 'C:\\s.jsonl', model: { id: 'z-ai/glm-5.2', name: 'GLM 5.2', provider: 'openrouter' } } })
    await settle()
    expect(driver.model).toBe('z-ai/glm-5.2')
    // set_model's response data IS the Model object (rpc.md) — the switch reflects immediately,
    // not at the next assistant turn.
    const p = driver.rpc({ type: 'set_model', provider: 'anthropic', modelId: 'claude-sonnet-4' })
    await settle()
    const sm = sent.find(c => c.type === 'set_model')!
    emit({ type: 'response', id: sm.id, success: true, data: { id: 'claude-sonnet-4', provider: 'anthropic' } })
    expect((await p).ok).toBe(true)
    expect(driver.model).toBe('claude-sonnet-4')
  })

  it('re-resolves the session file after fork and hands it to the caller (the recipe attaches)', async () => {
    const { driver, sent, emit, settle } = makeDriver('C:\\old.jsonl')
    await settle()
    const p = driver.rpc({ type: 'fork', entryId: 'abc' })
    await settle()
    const fk = sent.find(c => c.type === 'fork')!
    emit({ type: 'response', id: fk.id, success: true, data: { text: 'restored prompt' } })
    await settle()
    // fork moves the pi process to a NEW session file (0.80.3) — the driver re-asks get_state and
    // rebinds, so the engine's resolveBindings re-keys the rec instead of stranding it on the old file.
    const gs = sent.filter(c => c.type === 'get_state').pop()!
    emit({ type: 'response', id: gs.id, success: true, data: { sessionFile: 'C:\\forked.jsonl' } })
    const r = await p
    expect(r.ok).toBe(true)
    expect((r.data as { sessionFile?: string }).sessionFile).toBe('C:\\forked.jsonl')
    expect((r.data as { text?: string }).text).toBe('restored prompt')
    expect(driver.sessionFile).toBe('C:\\forked.jsonl')
  })

  it('a dying pi fails pending sends and surfaces error; streaming/draft reset', async () => {
    const { driver, child, emit, settle } = makeDriver('C:\\s.jsonl')
    emit({ type: 'agent_start' })
    emit({ type: 'message_start', message: { role: 'assistant', content: [] } })
    await settle()
    const p = driver.send('hi')
    await settle()
    child.stderr.write('boom: no auth')
    child.exitCode = 1
    child.emit('exit', 1)
    await settle()
    expect((await p).ok).toBe(false)
    expect(driver.error).toContain('pi exited (code 1)')
    expect(driver.error).toContain('boom: no auth')
    expect(driver.streaming).toBe(false)
    expect(driver.draft).toBeNull()
  })

  it('a quoted session path is refused up front', () => {
    const { driver } = makeDriver('C:\\weird"path\\s.jsonl')
    expect(driver.error).toContain('quote')
  })
})

// The trust-notice gate (parity #12): mirrors pi's project-trust resolution read-only. Real fs,
// isolated agentDir; home is the real one (pi excludes the user-global ~/.agents/skills anyway).
describe('trustNotice', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'tb-trust-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  async function setup() {
    const proj = join(dir, 'proj')
    await mkdir(join(proj, '.pi', 'extensions'), { recursive: true })
    const agentDir = join(dir, 'agent')
    await mkdir(agentDir, { recursive: true })
    return { proj, agentDir, home: homedir() }
  }

  it('notices an undecided trust-requiring project; a resource-less one has nothing to gate', async () => {
    const { proj, agentDir, home } = await setup()
    expect(trustNotice(proj, { agentDir, home })).toContain('no trust decision')
    const plain = join(dir, 'plain')
    await mkdir(plain, { recursive: true })
    expect(trustNotice(plain, { agentDir, home })).toBeNull()
  })

  it('a trust.json decision on the project or an ancestor silences it — false included', async () => {
    const { proj, agentDir, home } = await setup()
    await writeFile(join(agentDir, 'trust.json'), JSON.stringify({ [dirname(realpathSync(proj))]: true }))
    expect(trustNotice(proj, { agentDir, home })).toBeNull()
    await writeFile(join(agentDir, 'trust.json'), JSON.stringify({ [realpathSync(proj)]: false }))
    expect(trustNotice(proj, { agentDir, home })).toBeNull()
  })

  it('an explicit defaultProjectTrust silences it (a configured default is not a silent fallback)', async () => {
    const { proj, agentDir, home } = await setup()
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ defaultProjectTrust: 'always' }))
    expect(trustNotice(proj, { agentDir, home })).toBeNull()
  })

  it('the adapter-facing notice() rides the status line', () => {
    const { driver } = makeDriver('C:\\s.jsonl')
    driver.notice('pi has no trust decision for this project', 'warning')
    expect(driver.status).toEqual({ text: 'pi has no trust decision for this project', kind: 'warning' })
  })
})

// The pi patcher extension's apply core (TB-Agent-Pi-Patcher.md): matchu-patchu semantics over
// real files in a temp dir. The pi wiring (registerTool/setActiveTools) is verified live.
describe('piPatcherExtension applyPatch', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'tb-patch-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  const TWO_FILE_DIFF = [
    '--- a/one.txt', '+++ b/one.txt', '@@', '-alpha', '+ALPHA',
    '--- a/two.txt', '+++ b/two.txt', '@@', '-beta', '+BETA', '',
  ].join('\n')

  it('multi-file mode: keys come from a/ b/ headers via the lib\'s own parser, one changeset patches both', async () => {
    expect(discoverDiffKeys(TWO_FILE_DIFF)).toEqual(['one.txt', 'two.txt'])
    await writeFile(join(dir, 'one.txt'), 'alpha\nkeep\n')
    await writeFile(join(dir, 'two.txt'), 'beta\nkeep\n')
    const r = applyPatch(dir, { diff: TWO_FILE_DIFF })
    expect(r.ok).toBe(true)
    expect(r.message).toContain('1 edit(s) to one.txt')
    expect(r.message).toContain('1 edit(s) to two.txt')
    expect(await readFile(join(dir, 'one.txt'), 'utf-8')).toBe('ALPHA\nkeep\n')
    expect(await readFile(join(dir, 'two.txt'), 'utf-8')).toBe('BETA\nkeep\n')
  })

  it('a changeset is atomic across files (P2): one bad hunk means no byte lands anywhere', async () => {
    await writeFile(join(dir, 'one.txt'), 'alpha\nkeep\n')
    await writeFile(join(dir, 'two.txt'), 'NOT-beta\nkeep\n')
    const r = applyPatch(dir, { diff: TWO_FILE_DIFF })
    expect(r.ok).toBe(false)
    expect(r.message).toContain('error(s)')
    expect(await readFile(join(dir, 'one.txt'), 'utf-8')).toBe('alpha\nkeep\n')
    const missing = applyPatch(dir, { diff: TWO_FILE_DIFF.replace(/two\.txt/g, 'gone.txt') })
    expect(missing.ok).toBe(false)
    expect(missing.message).toContain('file not found: gone.txt')
    expect(await readFile(join(dir, 'one.txt'), 'utf-8')).toBe('alpha\nkeep\n')
  })

  it('filePath mode applies a headerless bare-hunk diff (MCP applyCore semantics)', async () => {
    await writeFile(join(dir, 'one.txt'), 'alpha\nkeep\n')
    const r = applyPatch(dir, { diff: '@@\n-alpha\n+ALPHA\n', filePath: 'one.txt' })
    expect(r.ok).toBe(true)
    expect(await readFile(join(dir, 'one.txt'), 'utf-8')).toBe('ALPHA\nkeep\n')
    const again = applyPatch(dir, { diff: '@@\n-alpha\n+ALPHA\n', filePath: 'one.txt' })
    expect(again.ok).toBe(true)
    expect(again.message).toContain('already contains this change')
  })

  it('dryRun returns the patched output and leaves the file untouched', async () => {
    await writeFile(join(dir, 'one.txt'), 'alpha\nkeep\n')
    const r = applyPatch(dir, { diff: '@@\n-alpha\n+ALPHA\n', filePath: 'one.txt', dryRun: true })
    expect(r.ok).toBe(true)
    expect(r.message).toContain('--- patched output ---')
    expect(r.message).toContain('ALPHA\nkeep\n')
    expect(await readFile(join(dir, 'one.txt'), 'utf-8')).toBe('alpha\nkeep\n')
  })
})

// The session_start ownership check that keeps a foreign `patch` extension from ever colliding
// with the shim (P3): register when absent, stand down when foreign, re-apply when ours.
describe('piPatcherExtension patchOwnership', () => {
  const ours = { name: 'patch', sourceInfo: { path: 'C:\\Users\\t\\.pi\\agent\\extensions\\matchu-patchu.ts' } }
  const foreign = { name: 'patch', sourceInfo: { path: 'C:\\proj\\.pi\\extensions\\patcher\\index.ts' } }

  it('no patch registered → absent (we register)', () => {
    expect(patchOwnership([{ name: 'read' }, { name: 'edit' }], false)).toBe('absent')
  })

  it('a foreign patch → stand down, never collide', () => {
    expect(patchOwnership([foreign], false)).toBe('foreign')
    expect(patchOwnership([{ name: 'patch' }], false)).toBe('foreign')  // no sourceInfo at all
  })

  it('ours by path, or by the same-process flag on a re-fire', () => {
    expect(patchOwnership([ours], false)).toBe('ours')
    expect(patchOwnership([foreign], true)).toBe('ours')
  })
})

// The engine's per-conversation driver lifecycle (TB-Agent-Composer.md v2 — C2/C4/C5/C6): slices are
// view-scoped, ownership is identity (the blank pointer), navigation never aborts, idle/finished
// background drivers are reaped. Engine-level, so a fake adapter + fake driver — no pi, no session
// files (drain/watch on nonexistent paths are safe no-ops).
class FakeMirrorDriver implements AgentDriver {
  streaming = false
  draft: AgentDriver['draft'] = null
  echo: AgentDriver['echo'] = null
  status: AgentDriver['status'] = null
  queue: AgentDriver['queue'] = null
  stats: AgentDriver['stats'] = null
  model: AgentDriver['model'] = null
  dialog: AgentDriver['dialog'] = null
  sessionFile: string | undefined
  error: string | undefined
  disposed = false
  stopped = false
  sent: string[] = []
  constructor(sessionFile: string | undefined) { this.sessionFile = sessionFile }
  async send(text: string) { this.sent.push(text); return { ok: true } }
  async stop() { this.stopped = true }
  respondUi() { return { ok: true } }
  async rpc() { return { ok: true } }
  clearCompletedDraft() {}
  clearEcho() { this.echo = null }
  async dispose() { this.disposed = true }
}

class FakeMirrorAdapter extends AgentAdapter<never> {
  displayName = 'Fake Mirror'
  sessions: SessionFile[] = []
  created: FakeMirrorDriver[] = []
  get driver() { return this.created[this.created.length - 1] }
  detectsSelf() { return false }
  detectsInstalled() { return false }
  sessionsDir() { return 'C:\\tb-gate-nowhere' }
  listSessionFiles() { return this.sessions }
  parseEntry() { return null }
  idOf() { return undefined }
  parentOf() { return undefined }
  timestampOf() { return undefined }
  isSidechain() { return false }
  isLeafType() { return false }
  isRecoveryNoise() { return false }
  apply() { return { events: [] } }
  chainWorking() { return false }
  sessionAlive() { return false }
  readPreview() { return '' }
  searchText() { return '' }
  createDriver = (_cwd: string, sessionFile: string | undefined) => {
    const d = new FakeMirrorDriver(sessionFile)
    this.created.push(d)
    return d
  }
}

describe('mirror driver lifecycle (per-conversation drivers, view-scoped slices)', () => {
  const A: SessionFile = { sessionId: 'tb-gate-a', file: 'C:\\tb-gate-fake\\a.jsonl', mtime: 2000 }
  const B: SessionFile = { sessionId: 'tb-gate-b', file: 'C:\\tb-gate-fake\\b.jsonl', mtime: 1000 }
  const NEW: SessionFile = { sessionId: 'tb-gate-new', file: 'C:\\tb-gate-fake\\new.jsonl', mtime: 3000 }

  // The engine writes real per-session locks under <cwd>/.typebulb/locks and stat-watches the
  // (nonexistent) session files — drop both so the suite leaves no trace and no live timers.
  afterEach(async () => {
    for (const s of [A, B, NEW]) {
      unwatchFile(s.file)
      await rm(join(process.cwd(), '.typebulb', 'locks', `${s.sessionId}.lock`), { force: true })
    }
  })

  it('a streaming driver surviving an attach-away ships nothing under the other session; its error stays its own (C4)', async () => {
    const adapter = new FakeMirrorAdapter()
    adapter.sessions = [A, B]
    const m = createMirror(adapter)                            // boot auto-attaches the newest (A)
    expect((await m.composerSend('hi')).ok).toBe(true)         // driver born bound to A
    const d = adapter.driver!
    d.streaming = true
    d.draft = { text: 'partial', thinking: '' }
    d.status = { text: 'compacting context…', kind: 'info' }
    d.queue = { steering: ['focus'], followUp: [] }
    d.stats = { cost: 0.1, contextTokens: 1000, contextPercent: 5 }
    let p = await m.poll(0)
    expect(p.working).toBe(true)
    expect(p.composer).toMatchObject({ streaming: true, draft: { text: 'partial' }, queue: { steering: ['focus'] }, stats: { cost: 0.1 } })
    // View B mid-stream: the driver survives, but nothing it holds describes B.
    expect((await m.attach(B.sessionId)).ok).toBe(true)
    p = await m.poll(0)
    expect(p.working).toBe(false)
    expect(p.composer).toMatchObject({ streaming: false, draft: null, status: null, dialog: null, queue: null, stats: null })
    expect(d.disposed).toBe(false)                             // navigation never aborts (C6)
    // A's streaming turn badges B's picker via the busy set — the one cross-conversation signal.
    expect(p.busy).toEqual([A.sessionId])
    // A dead driver's error is its conversation's alone — nothing shows under B (C4).
    d.error = 'pi exited (code 1)'
    d.streaming = false
    p = await m.poll(0)
    expect(p.composer!.error).toBeUndefined()
    // Back on A the error surfaces; the flip reaps the idle pre-warm driver B's view spawned.
    const bPrewarm = adapter.created.find(c => c.sessionFile === B.file)
    expect((await m.attach(A.sessionId)).ok).toBe(true)
    p = await m.poll(0)
    expect(p.composer!.error).toBe('pi exited (code 1)')
    expect(bPrewarm?.disposed).toBe(true)
    d.error = undefined
    d.streaming = true
    p = await m.poll(0)
    expect(p.working).toBe(true)
    expect(p.composer).toMatchObject({ streaming: true, draft: { text: 'partial' }, status: { kind: 'info' }, stats: { cost: 0.1 } })
  })

  it('a blank view owns its newborn driver through the file-resolution window', async () => {
    const adapter = new FakeMirrorAdapter()
    const m = createMirror(adapter)                            // no sessions: boots blank
    expect((await m.composerSend('hi')).ok).toBe(true)         // sessionless spawn
    const d = adapter.driver!
    d.streaming = true
    d.draft = { text: 'born', thinking: '' }
    let p = await m.poll(0)
    expect(p.composer).toMatchObject({ streaming: true, draft: { text: 'born' } })
    // pi reports its file before writing it: the listing can't resolve it yet — still ours.
    d.sessionFile = NEW.file
    p = await m.poll(0)
    expect(p.composer).toMatchObject({ streaming: true, draft: { text: 'born' } })
    // First entry lands: the listing resolves, the blank view attaches — still ours.
    adapter.sessions = [NEW]
    p = await m.poll(0)
    expect(p.composer).toMatchObject({ streaming: true, draft: { text: 'born' } })
  })

  it('composerNew eagerly spawns a sessionless driver: the blank view ships its model, send reuses it', async () => {
    const adapter = new FakeMirrorAdapter()
    adapter.sessions = [A]
    const m = createMirror(adapter)                            // boot auto-attaches A
    expect((await m.composerNew()).ok).toBe(true)
    const d = adapter.driver!
    expect(d.sessionFile).toBeUndefined()                      // sessionless spawn
    d.model = 'z-ai/glm-5.2'                                   // boot get_state resolved
    let p = await m.poll(0)
    expect(p.composer).toMatchObject({ model: 'z-ai/glm-5.2' })
    // pi reports its (unwritten) file — the blank view still owns the newborn, and the first
    // send must REUSE it, not dispose-and-respawn (the pill would blank again mid-swap).
    d.sessionFile = NEW.file
    p = await m.poll(0)
    expect(p.composer).toMatchObject({ model: 'z-ai/glm-5.2' })
    expect((await m.composerSend('hi')).ok).toBe(true)
    expect(adapter.driver).toBe(d)
    expect(d.disposed).toBe(false)
  })

  it('conversations are independent (C2/C4): a send in B never waits on A\'s streaming turn', async () => {
    const adapter = new FakeMirrorAdapter()
    adapter.sessions = [A, B]
    const m = createMirror(adapter)                            // boot auto-attaches A
    expect((await m.composerSend('work on A')).ok).toBe(true)
    const dA = adapter.created[0]!
    dA.streaming = true
    dA.draft = { text: 'A partial', thinking: '' }
    // Flip to B and send while A streams: a SECOND driver, pinned to B — never a steer into A.
    expect((await m.attach(B.sessionId)).ok).toBe(true)
    expect((await m.composerSend('work on B')).ok).toBe(true)
    const dB = adapter.created[1]!
    expect(dB).not.toBe(dA)
    expect(dB.sessionFile).toBe(B.file)
    expect(dB.sent).toEqual(['work on B'])
    expect(dA.sent).toEqual(['work on A'])                     // A's turn untouched
    expect(dA.disposed).toBe(false)
    // Two turns streaming at once: both badge busy; B's view renders only B's state.
    dB.streaming = true
    dB.draft = { text: 'B partial', thinking: '' }
    const p = await m.poll(0)
    expect(p.composer).toMatchObject({ streaming: true, draft: { text: 'B partial' } })
    expect(p.busy.sort()).toEqual([A.sessionId, B.sessionId].sort())
    // Stop is view-scoped (C6): it aborts B's turn, deliberately aimed at what the user sees.
    await m.composerStop()
    expect(dB.stopped).toBe(true)
    expect(dA.stopped).toBe(false)
  })

  it('composerNew mid-turn detaches without aborting; the blank never snaps back to the old session (C5/C6)', async () => {
    const adapter = new FakeMirrorAdapter()
    adapter.sessions = [A]
    const m = createMirror(adapter)
    expect((await m.composerSend('go')).ok).toBe(true)
    const dA = adapter.created[0]!
    dA.streaming = true
    dA.draft = { text: 'A partial', thinking: '' }
    // + mid-turn: never refused, never destructive — A keeps streaming in the background.
    expect((await m.composerNew()).ok).toBe(true)
    expect(dA.disposed).toBe(false)
    const newborn = adapter.created[1]!
    expect(newborn.sessionFile).toBeUndefined()                // the blank's own sessionless spawn
    // The blank renders none of A's draft/shimmer, badges A as busy, and — the v1 snap-back bug —
    // stays blank even though A's driver holds a resolved file that IS in the listing.
    let p = await m.poll(0)
    expect(p.working).toBe(false)
    expect(p.composer).toMatchObject({ streaming: false, draft: null })
    expect(p.busy).toEqual([A.sessionId])
    const lastSession = p.events.filter(e => e.type === 'session').pop() as { sessionId: string }
    expect(lastSession.sessionId).toBe('')                     // still the blank view, no snap-back
    // The first send goes to the newborn — never a steer into A's in-flight turn.
    expect((await m.composerSend('fresh start')).ok).toBe(true)
    expect(newborn.sent).toEqual(['fresh start'])
    expect(dA.sent).toEqual(['go'])
    // A's turn ends: the background driver is reaped at agent_end (C2), the badge clears —
    // but a queued follow-up holds the reap until pi finishes the turns it promised.
    dA.streaming = false
    dA.queue = { steering: [], followUp: ['then also X'] }
    p = await m.poll(0)
    expect(dA.disposed).toBe(false)
    expect(p.busy).toEqual([])                                 // not streaming ⇒ no badge
    dA.queue = null
    p = await m.poll(0)
    expect(dA.disposed).toBe(true)
    expect(p.busy).toEqual([])
  })

  it('composerNew is idempotent on a blank view with a live newborn; a streaming newborn is abandoned and a fresh one minted', async () => {
    const adapter = new FakeMirrorAdapter()
    const m = createMirror(adapter)                            // no sessions: boots blank
    expect((await m.composerNew()).ok).toBe(true)
    const first = adapter.created[adapter.created.length - 1]!
    expect((await m.composerNew()).ok).toBe(true)              // idle newborn: reused, not stacked
    expect(adapter.driver).toBe(first)
    expect(first.disposed).toBe(false)
    // A streaming newborn drops to the background; + mints a fresh one.
    first.streaming = true
    expect((await m.composerNew()).ok).toBe(true)
    const second = adapter.driver!
    expect(second).not.toBe(first)
    expect(first.disposed).toBe(false)
  })

  it('shutdownComposer reaps every driver, streaming or not', async () => {
    const adapter = new FakeMirrorAdapter()
    adapter.sessions = [A, B]
    const m = createMirror(adapter)
    expect((await m.composerSend('a')).ok).toBe(true)
    adapter.created[0]!.streaming = true
    expect((await m.attach(B.sessionId)).ok).toBe(true)
    expect((await m.composerSend('b')).ok).toBe(true)
    m.shutdownComposer()
    expect(adapter.created.every(d => d.disposed)).toBe(true)
  })
})

describe('piExtensionSource (the written typebulb.ts extension: wait shim + mirror orientation)', () => {
  it('resolves the skill-path placeholder to a JS string literal of the packaged SKILL.md', () => {
    const src = piExtensionSource()
    expect(src).not.toContain('__TB_SKILL_PATH__')
    // JSON-encoded absolute paths — Windows backslashes must arrive escaped, not raw.
    expect(src).toMatch(/var TB_SKILL_PATH = "(.+SKILL\.md)";/)
  })

  it('carries the mirror orientation gated on TYPEBULB_MIRROR, with the agent.ts decision lines verbatim', () => {
    const src = piExtensionSource()
    expect(src).toContain('process.env.TYPEBULB_MIRROR !== "1"')
    expect(src).toContain('before_agent_start')
    // The hard-won wording (commands/agent.ts) — drift here means the two blocks paraphrased apart.
    expect(src).toContain('Reusable app/tool → write a .bulb.md')
    expect(src).toContain('Show something inline → embed a bulb')
    expect(src).toContain('typebulb wait agent --match "[embed <name>"')
    expect(src).toContain('Read the authoring skill before writing a bulb:')
  })

  it('suppresses the wake on a clean embed-ok verdict — silence is the ok; errors still wake', () => {
    const src = piExtensionSource()
    // The per-line predicate, as written into the extension.
    const m = src.match(/return (\/.+\/)\.test\(l\);/)
    expect(m).not.toBeNull()
    const re = new Function(`return ${m![1]}`)() as RegExp
    // Mirror the shim's blob→lines→every classification (wait bursts multiple lines into one payload).
    const embedOk = (text: string) => {
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
      return lines.length > 0 && lines.every(l => re.test(l))
    }
    expect(embedOk('[embed Japan v1] ok')).toBe(true)
    // The bug this fixes: a version-agnostic --match replays v1+v2 into one multi-line payload — still all ok.
    expect(embedOk('[embed Japan v1] ok\n[embed Japan v2] ok')).toBe(true)
    expect(embedOk('[embed Japan v2] compile error: x is not defined')).toBe(false)
    expect(embedOk('[embed Japan v1] ok\n[embed Japan v2] runtime error: boom')).toBe(false)  // one error still wakes
    expect(embedOk('[embed Japan v1] malformed: no code block')).toBe(false)
    expect(embedOk('MOVE e2e4')).toBe(false)                      // a turn-based loop event must wake
    expect(embedOk('')).toBe(false)
    expect(src).toContain('text && !embedOk')                     // ok never reaches sendUserMessage
  })

  it('defangs the suppression notify — a quoted "[embed <name>" tag would echo into the watched log and loop', () => {
    const src = piExtensionSource()
    // The composer driver echoes extension notifies into the mirror's log (driver.ts), which wait
    // matches by substring — so the ok text is bracket-stripped before notifying, or every
    // suppressed ok wakes the NEXT same-match wait via its own echo (the grok 4.3 field failure).
    expect(src).toContain('embedOk ? text.replace(/[\\[\\]]/g, "")')
    const defang = (t: string) => t.replace(/[\[\]]/g, '')
    expect(defang('[embed Color Perception v1] ok')).not.toContain('[embed Color Perception')
    // And the echo line itself, delivered in a later burst, must classify as a wake, never an ok.
    const m = src.match(/return (\/.+\/)\.test\(l\);/)
    const re = new Function(`return ${m![1]}`)() as RegExp
    expect(re.test('[composer] pi extension: typebulb wait: [embed Japan v1] ok')).toBe(false)
  })

  it('re-runs the intercepted command under bash, never node shell:true cmd.exe (POSIX ";" as args field failure)', () => {
    const src = piExtensionSource()
    // Resolution mirrors pi's own getShellConfig: Git Bash in ProgramFiles, PATH fallback, /bin/bash on POSIX.
    expect(src).toContain('function resolveBash()')
    expect(src).toContain('spawn(bash, ["-c", cmd]')
    // shell:true survives only as the no-bash fallback, never the primary path.
    expect(src).toContain('spawn(cmd, { ...opts, shell: true })')
  })

  it('wakes on a failed arm (exit ∉ {0,2,3}) with the diagnostic — a silently dead wait is a deadlock', () => {
    const src = piExtensionSource()
    expect(src).toContain('code !== null && code !== 0 && code !== 2 && code !== 3')
    expect(src).toContain('typebulb wait FAILED (exit " + code + ")')
    // The diagnostic carries the child output the old notify path discarded ("No running server for …").
    expect(src).toContain('errOut')
  })

  it('absorbs agent self-backgrounding — trailing "&" stripped, redirected-away verdict wakes with a pointer', () => {
    const src = piExtensionSource()
    // The strip regex, as written into the extension (the shim is the backgrounder; "&" decouples the wake).
    const m = src.match(/String\(command\)\.replace\((\/.+?\/), ""\)/)
    expect(m).not.toBeNull()
    const re = new Function(`return ${m![1]}`)() as RegExp
    const strip = (c: string) => c.replace(re, '')
    // The Toroidal Life field command: & stripped, redirect kept (bash then blocks until the match).
    expect(strip('npx typebulb wait agent --match "[embed Toroidal Life" > /tmp/x.log 2>&1 &'))
      .toBe('npx typebulb wait agent --match "[embed Toroidal Life" > /tmp/x.log 2>&1')
    expect(strip('npx typebulb wait agent --match "[embed X" &')).toBe('npx typebulb wait agent --match "[embed X"')
    expect(strip('npx typebulb wait agent --match "[embed X"')).toBe('npx typebulb wait agent --match "[embed X"')  // no-op without &
    // Exit 0 with empty stdout = the verdict was redirected away; the wake points at the mirror log.
    expect(src).toContain('code === 0 && !text')
    expect(src).toContain('typebulb logs agent')
  })
})

// The /model local-Ollama assist's file half (agents/pi/server/ollama.ts): set the ollama provider
// to pi's documented block — sync = clobber THAT BLOCK ONLY; every other provider and top-level
// key survives — create-when-absent, refuse what a strict parse can't round-trip.
describe('writeOllamaProvider', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'tb-ollama-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })
  const file = () => join(dir, 'agent', 'models.json')   // one dir deep: covers the mkdirSync

  it('creates a fresh models.json with the documented block (placeholder apiKey included)', async () => {
    const r = writeOllamaProvider(file(), ['llama3.1:8b', 'qwen2.5-coder:7b'], 'http://localhost:11434')
    expect(r).toEqual({ ok: true, count: 2 })
    const json = JSON.parse(await readFile(file(), 'utf-8'))
    expect(json.providers.ollama).toEqual({
      baseUrl: 'http://localhost:11434/v1',
      api: 'openai-completions',
      apiKey: 'ollama',   // pi hides auth-less providers from /model; Ollama ignores the value
      models: [{ id: 'llama3.1:8b' }, { id: 'qwen2.5-coder:7b' }],
    })
  })

  it('merges beside existing providers and top-level keys, preserving them', async () => {
    await mkdir(dirname(file()), { recursive: true })
    await writeFile(file(), JSON.stringify({ defaults: { model: 'x' }, providers: { groq: { baseUrl: 'https://g/v1' } } }))
    const r = writeOllamaProvider(file(), ['m1'], 'http://localhost:11434')
    expect(r.ok).toBe(true)
    const json = JSON.parse(await readFile(file(), 'utf-8'))
    expect(json.defaults).toEqual({ model: 'x' })
    expect(json.providers.groq).toEqual({ baseUrl: 'https://g/v1' })
    expect(json.providers.ollama.models).toEqual([{ id: 'm1' }])
  })

  it('sync clobbers only the ollama block — stale ids drop, a sibling provider survives verbatim', async () => {
    await mkdir(dirname(file()), { recursive: true })
    await writeFile(file(), JSON.stringify({ providers: {
      openrouter: { models: [{ id: 'x-ai/grok-4.5' }] },
      ollama: { baseUrl: 'http://other:1/v1', api: 'openai-completions', apiKey: 'ollama', models: [{ id: 'uninstalled:old' }, { id: 'kept:7b' }] },
    } }))
    const r = writeOllamaProvider(file(), ['kept:7b', 'new:12b'], 'http://localhost:11434')
    expect(r).toEqual({ ok: true, count: 2 })
    const json = JSON.parse(await readFile(file(), 'utf-8'))
    expect(json.providers.openrouter).toEqual({ models: [{ id: 'x-ai/grok-4.5' }] })   // not ours, untouched
    expect(json.providers.ollama.models).toEqual([{ id: 'kept:7b' }, { id: 'new:12b' }])   // exactly what's installed
    expect(json.providers.ollama.baseUrl).toBe('http://localhost:11434/v1')   // the whole block is rewritten
  })

  it('refuses a file it cannot round-trip (comments are pi-legal but a strict parse fails)', async () => {
    await mkdir(dirname(file()), { recursive: true })
    const original = '{\n  // my hand-tuned providers\n  "providers": {}\n}\n'
    await writeFile(file(), original)
    const r = writeOllamaProvider(file(), ['m1'], 'http://localhost:11434')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('could not parse')
    expect(await readFile(file(), 'utf-8')).toBe(original)
  })
})
