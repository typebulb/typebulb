import * as path from 'path'
import { spawn, execSync } from 'child_process'
import { createRequire } from 'module'
import { existsSync } from 'fs'
import { readBulb, conventionalIdentity } from '../pipeline.js'
import { emitClientTypecheck } from '../dts/emit.js'
import { emitServerTypecheck } from '../dts/emitServer.js'
import { lint, type LintIssue } from 'typebulb/lint'
import { slugify } from 'typebulb/format'
import { type ResolvedLocalOverride } from '../localOverride.js'

/**
 * Type-check a bulb in one step. Emits the typecheck directory then runs a
 * resolved `tsc --noEmit` inside it (see resolveTscJs — never `npx tsc`).
 *
 * For bulbs with both code.tsx and server.ts, runs both and combines exit
 * codes. Each diagnostic line is prefixed with the role (`client` or `server`)
 * so multi-role output stays parseable. Exit is three-way: 0 clean, 1 issues
 * found (lint or type errors), 2 checker unavailable (no TypeScript resolved).
 */
export async function runCheck(bulbPath: string, local?: ResolvedLocalOverride): Promise<void> {
  const { bulb, config, warnings, starts } = await readBulb(bulbPath)

  // Every position we print is in the .bulb.md's coordinates, not the extracted block's: the bulb is
  // the only file the user (or an agent's tools) can open and link to, so `code.tsx(94,7)` costs a
  // hand-count of the block offset on every diagnostic (TB-CLI.md, One coordinate space).
  const bulbName = path.basename(bulbPath)
  const startOf = (blockFile: string) => starts.get(blockFile) ?? 1

  if (!bulb.code && !bulb.server) {
    console.error('Bulb has neither **code.tsx** nor **server.ts**; nothing to check.')
    process.exit(1)
  }

  let anyFailed = false
  let namingWarning = false

  // Structural problems (an unterminated fence swallowing a block) parse "successfully" but produce
  // wrong blocks, so a bulb can compile and run while malformed — `check` is the gate that catches it.
  for (const w of warnings) console.log(`structure\t${w}`)
  if (warnings.length) anyFailed = true

  // Only a conventional path carries a remote identity (TB-Push-Pull.md Invariant 4), and only there
  // does the filename mean anything: a scratch bulb in `typebulbs/` may be named `game-of-life-2` or
  // `synth.full` freely, and warning about those is noise that teaches agents to ignore warnings.
  // Where it IS an identity, a mismatch publishes at a URL nobody picked, and push refuses it
  // outright when the bulb doesn't exist yet. A *warning*, never a failure: bulbs published before
  // this check are grandfathered (push's update path writes the title, never the slug).
  const identity = conventionalIdentity(path.resolve(bulbPath))
  const expectedSlug = identity ? slugify(bulb.name) : ''
  if (identity && expectedSlug && expectedSlug !== identity.slug) {
    console.log(`naming\tfilename '${identity.slug}.bulb.md' doesn't match the title '${bulb.name}' — its slug derives to '${expectedSlug}'. Rename the file to '${expectedSlug}.bulb.md', or change name: to suit the filename.`)
    namingWarning = true
  }

  // Lint first — shared with typebulb.com via `typebulb/lint`, cheap, and catches the import-map /
  // Sucrase-unsupported patterns `tsc` can't see. `code.tsx` gets the browser ruleset, `server.ts`
  // the Node subset.
  // Pass `dependencies` to the client lint so the UNDECLARED_IMPORT rule fires (config-less / under-
  // declared bulbs fail) — `check` is the comprehensive gate, so it runs the full client ruleset.
  if (bulb.code) anyFailed = reportLint(lint(bulb.code, { target: 'client', dependencies: config.dependencies ?? {}, lineOffset: startOf('code.tsx') }), 'client') || anyFailed
  if (bulb.server) anyFailed = reportLint(lint(bulb.server, { target: 'server', lineOffset: startOf('server.ts') }), 'server') || anyFailed

  // Type-check needs a real, installed TypeScript — never `npx tsc`, which grabs the prank package
  // on a TS-less machine. Resolve after lint (independent, its output still stands) but before the
  // costly emit. Unavailable is its own exit code (2), distinct from issues-found (1), so an agent
  // never mistakes "couldn't type-check" for "your code is wrong".
  const tscJs = resolveTscJs([process.cwd(), path.dirname(bulbPath)])
  if (!tscJs) {
    const rel = path.relative(process.cwd(), bulbPath) || bulbPath
    console.error('check: TypeScript not found — install it once, then re-run:')
    console.error('  npm i -g typescript')
    console.error(`  typebulb check ${rel}`)
    process.exit(2)
  }

  const emits: Array<{ role: 'client' | 'server'; dir: string }> = []

  if (bulb.code) {
    const { dir } = await emitClientTypecheck({
      code: bulb.code,
      dependencies: config.dependencies ?? {},
      jsxImportSource: config.ts?.jsxImportSource,
      emitKey: bulbPath,
      local,
    })
    emits.push({ role: 'client', dir })
  }

  if (bulb.server) {
    const { dir } = await emitServerTypecheck({
      server: bulb.server,
      bulbDir: path.dirname(bulbPath),
      emitKey: bulbPath,
      local: local ? { name: local.name, typesAbs: local.typesAbs } : undefined,
      dependencies: config.dependencies,
    })
    emits.push({ role: 'server', dir })
  }

  for (const { role, dir } of emits) {
    const { stdout, exitCode } = await spawnTsc(tscJs, dir)
    for (const line of stdout.split(/\r?\n/)) {
      if (line.trim()) console.log(`${role}\t${toBulbPositions(line, bulbName, startOf)}`)
    }
    if (exitCode !== 0) anyFailed = true
  }

  if (anyFailed) process.exit(1)

  // Success is otherwise silent (tsc-style), which leaves an agent unable to tell "passed" from
  // "did nothing". Emit a one-line all-clear naming the blocks checked — on stderr, so stdout stays
  // empty for composition (`check && deploy`) and anything parsing it.
  const checked = [bulb.code && 'code.tsx', bulb.server && 'server.ts'].filter(Boolean).join(', ')
  console.error(namingWarning ? `✓ type-checks (${checked}) — see the naming warning above` : `✓ no issues (${checked})`)
}

