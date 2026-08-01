import { lint, type LintIssue } from 'typebulb/lint'

/**
 * Turn lint results into CLI-facing surfacing — the one place that owns "what a lint
 * failure looks like" so the run path and the inline bulb renderer can't drift (and the
 * `TYPE (line N)` shape the inline bulb lint tests pin stays single-sourced).
 */

/** One line per issue: rule, line, and the first line of its AI-facing message. */
export function summarizeLint(issues: LintIssue[]): string {
  return issues.map(i => `${i.type} (line ${i.lineNumber}): ${i.message.split('\n')[0]}`).join('\n')
}

/**
 * Enforce the CLI's authored-config contract for a local run: every bare client import
 * must be declared in config.json `dependencies`. The resolver is import-driven and would
 * otherwise CDN-resolve undeclared imports against non-reproducible "latest" (the GLM
 * incident — a model omitted config.json and the bulb ran/broke out anyway). Only the
 * UNDECLARED_IMPORT rule applies here: the rest of the client ruleset is calibrated for the
 * sandboxed inline bulb (e.g. NAVIGATION), and those patterns are legitimately fine on a local
 * top-level page — `check` and the inline bulb renderer run the full ruleset, the local run does not.
 * Throws to abort the run: surfaced by main().catch on first compile, kept-old-run by the
 * hot-reload try/catch on save (runWeb).
 */
export function assertDeclaredImports(code: string, dependencies: Record<string, string>): void {
  const undeclared = lint(code, { target: 'client', dependencies }).filter(i => i.type === 'UNDECLARED_IMPORT')
  if (undeclared.length) throw new Error(`Lint failed:\n${summarizeLint(undeclared)}`)
}
