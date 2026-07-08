/**
 * Pi patcher extension — matchu-patchu as pi's edit tool (TB-Agent-Pi-Patcher.md).
 *
 * esbuild-bundled (lib inlined, `typebox` external — pi ships it) to `dist/agents/pi/matchu-patchu.ts`;
 * `ensurePiExtension()` copies that into `~/.pi/agent/extensions/` next to typebulb.ts on every CLI run.
 * Registers `patch` and removes the built-in `edit` from the active tool set — replacement, not
 * compensation. Both happen on session_start, not at load: pi's post-load conflict scan exits 1
 * when two extensions register the same tool name — detected outside any extension's try/catch —
 * so the shim registers late and yields when `getAllTools()` shows another extension already
 * provides `patch`; a project's own patcher must never kill pi's boot (P3). Post-load registerTool
 * is supported (refreshTools → _refreshToolRegistry auto-activates new names and rebuilds the
 * prompt). Removal uses `pi.setActiveTools()`: the verified route to the real API tool list
 * (setActiveToolsByName sets agent.state.tools AND rebuilds the prompt); action methods throw
 * during extension load, hence the handler. session_start re-fires on new/resume/fork/reload, so
 * the ownership check and the `edit` removal both re-apply.
 *
 * Error channel: pi tools THROW on failure (the runtime renders it as an isError tool result), so
 * the apply helpers return `{ ok, message }` and execute throws the message. Semantics port the
 * published matchu-patchu-mcp server's applyCore; the one addition is multi-file mode when
 * `filePath` is omitted (P2: Patcher.Apply is pure, and no byte lands unless the whole changeset
 * carries zero errors on both channels — per-file and patch-scoped).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Type } from 'typebox'
import { Patcher, PatchInputFile, PatchParserException } from 'matchu-patchu'

// Replaced at build time by esbuild `define` with the package's description.md verbatim — the same
// text the MCP server presents, so both harnesses teach the tool identically. Literal = tsc fallback.
declare const __MATCHU_DESCRIPTION__: string
const DESCRIPTION: string =
  typeof __MATCHU_DESCRIPTION__ !== 'undefined' ? __MATCHU_DESCRIPTION__ : 'Apply unified diffs to files.'

// Appended to success messages (the MCP server's idiom) so transcript mining can attribute a
// result to a patcher build. Injected via esbuild define; literal = tsc fallback.
declare const __MATCHU_PI_TAG__: string
const BUILD_TAG: string = typeof __MATCHU_PI_TAG__ !== 'undefined' ? __MATCHU_PI_TAG__ : 'matchu-patchu-pi dev'

export interface PatchArgs {
  diff: string
  filePath?: string
  dryRun?: boolean
}

export interface PatchOutcome {
  ok: boolean
  message: string
}

const errorBlocks = (errors: { toString(): string }[]) => {
  const parts = [`Patch failed with ${errors.length} error(s):`]
  for (const e of errors) parts.push('', e.toString())
  return parts.join('\n')
}

// Zero edits is a no-op, not a normal success: say why, and don't touch the file
// (a rewrite of identical content still churns mtime/watchers).
const noOpMessage = (target: string, alreadyApplied: number) =>
  alreadyApplied > 0
    ? `Applied 0 edit(s) to ${target}: the file already contains this change (${alreadyApplied} chunk(s) detected as already applied). File left unmodified.`
    : `Applied 0 edit(s) to ${target}: the patch parsed but produced no changes for this file. File left unmodified.`

const fuzzNote = (fuzz: number) => (fuzz > 0 ? ` (applied with fuzz factor ${fuzz})` : '')

/**
 * The file keys a diff's headers name, exactly as the patcher will group hunks: an Apply with no
 * input files reports every header key as a patch-scoped FileMismatch, so discovery rides the
 * lib's own parser (`a/`/`b/` stripping and all) — matching in the real pass holds by construction.
 */
export function discoverDiffKeys(diff: string): string[] {
  const keys: string[] = []
  for (const e of Patcher.Apply(diff, []).Errors) {
    if (e.FileKey && !keys.includes(e.FileKey)) keys.push(e.FileKey)
  }
  return keys
}

// Single-file mode: headers ignored, the MCP applyCore semantics verbatim (headerless/bare-hunk
// diffs included). Node keeps a UTF-8 BOM as a leading char in the string, so a BOM round-trips
// through OutputFullText on its own (matching is BOM-tolerant via the lib's invisible-stripping).
function applySingle(cwd: string, filePath: string, diff: string, dryRun: boolean): PatchOutcome {
  const abs = resolve(cwd, filePath)
  if (!existsSync(abs)) return { ok: false, message: `Error: file not found: ${filePath}` }
  const out = Patcher.Apply(diff, [new PatchInputFile('', readFileSync(abs, 'utf-8'))]).Files[0]
  if (out.Errors.length > 0) return { ok: false, message: errorBlocks(out.Errors) }
  if (out.Edits.length === 0) return { ok: true, message: noOpMessage(filePath, out.AlreadyAppliedCount) }
  if (!dryRun) writeFileSync(abs, out.OutputFullText)
  return {
    ok: true,
    message:
      `Successfully applied ${out.Edits.length} edit(s) to ${filePath}${fuzzNote(out.Fuzz)}.` +
      (dryRun ? `\n\n--- patched output ---\n${out.OutputFullText}` : ''),
  }
}

