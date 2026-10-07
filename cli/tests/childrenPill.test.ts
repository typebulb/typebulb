import { describe, it, expect } from 'vitest'
import { byAncestry } from '../agents/core/order.js'
import { childDigest, editedFiles, commandsOf, notable, quietRuns, babysitEvents, fileTouches, sharedFiles, agentReport, statusText, overviewText, NO_GIT } from '../agents/core/childStatus.js'
import { isRead, commandLabel } from '../agents/core/shell.js'
import { checkFiles } from '../agents/core/server/childReport.js'
import type { Event } from '../agents/core/events.js'
import type { ChildRow } from '../agents/core/client/types.js'

/**
 * Agents-pill row order (TB-Agent-Children.md): indentation is the only thing on a row that says who
 * spawned it, so the row above a nested one has to BE its parent. mtime alone cannot express that —
 * a child is almost always newer than the agent that spawned it — and in the field a depth-2 agent
 * sorted between two unrelated siblings, where it read as the child of whichever happened to precede
 * it (TB-Agent-Children-Codex.md).
 */
const row = (id: string, parentId?: string): ChildRow => ({
  id, parentId, depth: parentId ? 2 : 1, label: id, kind: 'agent',
  file: `${id}.jsonl`, mtime: 0, stopped: false, state: 'done',
})

describe('byAncestry', () => {
  it('puts each agent directly above the agents it spawned, and keeps sibling order', () => {
    // 'kid' arrives mid-list by recency, as a live depth-2 agent did; it belongs under 'd'.
    const out = byAncestry([row('a'), row('b'), row('kid', 'd'), row('c'), row('d')])
    expect(out.map(r => r.id)).toEqual(['a', 'b', 'c', 'd', 'kid'])
  })

  it('treats a row whose parent is not in the list as top level', () => {
    // The parent's transcript is gone, so there is nothing to nest under; the row still belongs.
    expect(byAncestry([row('a'), row('orphan', 'gone')]).map(r => r.id)).toEqual(['a', 'orphan'])
  })

  it('keeps every row when parent links form a cycle', () => {
    // Malformed, so no row is reachable from the top; dropping them would hide live agents.
    expect(byAncestry([row('x', 'y'), row('y', 'x')]).map(r => r.id).sort()).toEqual(['x', 'y'])
  })
})

// A child's Status (TB-Agent-Children.md): facts counted from its events, no model call.
const min = 60_000
const brief: Event = { type: 'user', text: 'brief', at: 0 }
const call = (id: string, name: string, input: Record<string, unknown>, at = 0): Event =>
  ({ type: 'assistant', text: '', thinking: '', tools: [{ id, name, input }], live: false, at })
const result = (id: string, content: string, at = 0, more: Partial<Extract<Event, { type: 'tool_result' }>> = {}): Event =>
  ({ type: 'tool_result', id, content, isError: false, at, ...more })
const nofiles = { edited: [], writes: [], reads: [], shellReads: [] }

describe('editedFiles', () => {
  it('lists edit-tool writes, patch headers and git moves inside the project, and skips failed calls', () => {
    const tools: [string, Record<string, unknown>, boolean?][] = [
      ['mcp__patcher__patch', { filePath: 'C:\\proj\\docs\\a.md', diff: '@@\n-x\n+y' }],
      ['Write', { file_path: 'C:/proj/src/new.ts', content: 'x' }],
      ['Edit', { file_path: 'C:/proj/src/failed.ts', old_string: 'a', new_string: 'b' }, true],
      ['Write', { file_path: 'C:/elsewhere/scratch.md', content: 'x' }],
      ['apply_patch', { patch: '--- /dev/null\n+++ b/C:/proj/src/added.ts\n@@\n+x\n--- a/src/gone.ts\n+++ /dev/null\n@@\n-x' }],
      ['Bash', { command: 'cd /c/proj && git rm -q src/old.ts && git mv src/new.ts src/renamed.ts' }],
      ['Read', { file_path: 'C:/proj/src/read.ts' }],
    ]
    const d = childDigest([brief, ...tools.flatMap(([name, input, isError], i) => [call(`t${i}`, name, input), result(`t${i}`, '', 0, { isError: !!isError })])])
    expect(editedFiles(d, 'C:\\proj')).toEqual([
      { path: 'docs/a.md' },
      { path: 'src/added.ts' },
      { path: 'src/gone.ts', deleted: true },
      { path: 'src/old.ts', deleted: true },
      { path: 'src/renamed.ts', from: 'src/new.ts' },
    ])
  })
})