/** Print lint issues role-prefixed (the same `role\tline` shape as the tsc output) and report whether
 *  any fired, so a blocking lint folds into the combined exit code. */
function reportLint(issues: LintIssue[], role: 'client' | 'server'): boolean {
  for (const issue of issues) {
    for (const line of issue.message.split('\n')) console.log(`${role}\t${line}`)
  }
  return issues.length > 0
}

/**
 * Rewrite `code.tsx(94,7)` / `server.ts(12,3)` in a tsc diagnostic to the bulb's own file and line.
 * Only those two names: a position inside a `node_modules` type file is real and stays as it is.
 * Pure rewrite, exported so the mapping is unit-testable without running tsc.
 */
export function toBulbPositions(line: string, bulbName: string, startOf: (blockFile: string) => number): string {
  return line.replace(/\b(code\.tsx|server\.ts)\((\d+),(\d+)\)/g, (_m, blockFile: string, l: string, col: string) =>
    `${bulbName}(${Number(l) + startOf(blockFile) - 1},${col})`)
}

/** Run a resolved `tsc.js` under the current Node in `cwd`, capturing combined stdout+stderr.
 *  Passes argv directly (no `shell: true`) — that avoids the DEP0190 warning and the Windows
 *  `.cmd` shim, and runs the same `tsc` whatever the platform. */
function spawnTsc(tscJs: string, cwd: string): Promise<{ stdout: string; exitCode: number }> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [tscJs, '--noEmit'], { cwd })
    let stdout = ''
    child.stdout?.on('data', d => { stdout += d.toString() })
    child.stderr?.on('data', d => { stdout += d.toString() })
    child.on('close', code => resolve({ stdout, exitCode: code ?? 1 }))
  })
}

const requireFrom = createRequire(import.meta.url)

/**
 * Resolve `lib/tsc.js` from an installed TypeScript: each search dir's `node_modules`
 * (and ancestors) first, then the global npm root. Returns undefined if none is installed.
 *
 * Deliberately never resolves to `npx tsc` — on a TypeScript-less machine npx fetches the
 * unrelated *prank* `tsc` package, whose non-diagnostic output an agent can't tell from a
 * real type error. Resolving an on-disk install instead means a missing TS is a clean
 * "not found" (caller exits 2), never a bogus compiler run.
 */
function resolveTscJs(searchDirs: string[]): string | undefined {
  const fromPaths = (paths: string[]): string | undefined => {
    try {
      // Resolve package.json (always reachable, unlike subpaths an `exports` map could gate),
      // then derive lib/tsc.js beside it.
      const pkg = requireFrom.resolve('typescript/package.json', { paths })
      const tscJs = path.join(path.dirname(pkg), 'lib', 'tsc.js')
      return existsSync(tscJs) ? tscJs : undefined
    } catch {
      return undefined
    }
  }

  const local = fromPaths(searchDirs)
  if (local) return local

  // Global installs sit outside Node's default resolution; ask npm where its root is.
  try {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim()
    return fromPaths([globalRoot])
  } catch {
    return undefined
  }
}