// Multi-file mode: one diff, one intent, however many files it touches. All-or-nothing across the
// changeset — a missing file or any error on either channel means nothing is written.
function applyMulti(cwd: string, diff: string, dryRun: boolean): PatchOutcome {
  const keys = discoverDiffKeys(diff)
  if (keys.length === 0)
    return { ok: false, message: 'Error: no file headers (---/+++) found in the diff — pass filePath to patch a headerless diff into one file' }
  const missing = keys.filter(k => !existsSync(resolve(cwd, k)))
  if (missing.length > 0)
    return { ok: false, message: missing.map(k => `Error: file not found: ${k}`).join('\n') }

  const inputs = keys.map(k => new PatchInputFile(k, readFileSync(resolve(cwd, k), 'utf-8')))
  const result = Patcher.Apply(diff, inputs)
  const errors = [...result.Errors, ...result.Files.flatMap(f => f.Errors)]
  if (errors.length > 0) return { ok: false, message: errorBlocks(errors) }

  const lines: string[] = []
  const dryOutputs: string[] = []
  for (const out of result.Files) {
    if (out.Edits.length === 0) {
      lines.push(noOpMessage(out.Key, out.AlreadyAppliedCount))
      continue
    }
    if (!dryRun) writeFileSync(resolve(cwd, out.Key), out.OutputFullText)
    else dryOutputs.push(`--- patched output: ${out.Key} ---\n${out.OutputFullText}`)
    lines.push(`Successfully applied ${out.Edits.length} edit(s) to ${out.Key}${fuzzNote(out.Fuzz)}.`)
  }
  return { ok: true, message: [lines.join('\n'), ...dryOutputs].join('\n\n') }
}

export function applyPatch(cwd: string, args: PatchArgs): PatchOutcome {
  if (!args.diff || !args.diff.trim()) return { ok: false, message: 'Error: patch is empty' }
  try {
    const out = args.filePath
      ? applySingle(cwd, args.filePath, args.diff, args.dryRun === true)
      : applyMulti(cwd, args.diff, args.dryRun === true)
    return out.ok ? { ok: true, message: `${out.message} [${BUILD_TAG}]` } : out
  } catch (ex) {
    if (ex instanceof PatchParserException)
      return { ok: false, message: `Error: failed to parse patch — ${ex.message}` }
    return { ok: false, message: `Error: ${ex instanceof Error ? ex.message : String(ex)}` }
  }
}

// The slice of ExtensionAPI this extension touches — typed locally so the bundle carries no pi
// type dependency (jiti resolves the real `pi` object at load).
interface PiApi {
  registerTool(tool: unknown): void
  on(event: string, handler: (event: unknown, ctx: { cwd: string }) => void): void
  getActiveTools(): string[]
  getAllTools(): { name: string; sourceInfo?: { path?: string } }[]
  setActiveTools(names: string[]): void
}

function logErr(...a: unknown[]) {
  try { console.error('[matchu-patchu]', ...a) } catch {}
}

/**
 * How session_start should treat `patch`: register it (absent), re-apply ours (ours), or stand
 * down to another extension's registration (foreign) — never colliding, so pi always boots (P3).
 * The flag covers same-process re-fires; the sourceInfo path covers lifecycles that reset it.
 */
export function patchOwnership(
  tools: { name: string; sourceInfo?: { path?: string } }[],
  registeredByUs: boolean,
): 'absent' | 'ours' | 'foreign' {
  const patch = tools.find(t => t.name === 'patch')
  if (!patch) return 'absent'
  return registeredByUs || /matchu-patchu/i.test(patch.sourceInfo?.path ?? '') ? 'ours' : 'foreign'
}

const PATCH_TOOL = {
  name: 'patch',
  label: 'Patch',
  description: DESCRIPTION,
  promptSnippet: 'Modify one or more existing files by applying a unified diff',
  promptGuidelines: [
    'Use patch for every edit to an existing file; write is only for creating new files or full rewrites.',
    "patch accepts lenient unified diffs: line numbers are optional and hunks anchor by context lines. One diff may target several files via ---/+++ headers; pass filePath instead for a headerless single-file diff.",
  ],
  parameters: Type.Object({
    diff: Type.String({ description: 'Unified diff content to apply' }),
    filePath: Type.Optional(Type.String({
      description: "Path of the single file to patch (absolute or relative to the project root); the diff's headers are then ignored. Omit to target the file(s) named by the diff's ---/+++ headers.",
    })),
    dryRun: Type.Optional(Type.Boolean({ description: 'If true, return the patched content without writing to disk' })),
  }),
  async execute(_id: string, params: PatchArgs, _signal: unknown, _onUpdate: unknown, ctx: { cwd: string }) {
    const { ok, message } = applyPatch(ctx.cwd, params)
    if (!ok) throw new Error(message)
    return { content: [{ type: 'text' as const, text: message }], details: {} }
  },
}

// Everything is wrapped so a throw can never break pi's startup — a failure degrades to stock pi (P3).
export default function (pi: PiApi) {
  let registeredPatch = false
  try {
    pi.on('session_start', () => {
      try {
        const owner = patchOwnership(pi.getAllTools(), registeredPatch)
        if (owner === 'foreign') {
          logErr('another extension already provides "patch" — typebulb patcher standing down (built-in edit kept)')
          return
        }
        if (owner === 'absent') {
          pi.registerTool(PATCH_TOOL)
          registeredPatch = true
        }
        // P1 — replace, not compensate: the built-in edit leaves the model's toolbox entirely.
        const active = pi.getActiveTools()
        if (active.includes('edit')) pi.setActiveTools(active.filter(n => n !== 'edit'))
      } catch (e) { logErr('session_start', e) }
    })
  } catch (e) { logErr('load', e) }
}