describe('childDigest', () => {
  // A stop between the hand-back and the parent's next message is neither work nor tool time.
  it('counts a wait for the parent as idle, and splits the rest between tools and the model', () => {
    const d = childDigest([
      brief, call('t', 'Bash', { command: 'build' }, min), result('t', 'ok', 2 * min),
      { type: 'assistant', text: 'READY', thinking: '', tools: [], live: false, at: 3 * min }, { type: 'turn_end', at: 3 * min },
      { type: 'user', text: 'Phase 2', at: 63 * min },
      { type: 'assistant', text: 'Done', thinking: '', tools: [], live: false, at: 64 * min }, { type: 'turn_end', at: 64 * min },
    ])
    expect([d.span, d.idle, d.toolMs, d.turnEnds]).toEqual([4 * min, 60 * min, min, [3 * min, 64 * min]])
  })
})

describe('commandsOf', () => {
  it('groups by command, keeps a failure streak, and never counts a call that did not run', () => {
    const d = childDigest([
      brief,
      call('a', 'Bash', { command: 'cd /c/proj && npm test' }), result('a', 'Exit code 1\nFAIL one\n1 failed', min, { isError: true, exit: 1 }),
      call('b', 'Bash', { command: 'npm test' }), result('b', '<tool_use_error>Blocked</tool_use_error>', min, { isError: true, refused: true }),
      call('c', 'Bash', { command: 'npm test' }, 2 * min), result('c', 'Exit code 1\n#12 vitest: refused\nlog: x.log', 4 * min, { isError: true, exit: 1 }),
    ])
    const [g] = commandsOf(d).groups
    expect([g!.cmd, g!.runs, g!.failed, g!.streak]).toEqual(['npm test', 2, 2, 2])
    expect([g!.latest.exit, g!.latest.ms, g!.latest.first, g!.latest.last]).toEqual([1, 2 * min, '#12 vitest: refused', 'log: x.log'])
  })

  it('keeps a background call open until its notice, then takes the notice\'s exit', () => {
    const events: Event[] = [brief, call('a', 'Bash', { command: 'need -- vitest' }), result('a', 'Command running in background', 0, { background: true })]
    expect(commandsOf(childDigest(events)).groups[0]!.latest.open).toBe(true)
    const done = commandsOf(childDigest([...events, { type: 'task_done', id: 'a', outcome: 'completed', exit: 0, at: 9 * min }])).groups[0]!.latest
    expect([done.open, done.failed, done.ms]).toEqual([false, false, 9 * min])
  })
})

