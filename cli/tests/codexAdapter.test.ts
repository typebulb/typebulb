import { describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, copyFileSync, writeFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'
import { CodexAdapter } from '../agents/codex/server/adapter.js'
import type { Event, TokenCounts } from '../agents/core/events.js'

/**
 * The Codex adapter against REAL pinned rollouts (tests/fixtures/codex/ — codex-cli 0.146.0 and
 * 0.153.4, install-verified 2026-08-01 / 2026-09-07; TB-Agent-Codex.md Invariant 7): Codex's next format revision breaks
 * here, loudly, instead of silently blanking the mirror. Unlike the CC/Pi suites (inline shapes),
 * these parse complete on-disk files, because the format is upstream's contract, not ours.
 * Pinning a new version: a throwaway `codex exec --sandbox danger-full-access --skip-git-repo-check
 * -C C:\tmp\<dir> "<prompt>"` (full access — Codex's sandbox can't nest inside an agent shell's), then
 * copy its rollout from ~/.codex/sessions/YYYY/MM/DD/.
 */

const FIXTURES = fileURLToPath(new URL('./fixtures/codex/', import.meta.url))
const ROLLOUTS = {
  scratchpad: 'rollout-2026-08-01T17-17-42-019fbd79-2998-76e2-9d46-4e149a12853e.jsonl',  // cwd: a Temp scratchpad; 2 execs
  tmp: 'rollout-2026-08-01T17-19-03-019fbd7a-670e-7570-b56d-1bd513346d37.jsonl',         // cwd: C:\tmp; 1 exec
  typebulb: 'rollout-2026-08-01T17-27-27-019fbd82-18ed-7c12-98c6-d7daad4c8014.jsonl',    // cwd: C:\Code\typebulb; no tools
  patches: 'rollout-2026-09-07T22-01-49-01a07d08-94c4-76c0-801c-9d17650efe92.jsonl',     // cwd: C:\tmp\codex-fixture; 0.153.4 — 2 apply_patch + 1 exec_command
}
type Tool = { id: string; name: string; input: Record<string, unknown> }
const toolsOf = (events: Event[]) => events.filter(e => e.type === 'assistant' && e.tools.length).flatMap(e => (e as { tools: Tool[] }).tools)

// Mimic the engine's drain: parseEntry each line, stamp via idOf (the drain is idOf's only caller).
function drain(adapter: CodexAdapter, file: string) {
  const entries = []
  for (const line of readFileSync(join(FIXTURES, file), 'utf8').split('\n')) {
    if (!line.trim()) continue
    const e = adapter.parseEntry(line)
    if (!e) continue
    adapter.idOf(e)
    entries.push(e)
  }
  return entries
}

// apply() every entry the way emitLive does, tracking the engine's overwrite semantics.
function render(adapter: CodexAdapter, file: string) {
  const events: Event[] = []
  let usage: TokenCounts | undefined
  let model: string | undefined
  const entries = drain(adapter, file)
  for (const e of entries) {
    const r = adapter.apply(e, 0)
    events.push(...r.events)
    if (r.usage) usage = r.usage
    if (r.model) model = r.model
  }
  return { entries, events, usage, model }
}

describe('CodexAdapter chain synthesis', () => {
  it('parses every line of a real rollout into a linear parent-linked chain', () => {
    const a = new CodexAdapter()
    const entries = drain(a, ROLLOUTS.scratchpad)
    expect(entries.length).toBe(24)                       // every line is a tree node, header included
    expect(a.parentOf(entries[0])).toBeUndefined()        // the root
    for (let i = 1; i < entries.length; i++) {
      expect(a.parentOf(entries[i])).toBe(a.idOf(entries[i - 1]))
    }
  })

  it('drops garbage lines; unknown future types parse but render nothing', () => {
    const a = new CodexAdapter()
    expect(a.parseEntry('not json')).toBeNull()
    expect(a.parseEntry('{"payload":{}}')).toBeNull()     // no type — not a rollout line
    const e = a.parseEntry('{"timestamp":"2026-08-01T00:00:00Z","type":"compacted","payload":{}}')
    expect(e).not.toBeNull()
    expect(a.apply(e!, 0).events).toEqual([])
  })
})

describe('CodexAdapter rendering (dedup + cleaning)', () => {
  it('renders from response_item only — event twins, envelopes, and developer turns produce nothing', () => {
    const { events } = render(new CodexAdapter(), ROLLOUTS.scratchpad)
    // Exactly ONE user turn: the real prompt. Its event_msg twin, the developer instruction
    // envelopes, and the user-role <recommended_plugins>/<environment_context> blocks all drop.
    const users = events.filter(e => e.type === 'user')
    expect(users.length).toBe(1)
    expect((users[0] as { text: string }).text).toMatch(/^Run this exact PowerShell command/)
    // Both assistant phases render (commentary + final_answer); the agent_message twins don't.
    const texts = events.filter(e => e.type === 'assistant' && e.text)
    expect(texts.length).toBe(2)
    // Encrypted reasoning (empty summary) renders nothing.
    expect(events.some(e => e.type === 'assistant' && e.thinking)).toBe(false)
  })

  it('links each exec tool call to its output by call_id and surfaces the shell_command args', () => {
    const { events } = render(new CodexAdapter(), ROLLOUTS.scratchpad)
    const calls = toolsOf(events)
    const results = events.filter(e => e.type === 'tool_result') as { id: string; content: string; isError: boolean; digest?: string }[]
    expect(calls.length).toBe(2)
    expect(results.length).toBe(2)
    expect(calls[0].name).toBe('exec')
    expect(String(calls[0].input.command)).toContain('Get-ChildItem env:')   // parsed out of the JS wrapper
    expect(results.map(r => r.id)).toEqual(calls.map(c => c.id))
    expect(results[0].digest).toMatch(/^execution error: /)   // the body under the sandbox's Script failed / Wall time / Output: wrapper
    expect(results.map(r => r.isError)).toEqual([true, true])    // that verdict line is the error flag (both execs failed: nested sandbox)
  })

  it('unwraps the exec script (0.153.4): apply_patch → a unified diff + path, a whole-file exec_command → read, results unwrapped', () => {
    const { events } = render(new CodexAdapter(), ROLLOUTS.patches)
    const calls = toolsOf(events)
    expect(calls.map(c => c.name)).toEqual(['apply_patch', 'apply_patch', 'read'])
    // Add File carries no @@ in Codex's grammar — the synthetic hunk header is what trips the client's diff sniff.
    expect(calls[0].input).toEqual({ path: 'C:/tmp/codex-fixture/notes.txt', patch: '--- /dev/null\n+++ b/C:/tmp/codex-fixture/notes.txt\n@@\n+hello' })
    expect(calls[1].input).toEqual({ path: 'C:/tmp/codex-fixture/notes.txt', patch: '--- a/C:/tmp/codex-fixture/notes.txt\n+++ b/C:/tmp/codex-fixture/notes.txt\n@@\n-hello\n+hello world' })
    // `{cmd:"Get-Content -LiteralPath notes.txt",max_output_tokens:100}` — a JS object literal, not JSON; one whole-file read → CC's Read row.
    expect(calls[2].input).toEqual({ path: 'notes.txt' })
    // Results unwrapped from the sandbox's `Script completed / Wall time / Output:` — a landed patch digests as its
    // ± count (the card shows nothing more), the read as its line count with the envelope's `output` as content.
    const results = events.filter(e => e.type === 'tool_result') as { content: string; isError: boolean; digest?: string }[]
    expect(results.map(r => r.digest)).toEqual(['+1 −0', '+1 −1', '1 line'])
    expect(results[2].content).toBe('hello world\r\n')
    expect(results.map(r => r.isError)).toEqual([false, false, false])
  })

  it('resolves 0.146’s `const patch = "…"` spelling, numbers a multi-call script, and keeps the raw script as the last resort', () => {
    const a = new CodexAdapter()
    const exec = (input: string) => (a.apply(a.parseEntry(JSON.stringify({ timestamp: 'T', type: 'response_item',
      payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c', input } }))!, 0).events[0] as { tools: Tool[] }).tools[0]
    expect(exec('const patch = "*** Begin Patch\\n*** Delete File: a.txt\\n*** End Patch"; text(await tools.apply_patch(patch));'))
      .toMatchObject({ name: 'apply_patch', input: { path: 'a.txt', patch: '--- a/a.txt\n+++ /dev/null\n@@' } })
    expect(exec('const r = await Promise.all([tools.exec_command({ cmd: "ls", workdir: "/w", }), tools.exec_command({cmd:\'pwd\'})]); text(r);'))
      .toMatchObject({ name: 'exec', input: { command: 'ls', 'command (2)': 'pwd' } })
    expect(exec('text(1)').input).toEqual({ script: 'text(1)' })   // no tools.* call at all
  })

  it('reads: every statement a whole-file read → one read row over its paths; results unwrap the sandbox envelope', () => {
    const a = new CodexAdapter()
    const line = (payload: object) => a.parseEntry(JSON.stringify({ timestamp: 'T', type: 'response_item', payload }))!
    const exec = (input: string) => (a.apply(line({ type: 'custom_tool_call', name: 'exec', call_id: 'c', input }), 0).events[0] as { tools: Tool[] }).tools[0]
    const out = (output: string) => a.apply(line({ type: 'custom_tool_call_output', call_id: 'c', output }), 0).events[0] as { content: string; isError: boolean; digest?: string }
    const wrap = (verdict: string, body: string) => `Script ${verdict}\nWall time 0.1 seconds\nOutput:\n${body}`
    expect(exec(`text(await tools.exec_command({cmd:"Get-Content -Raw -Encoding utf8 'docs/a b.md'; nl -ba b.ts | sed -n '1,40p'", workdir:"/w"}))`))
      .toEqual({ id: 'c', name: 'read', input: { path: 'docs/a b.md', 'path (2)': 'b.ts' } })
    expect(out(wrap('completed', '\n{"chunk_id":"x","exit_code":0,"output":"one\\ntwo\\n"}'))).toMatchObject({ content: 'one\ntwo\n', digest: '2 lines', isError: false })
    // A pipe into a search, a second path, or a non-read statement keeps the exec row (plumbing args dropped).
    expect(exec('text(await tools.exec_command({cmd:"Get-Content a.md | Select-String foo", yield_time_ms: 10000}))').input).toEqual({ command: 'Get-Content a.md | Select-String foo' })
    expect(out(wrap('completed', '{"chunk_id":"x","exit_code":1,"output":"boom\\n"}'))).toMatchObject({ content: 'boom\n', digest: 'boom', isError: true })
    expect(out(wrap('failed', '\nScript error:\nno such file'))).toMatchObject({ content: 'no such file', digest: 'no such file', isError: true })
    expect(out('Script running with cell ID 4\nWall time 11.0 seconds\nOutput:\n')).toMatchObject({ content: '', digest: 'running (cell 4)', isError: false })
  })

  it('takes usage from last_token_usage (cached overlap subtracted) and model from turn_context', () => {
    const { usage, model } = render(new CodexAdapter(), ROLLOUTS.scratchpad)
    // Final token_count: input 14584 INCLUDING 14080 cached — the chip sums in+cached+cacheCreate,
    // so `in` must carry only the uncached remainder.
    expect(usage).toEqual({ in: 504, out: 21, cached: 14080, cacheCreate: 0 })
    expect(model).toBe('gpt-5.6-terra')
  })
})

describe('CodexAdapter status + picker + search', () => {
  it('chainWorking follows task_started/task_complete boundaries', () => {
    const a = new CodexAdapter()
    const entries = drain(a, ROLLOUTS.scratchpad)
    expect(a.chainWorking(entries)).toBe(false)           // task_complete is the last boundary
    expect(a.chainWorking(entries.slice(0, 20))).toBe(true)   // mid-turn: started, not yet complete
    expect(a.chainWorking(entries.slice(0, 1))).toBe(false)   // header only — no turn yet
  })

  it('readPreview is the kickoff user_message', () => {
    const a = new CodexAdapter()
    expect(a.readPreview(join(FIXTURES, ROLLOUTS.typebulb))).toBe('testing: 1+1=?')
    expect(a.readPreview(join(FIXTURES, ROLLOUTS.scratchpad))).toMatch(/^Run this exact PowerShell command/)
  })

  it('searchText indexes conversation only — never base_instructions, envelopes, or event twins', () => {
    const a = new CodexAdapter()
    const entries = drain(a, ROLLOUTS.scratchpad)
    const corpus = entries.map(e => a.searchText(e)).filter(Boolean).join('\n')
    expect(corpus).toContain('Run this exact PowerShell command')
    expect(corpus).toContain('CreateProcessWithLogonW')   // the assistant's final answer
    expect(corpus).not.toContain('You are Codex')         // session_meta base_instructions (~10KB/file)
    expect(corpus).not.toContain('recommended_plugins')   // user-role envelope block
    expect(corpus).not.toContain('multi_agent_mode')      // developer-role envelope
    // The twins would double every hit — exactly one line matches the prompt.
    expect(entries.map(e => a.searchText(e)).filter(t => t.includes('PowerShell')).length).toBe(1)
  })
})

describe('CodexAdapter discovery (scan-and-filter)', () => {
  // A fake ~/.codex/sessions: date-partitioned, all three fixtures in one day dir, plus the noise
  // the scan must tolerate — a not-yet-flushed empty rollout, a compressed (non-.jsonl) one, and a
  // `.jsonl` whose first line is complete junk (a corrupt/compressed-in-place file).
  function fakeRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'tb-codex-'))
    const day = join(root, '2026', '08', '01')
    mkdirSync(day, { recursive: true })
    for (const f of Object.values(ROLLOUTS)) copyFileSync(join(FIXTURES, f), join(day, f))
    writeFileSync(join(day, 'rollout-2026-08-01T18-00-00-empty.jsonl'), '')
    writeFileSync(join(day, 'rollout-2026-07-01T09-00-00-old.jsonl.zst'), 'compressed')
    writeFileSync(join(day, 'rollout-2026-08-01T18-01-00-junk.jsonl'), 'not json at all\nnor this\n')
    return root
  }

  it('filters by session_meta cwd, keyed by file stem', () => {
    const a = new CodexAdapter(fakeRoot())
    const hits = a.listSessionFiles('C:\\Code\\typebulb')
    expect(hits.length).toBe(1)
    expect(hits[0].sessionId).toBe(ROLLOUTS.typebulb.slice(0, -'.jsonl'.length))
    expect(a.listSessionFiles('C:\\tmp').length).toBe(1)
    expect(a.listSessionFiles('C:\\somewhere\\else').length).toBe(0)
  })

  // Case-folding is win32-ONLY: there a path typed in any casing is the same project; on a
  // case-sensitive filesystem `/work/Foo` and `/work/foo` are two projects and must not mirror
  // each other (TB-Agent-Codex.md Invariant 1).
  it('case-folds cwds on win32 and nowhere else', () => {
    const a = new CodexAdapter(fakeRoot())
    expect(a.listSessionFiles('c:\\code\\TYPEBULB').length).toBe(process.platform === 'win32' ? 1 : 0)
  })

  it('the sessions root itself is cwd-independent and empty-safe', () => {
    const a = new CodexAdapter(join(tmpdir(), 'tb-codex-does-not-exist'))
    expect(a.sessionsDir('C:\\x')).toBe(a.sessionsDir('C:\\y'))
    expect(a.listSessionFiles('C:\\x')).toEqual([])
  })
})

describe('codex fixtures stay pinned', () => {
  it('all three verified rollouts are present', () => {
    expect(readdirSync(FIXTURES).filter(f => f.endsWith('.jsonl')).sort()).toEqual(Object.values(ROLLOUTS).sort())
  })
})
