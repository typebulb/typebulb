import * as path from 'path'
import { spawn } from 'child_process'
import { readBulb } from '../pipeline.js'
import { emitClientTypecheck } from '../dts/emit.js'
import { emitServerTypecheck } from '../dts/emitServer.js'
import { lint, type LintIssue } from 'typebulb/lint'
import { type ResolvedLocalOverride } from '../localOverride.js'

/**
 * Type-check a bulb in one step. Emits the typecheck directory then spawns
 * `npx tsc --noEmit` inside it. Returns tsc's exit code.
 *
 * For bulbs with both code.tsx and server.ts, runs both and combines exit
 * codes (any non-zero → exit 1). Each diagnostic line is prefixed with the
 * role (`client` or `server`) so multi-role output stays parseable.
 */
export async function runCheck(bulbPath: string, local?: ResolvedLocalOverride): Promise<void> {
  const { bulb, config } = await readBulb(bulbPath)

  if (!bulb.code && !bulb.server) {
    console.error('Bulb has neither **code.tsx** nor **server.ts**; nothing to check.')
    process.exit(1)
  }

  let anyFailed = false

  // Lint first — shared with typebulb.com via `typebulb/lint`, cheap, and catches the import-map /
  // Sucrase-unsupported patterns `tsc` can't see. `code.tsx` gets the browser ruleset, `server.ts`
  // the Node subset.
  if (bulb.code) anyFailed = reportLint(lint(bulb.code, { target: 'client' }), 'client') || anyFailed
  if (bulb.server) anyFailed = reportLint(lint(bulb.server, { target: 'server' }), 'server') || anyFailed

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
    const { stdout, exitCode } = await spawnTsc(dir)
    for (const line of stdout.split(/\r?\n/)) {
      if (line.trim()) console.log(`${role}\t${line}`)
    }
    if (exitCode !== 0) anyFailed = true
  }

  if (anyFailed) process.exit(1)
}

/** Print lint issues role-prefixed (the same `role\tline` shape as the tsc output) and report whether
 *  any fired, so a blocking lint folds into the combined exit code. */
function reportLint(issues: LintIssue[], role: 'client' | 'server'): boolean {
  for (const issue of issues) {
    for (const line of issue.message.split('\n')) console.log(`${role}\t${line}`)
  }
  return issues.length > 0
}

/** Spawn `npx tsc --noEmit` in `cwd`, capturing combined stdout+stderr. */
function spawnTsc(cwd: string): Promise<{ stdout: string; exitCode: number }> {
  return new Promise(resolve => {
    const child = spawn('npx', ['tsc', '--noEmit'], { cwd, shell: true })
    let stdout = ''
    child.stdout?.on('data', d => { stdout += d.toString() })
    child.stderr?.on('data', d => { stdout += d.toString() })
    child.on('close', code => resolve({ stdout, exitCode: code ?? 1 }))
  })
}