describe('sharedFiles', () => {
  const row = (id: string, label: string) => ({ id, label, file: '', mtime: 0, depth: 1, stopped: false, state: 'done' as const })
  // The overwritten audit: B replaced the file over A's rewrite without reading it after.
  it('marks a whole-file write over another agent\'s with no read between as blind, in both reports', () => {
    const a = childDigest([brief, call('w', 'Write', { file_path: 'C:/p/docs/T.md', content: 'A' }), result('w', '', 10 * min)])
    const b = childDigest([brief, call('r', 'Read', { file_path: 'C:/p/docs/T.md' }), result('r', '', 5 * min),
      call('w', 'Write', { file_path: 'C:/p/docs/T.md', content: 'B' }), result('w', '', 20 * min)])
    const ta = fileTouches(a, 'C:/p'), tb = fileTouches(b, 'C:/p')
    const shared = sharedFiles([{ id: 'A', ...ta }, { id: 'B', ...tb }])
    const names = new Map([['A', 'audit'], ['B', 'baseline']])
    expect(shared.blind.map(x => [x.by, x.over])).toEqual([['B', 'A']])
    const text = statusText(agentReport(row('A', 'audit'), a, ta, shared, names, true), 30 * min)
    expect(text).toMatch(/docs\/T\.md {2}also "baseline"/)
    expect(text).toMatch(/⚠ "baseline" wrote over this agent's/)
  })

  // babysit's first fire was a false alarm: a patcher edit applies only where its context still
  // stands, so it cannot overwrite another agent's change unseen. Shared, not blind.
  it('leaves a context-checked edit over another agent\'s write as shared', () => {
    const a = childDigest([brief, call('w', 'Write', { file_path: 'C:/p/docs/T.md', content: 'A' }), result('w', '', 10 * min)])
    const b = childDigest([brief, call('w', 'mcp__patcher__patch', { filePath: 'C:/p/docs/T.md', diff: '@@' }), result('w', '', 20 * min)])
    const shared = sharedFiles([{ id: 'A', ...fileTouches(a, 'C:/p') }, { id: 'B', ...fileTouches(b, 'C:/p') }])
    expect(shared.blind).toEqual([])
    expect(shared.writers.get('docs/T.md')!.map(w => w.id)).toEqual(['A', 'B'])
  })
})

describe('statusText', () => {
  // A running agent's wait since its last entry is active time, so it never reads as waiting longer
  // than it has existed ("running 4m · waiting 11m").
  it('counts a running agent\'s open wait as active and as tool time', () => {
    const d = childDigest([brief, call('a', 'Bash', { command: 'need -- vitest' }, min)])
    const row = { id: 'x', label: 'x', file: '', mtime: 0, depth: 1, stopped: false, state: 'running' as const }
    const text = statusText(agentReport(row, d, nofiles, { writers: new Map(), blind: [] }, new Map(), true), 11 * min)
    expect(text).toMatch(/running · 11m active/)
    expect(text).toMatch(/Time: 10m in tools, 1m in the model/)
  })

  // Shown only while open, a quick call's row blinked out between calls. While the agent runs, its
  // latest call holds the row until the next; once it finishes, the call leaves Now.
  it('keeps a running agent\'s latest call in Now between calls, and drops it once the agent finishes', () => {
    const d = childDigest([brief, call('a', 'mcp__smith__step', { description: 'close the doorway' }, min), result('a', 'ok', min + 1000)])
    const report = (state: 'running' | 'done') => agentReport({ id: 'x', label: 'x', file: '', mtime: 0, depth: 1, stopped: false, state }, d, nofiles,
      { writers: new Map(), blind: [] }, new Map(), true)
    expect(statusText(report('running'), 2 * min)).toMatch(/\nLatest: .*close the doorway · ok after 1s\n/)
    expect(statusText(report('done'), 2 * min)).not.toMatch(/Latest:/)
    // A failed edit ran, so it holds the row; only a shell call that errored without an exit never ran.
    const edit = childDigest([brief, call('e', 'Edit', { file_path: 'C:/p/a.ts', old_string: 'x', new_string: 'y' }, min),
      result('e', 'String to replace not found', min + 1000, { isError: true, refused: true })])
    const text = statusText(agentReport({ id: 'x', label: 'x', file: '', mtime: 0, depth: 1, stopped: false, state: 'running' }, edit, nofiles,
      { writers: new Map(), blind: [] }, new Map(), true), 2 * min)
    expect(text).toMatch(/\nLatest: Edit.* · error after 1s\n/)
  })

  // Files read lists every file it read, written ones too: CC reads before each edit, so leaving those
  // out showed one file for an agent that read sixteen. Repeats count, and the newest read is last.
  it('lists every file read, newest last, after everything else', () => {
    const d = childDigest([brief,
      call('a', 'Read', { file_path: 'C:/p/a.ts' }), result('a', '', min),
      call('b', 'Read', { file_path: 'C:/p/b.ts' }), result('b', '', 2 * min),
      call('c', 'Read', { file_path: 'C:/p/a.ts' }), result('c', '', 3 * min),
      call('e', 'Read', { file_path: 'C:/p/e.ts' }), result('e', '', 4 * min),
      call('w', 'Edit', { file_path: 'C:/p/e.ts', old_string: 'x', new_string: 'y' }), result('w', '', 5 * min)])
    const row = { id: 'x', label: 'x', file: '', mtime: 0, depth: 1, stopped: false, state: 'done' as const }
    const text = statusText(agentReport(row, d, fileTouches(d, 'C:/p'), { writers: new Map(), blind: [] }, new Map(), true), 6 * min)
    expect(text).toMatch(/Files written: 1 \(1 uncommitted\)\n {2}e\.ts\n/)
    expect(text.split('Files read: 3\n')[1]).toBe('  b.ts\n  a.ts ×2\n  e.ts')
    // Past 30 the earliest fold into a count; the newest, where its attention is now, stay.
    const many = childDigest([brief, ...Array.from({ length: 32 }, (_, i) => [call(`r${i}`, 'Read', { file_path: `C:/p/f${i}.ts` }), result(`r${i}`, '', min)]).flat()])
    const long = statusText(agentReport(row, many, fileTouches(many, 'C:/p'), { writers: new Map(), blind: [] }, new Map(), true), 6 * min)
    expect(long).toMatch(/Files read: 32\n {2}\+2 earlier\n {2}f2\.ts\n/)
  })

  // Codex has no read tool: it reads through its shell, often capturing a file to slice it, and a
  // read-only script arrives as a read row. Files read showed none for its largest agents, and none
  // for one that reviewed another project's files.
  it('counts files read through the shell and read rows, outside the project by full path', () => {
    const d = childDigest([brief,
      call('a', 'exec', { command: '$lines = Get-Content -LiteralPath docs/T.md -Encoding UTF8; $lines[0..74]; rg -n x src', workdir: 'C:\\p' }), result('a', '', min),
      call('b', 'read', { path: 'README.md', 'path (2)': 'src/a.ts' }), result('b', '', 2 * min),
      call('c', 'exec', { command: 'cat *.md', 'command (2)': 'sed -n 1,40p src/b.ts' }), result('c', '', 3 * min),
      call('d', 'exec', { command: "$p = 'C:\\other\\Spec.md'; $lines = Get-Content -LiteralPath $p; $lines[0..9]" }), result('d', '', 4 * min)])
    expect(agentReport({ id: 'x', label: 'x', file: '', mtime: 0, depth: 1, stopped: false, state: 'done' }, d, fileTouches(d, 'C:/p'),
      { writers: new Map(), blind: [] }, new Map(), true).read.map(f => f.path)).toEqual(['docs/T.md', 'README.md', 'src/a.ts', 'src/b.ts', 'C:/other/Spec.md'])
  })

  // `head -c 8 msu-paisley/plans.pdf` after a `cd` was listed as if the path were the project's.
  it('resolves a shell path against a leading cd, for reads and git writes alike', () => {
    const d = childDigest([brief,
      call('a', 'Bash', { command: 'cd "C:/p/tests/scratch"; head -c 8 msu/plans.pdf' }), result('a', '', min),
      call('b', 'PowerShell', { command: 'Set-Location C:\\other; Get-Content ..\\q\\a.md' }), result('b', '', 2 * min),
      call('c', 'Bash', { command: 'cd docs && git rm -q old.md' }), result('c', '', 3 * min)])
    const t = fileTouches(d, 'C:/p')
    expect([t.shellReads.map(r => r.path), t.edited]).toEqual([['tests/scratch/msu/plans.pdf', 'C:/q/a.md'], [{ path: 'docs/old.md', deleted: true }]])
  })

  // The agent's own words, one line each. A finished agent's closing text is its report, not narration.
  it('lists its narration by first line, without a finished agent\'s report', () => {
    const say = (text: string, at: number): Event => ({ type: 'assistant', text, thinking: '', tools: [], live: false, at })
    const d = childDigest([brief, say('Reading the plans.\nThen the specs.', min), call('a', 'Bash', { command: 'npm test' }, min), result('a', 'ok', min),
      say('All done.\nDetails follow.', 2 * min)])
    const text = (state: 'running' | 'done') => statusText(agentReport({ id: 'x', label: 'x', file: '', mtime: 0, depth: 1, stopped: false, state }, d, nofiles,
      { writers: new Map(), blind: [] }, new Map(), true), 3 * min)
    expect(text('running')).toMatch(/\nNarration:\n {2}Reading the plans\.\n {2}All done\.\nFiles written/)
    expect(text('done')).toMatch(/\nNarration:\n {2}Reading the plans\.\nFiles written/)
  })
})

describe('overviewText', () => {
  // Fifteen rows, twelve of them finished with nothing to act on, buried the three that mattered.
  it('lists only agents that still ask something, and names a wait in the agent\'s own words', () => {
    const none = { writers: new Map(), blind: [] }
    const row = (id: string, state: 'running' | 'done') => ({ id, label: id, file: '', mtime: 0, depth: 1, stopped: false, state })
    const busyD = childDigest([brief, call('a', 'Bash', { command: 'date +%T; npm run need -- check 2>&1 | tail -30', description: 'Run the follow check' }, min)])
    const idleD = childDigest([brief])
    const agents = [
      { ...agentReport(row('runner', 'running'), busyD, nofiles, none, new Map(), true), depth: 1 },
      { ...agentReport(row('done1', 'done'), idleD, nofiles, none, new Map(), true), depth: 1 },
      { ...agentReport(row('done2', 'done'), idleD, nofiles, none, new Map(), true), depth: 1 },
    ]
    const text = overviewText('s', agents, [], 3 * min)
    expect(text).toMatch(/runner .* waiting 2m on Run the follow check/)
    expect(text).not.toMatch(/done1/)
    expect(text).toMatch(/\+2 finished, nothing to check/)
  })

  // Cut off mid-work, a stopped agent may have left an edit half done, like a running one. One that
  // left nothing folds into the count, named as a stop.
  it('lists a stopped agent with uncommitted writes, and folds one without', () => {
    const d = childDigest([brief, call('w', 'Edit', { file_path: 'C:/p/a.ts', old_string: 'x', new_string: 'y' }), result('w', '', min)])
    const t = fileTouches(d, 'C:/p'), shared = sharedFiles([{ id: 'cut', ...t }])
    const r = { ...agentReport({ id: 'cut', label: 'cut', file: '', mtime: 0, depth: 1, stopped: true, state: 'stopped' }, d, t, shared, new Map(), true), depth: 1 }
    const old = { ...agentReport({ id: 'old', label: 'old', file: '', mtime: 0, depth: 1, stopped: true, state: 'stopped' }, childDigest([brief]), nofiles, shared, new Map(), true), depth: 1 }
    const text = overviewText('s', [r, old], checkFiles([r, old], shared, NO_GIT), 3 * min)
    expect(text).toMatch(/\n {2}a\.ts {2}"cut" \(stopped\)\n/)
    expect(text).toMatch(/\n {2}cut {2}stopped/)
    expect(text).toMatch(/\n {2}\+1 stopped, nothing to check/)
  })
})

describe('isRead', () => {
  // A delegator reads Commands for runs, changes and failures; an agent reading files is none of them.
  it('folds a line only when every part of it reads', () => {
    for (const cmd of ['grep -n "x" docs/T.md | head -40', 'git log -1 --format=%ct -- a.ts', 'sed -n 1,40p a.md',
      'for p in "a" "b"; do echo "== $p: $(grep -c "$p" a.md)"; done', 'Get-Content a.log -Tail 20 2>$null']) expect(isRead(cmd)).toBe(true)
    for (const cmd of ['date +%T; npm run need -- check 2>&1 | tail -30', 'sed -i s/a/b/ a.md', 'git commit -m x',
      'grep x a.md > hits.txt', 'until grep -q done a.out; do sleep 3; done', 'Stop-Process -Id 4', 'echo "$(rm a)"']) expect(isRead(cmd)).toBe(false)
  })
})

describe('isRead with quoted patterns', () => {
  // A grep's `\|` alternation sits inside quotes; split there, the line read as several broken commands.
  it('keeps quoted text whole and reads an assigned substitution', () => {
    expect(isRead('grep -n "action:\s*command\|{action" tests/cli.mjs | head')).toBe(true)
    expect(isRead('for f in $(ls -t logs/*.log | head -40); do l=$(grep -h "cpu probe" "$f" | head -1); echo "$l"; done')).toBe(true)
    expect(isRead('grep -h "a\|b" x.txt > out.txt')).toBe(false)
    // typebulb's own inspection, which an agent runs on itself, is a read.
    expect(isRead('npx typebulb status a6883ecb')).toBe(true)
    expect(isRead('npx typebulb push x.bulb.md')).toBe(false)
  })
})

describe('commandLabel', () => {
  // Clipped at its reads, `cat "C:/Users/…/throttleState.ps1"; …` hid the script it went on to run.
  it('names a mixed line from its first part that does more than read', () => {
    expect(commandLabel('cat "a b.ps1"; echo ----; powershell -File "a b.ps1"')).toBe('…powershell -File "a b.ps1"')
    expect(commandLabel('npm run need -- status 2>&1 | tail -5')).toBe('npm run need -- status 2>&1 | tail -5')
    expect(commandLabel('date; until grep -q ok a.out; do sleep 5; done')).toBe('…until grep -q ok a.out; do sleep 5; done')
    expect(commandLabel("cat > s.js <<'EOF'\nconst x = 1\nEOF\nnode s.js")).toBe("cat > s.js <<'EOF' … EOF\nnode s.js")
  })
})

describe('notable commands', () => {
  // From takeoff's day of decisions (TB-Agent-Children.md): what changed a parent's mind is listed,
  // a check that passed folds into a count.
  it('lists failures, repeats and process stops, and folds the rest', () => {
    const run = (id: string, command: string, more: Partial<Extract<Event, { type: 'tool_result' }>> = {}): Event[] =>
      [call(id, 'Bash', { command }), result(id, 'ok', 0, more)]
    const c = commandsOf(childDigest([brief,
      ...run('a', 'npm run need -- check'),
      ...run('b', 'npm run need -- vitest x', { isError: true, exit: 64 }),
      ...run('c', 'Stop-Process -Id 35072'),
      ...run('d', 'npm run live -- tabs | grep medley', { isError: true, exit: 1 }),
      ...run('e', 'node probe.js'), ...run('f', 'node probe.js'), ...run('g', 'node probe.js'),
    ]))
    expect(c.groups.filter(notable).map(g => g.cmd).sort()).toEqual(['Stop-Process -Id 35072', 'node probe.js', 'npm run need -- vitest x'])
    expect(quietRuns(c).runs).toBe(2)                     // the check, and the grep that matched nothing
    expect(c.failed).toBe(1)
  })

  // Listed for being open, a command showed in Now and Commands at once, then in neither when it
  // finished. Now alone shows what is open, with its latest output line, and an open run has not passed.
  it('leaves an open command to Now, with its output line, and out of the passed count', () => {
    const d = childDigest([brief, call('a', 'Bash', { command: 'need -- vitest' }), result('a', 'Command running in background', 0, { background: true, output: 'out.log' })])
    const c = commandsOf(d)
    expect([c.groups.filter(notable).length, quietRuns(c).runs]).toEqual([0, 0])
    const r = agentReport({ id: 'x', label: 'x', file: '', mtime: 0, depth: 1, stopped: false, state: 'running' }, d, nofiles,
      { writers: new Map(), blind: [] }, new Map(), true, () => 'start\n#39 still queued 220.1 s')
    expect(statusText(r, min)).toMatch(/Now: need -- vitest, 1m \(background\)\n {2}"#39 still queued 220\.1 s"/)
  })
})

describe('babysitEvents', () => {
  // `typebulb babysit` wakes the parent on these; a key carries no minutes, so a condition fires
  // once while it lasts, and its texts keep the overview's fixed phrases.
  const none = { writers: new Map(), blind: [] }
  const agent = (id: string, state: 'running' | 'done', events: Event[]) =>
    agentReport({ id, label: id, file: '', mtime: 0, depth: 1, stopped: false, state }, childDigest([brief, ...events]), nofiles, none, new Map(), true)

  it('names an idle stall, a deadlock of waits, and a background call left running', () => {
    const idle = babysitEvents([agent('a', 'done', [call('x', 'Bash', { command: 'npm test' }, min), result('x', 'ok', min)])], 7 * min)
    expect([...idle.keys()]).toEqual(['idle'])
    expect(idle.get('idle')).toMatch(/^No agent running for 6m/)

    const waits = babysitEvents(['a', 'b'].map(id => agent(id, 'running', [call(`${id}1`, 'Bash', { command: 'npm run need -- check' }, 0)])), 3 * min)
    expect(waits.get('waiting')).toMatch(/^2 agents waiting on calls at once/)

    const bg = babysitEvents([agent('a', 'done', [call('b1', 'Bash', { command: 'sleep 900' }, 0), result('b1', 'Command running in background', 0, { background: true })])], 11 * min)
    expect(bg.get('background:b1')).toMatch(/finished, background call running 11m/)
  })
})
