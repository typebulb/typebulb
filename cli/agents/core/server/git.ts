import { execFile } from 'child_process'
import { promisify } from 'util'
import { readFile } from 'fs/promises'
import { resolve, sep } from 'path'
import { projectCwd, errorMessage } from './context.js'

// The mirror's git-diff RPCs (TB-Agent-Mirror.md): the changed-file list + one file's full-context
// diff, backing the status bar's ± pill. Read-only `git` invocations (args array, no shell) against
// the project's repo — no writes, no inference, squarely inside Invariant 1.

const execFileAsync = promisify(execFile)

// Cap what ships to the browser — -U999999 on a big file is unbounded.
const MAX_DIFF_CHARS = 2_000_000

// Exported for the engine's other read-only git spawns (composerFiles' ls-files).
export async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 })
  return stdout
}

// Repo toplevel — status paths are relative to IT, not the cwd (a repo can sit above the project
// root), so every git call runs from here. Cached once found; a miss re-probes (git init mid-session).
// Exported for the engine's wrong-cwd diagnosis (mirror.ts sessionsElsewhere), which bounds its
// ancestor walk to the repo.
let cachedRoot: string | undefined
export async function repoRoot(): Promise<string | undefined> {
  if (cachedRoot) return cachedRoot
  try { cachedRoot = (await git(['rev-parse', '--show-toplevel'], projectCwd)).trim() } catch {}
  return cachedRoot
}

// One letter per row, VS Code's vocabulary: the worktree status when present, else the staged one;
// '?' (untracked) shown as U.
function statusChar(x: string, y: string): string {
  const c = y === ' ' ? x : y
  return c === '?' ? 'U' : c
}

export async function gitChangedFiles() {
  const root = await repoRoot()
  if (!root) return { repo: false, root: '', files: [] }
  try {
    const out = await git(['status', '--porcelain', '-z'], root)
    const files: { path: string; status: string; add?: number; del?: number; binary?: boolean }[] = []
    const parts = out.split('\0')
    for (let i = 0; i < parts.length; i++) {
      const e = parts[i]
      if (e.length < 4) continue
      if (e[0] === 'R' || e[0] === 'C') i++          // rename/copy: the NEXT token is the original path
      files.push({ path: e.slice(3), status: statusChar(e[0], e[1]) })
    }
    // ± counts vs HEAD where numstat has them. `-z` is load-bearing: the text form compacts a rename to
    // `dir/{old => new}.ts`, which never equals the status path, so every renamed row came back
    // uncounted — and the client used to read "uncounted" as "new". A row can still legitimately have
    // no counts (binary, or content identical to HEAD once git normalizes line endings); absent counts
    // mean *unknown*, and only the status letter says new.
    try {
      const stat = await git(['diff', '--numstat', '-z', 'HEAD'], root)
      const counts = new Map<string, { add: number; del: number; binary: boolean }>()
      const toks = stat.split('\0')
      for (let i = 0; i < toks.length; i++) {
        const m = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(toks[i])
        if (!m) continue
        // Under `-z` a rename leaves the path field empty and follows with pre- then post-image paths;
        // key on the post-image, which is the path `git status` reports. A binary file reports `-`/`-`.
        const path = m[3] || toks[(i += 2)]
        if (path) counts.set(path, { add: +m[1] || 0, del: +m[2] || 0, binary: m[1] === '-' })
      }
      for (const f of files) {
        const c = counts.get(f.path)
        if (!c) continue
        if (c.binary) f.binary = true
        else { f.add = c.add; f.del = c.del }
      }
    } catch {}                                        // no HEAD yet (fresh repo) — rows stay uncounted
    files.sort((a, b) => a.path.localeCompare(b.path))
    return { repo: true, root, files }
  } catch (err) {
    return { repo: false, root: '', files: [], error: errorMessage(err) }
  }
}

// The one success shape gitDiff ships (cap applied uniformly).
const diffResult = (text: string, untracked: boolean) =>
  ({ ok: true, text: text.slice(0, MAX_DIFF_CHARS), untracked, truncated: text.length > MAX_DIFF_CHARS })

export async function gitDiff(path: string) {
  const root = await repoRoot()
  if (!root) return { ok: false, error: 'not a git repository' }
  try {
    // Untracked first (`git diff HEAD` shows nothing for it): ship the file itself and let the client
    // render it all-added — synthesized rather than `git diff --no-index /dev/null`, whose null-device
    // spelling isn't portable to Windows. The status probe also confines the read: only a path git
    // itself reports as untracked gets read, and only inside the repo (the RPC arg is browser-supplied).
    const st = await git(['status', '--porcelain', '-z', '--', path], root)
    if (st.startsWith('??')) {
      const abs = resolve(root, path)
      if (!abs.startsWith(resolve(root) + sep)) return { ok: false, error: 'outside repository' }
      const buf = await readFile(abs)
      if (buf.includes(0)) return diffResult('Binary file (not shown)', false)
      return diffResult(buf.toString('utf8'), true)
    }
    // Full context (-U999999): the whole file inline with changes marked — the view never hides
    // unchanged lines. Against HEAD so staged + unstaged read as one diff; a fresh repo (no HEAD yet)
    // falls back to the index diff.
    let text: string
    try { text = await git(['diff', '--no-color', '--unified=999999', 'HEAD', '--', path], root) }
    catch { text = await git(['diff', '--no-color', '--unified=999999', '--', path], root) }
    return diffResult(text, false)
  } catch (err) { return { ok: false, error: errorMessage(err) } }
}
