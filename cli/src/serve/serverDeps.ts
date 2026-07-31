/**
 * npm-installs packages into a bulb's `<bulbDir>/.typebulb/node_modules/`.
 * Used by:
 *   - The runtime path (`typebulb <bulb>` → `importServerModule`) to install
 *     packages the bulb's server.ts actually imports.
 *   - The DTS emit path (`typebulb dts <bulb>` → server emit) to ensure
 *     `@types/node` is present before the emitted tsconfig references it.
 *
 * Both call sites want the same thing: "make sure these npm specs are installed
 * under this directory." Earlier versions had two near-identical implementations
 * that diverged in subtle ways (e.g. how versioned vs unversioned specs were
 * checked for existence).
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import { existsSync, readFileSync } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { builtinModules } from 'node:module'
import { satisfies } from 'semver'
import { PackageRef } from 'typebulb/resolver'

const execFileAsync = promisify(execFile)

/** Node's builtins. Membership is tested against a specifier's ROOT, so `fs/promises` matches `fs`. */
const NODE_BUILTINS = new Set(builtinModules)

/**
 * Ensure each spec is installed under `<bulbCacheDir>/node_modules/`.
 *
 * @param specs - npm install specs. May be bare (`"three"`) or versioned
 *                (`"@types/node@^22"`); the version suffix is used for install
 *                but stripped when checking if the package already exists.
 * @param bulbCacheDir - The bulb's `.typebulb/` directory.
 * @param declaredRanges - The bulb's `config.json` `dependencies`. A bare spec
 *                whose name appears here installs at that range, so a package the
 *                bulb uses on *both* sides (e.g. `typebulb`: browser embed via the
 *                import map + server breakout via `typebulb/servers`) resolves to
 *                the same published version on each — no cross-consumer skew. A spec
 *                that already carries a version is left untouched.
 */
/** Shape of an installable npm spec: optionally-scoped name, optional @range of shell-inert
 *  characters. Everything a normal `name@^1.2.3` / `@scope/name@1.x` needs — and nothing the
 *  shell can interpret (`&`, `|`, `;`, `<`, `>`, spaces, quotes…). Required because the npm
 *  invocation below runs `shell: true` (Windows npm.cmd resolution) with specs sourced from
 *  the bulb's own config.json / server.ts, i.e. untrusted-authored text (TB-Review R1). */
const SAFE_NPM_SPEC = /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+(@[a-zA-Z0-9.^~*x-]+)?$/i

export async function ensureBulbServerPackages(
  specs: string[],
  bulbCacheDir: string,
  declaredRanges?: Record<string, string>,
  opts?: { ignoreScripts?: boolean },
): Promise<void> {
  const resolved = specs.map(spec => applyDeclaredRange(spec, declaredRanges))
  const missing = resolved.filter(spec => !isInstalled(spec, bulbCacheDir))
  if (missing.length === 0) return

  const unsafe = missing.filter(spec => !SAFE_NPM_SPEC.test(spec))
  if (unsafe.length) {
    throw new Error(
      `Refusing to install npm spec(s) with unsupported characters: ${unsafe.join(', ')}\n` +
      `  Use a plain name with an exact / caret / tilde range (e.g. three@^0.160.0).`,
    )
  }

  await fs.mkdir(bulbCacheDir, { recursive: true })
  const pkgJsonPath = path.join(bulbCacheDir, 'package.json')
  if (!existsSync(pkgJsonPath)) {
    await fs.writeFile(pkgJsonPath, JSON.stringify({ name: 'typebulb-server', private: true }))
  }

  console.log(`  Installing: ${missing.join(', ')}`)
  const flags = ['--no-audit', '--no-fund', ...(opts?.ignoreScripts ? ['--ignore-scripts'] : [])]
  await execFileAsync('npm', ['install', ...flags, ...missing], { cwd: bulbCacheDir, shell: true })
}

/** A bare spec declared in the bulb's config.json installs at that range; a spec
 *  that already carries a version is left as-is. */
export function applyDeclaredRange(spec: string, declaredRanges?: Record<string, string>): string {
  if (!declaredRanges || PackageRef.parse(spec).version) return spec
  const range = declaredRanges[spec]
  return range ? `${spec}@${range}` : spec
}

/**
 * Already installed AND, for a versioned spec, at a version that satisfies the
 * range. A bare spec only needs the directory to exist (any version will do); a
 * versioned spec whose installed copy falls outside the range counts as missing,
 * so npm reinstalls and a stale package (e.g. an older `typebulb` lacking a newer
 * subpath export) gets upgraded instead of silently kept.
 */
export function isInstalled(spec: string, bulbCacheDir: string): boolean {
  const { name, version: range } = PackageRef.parse(spec)
  const pkgDir = path.join(bulbCacheDir, 'node_modules', name)
  if (!existsSync(pkgDir)) return false
  if (!range) return true
  try {
    const installed = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf-8')).version
    return satisfies(installed, range)
  } catch {
    return false
  }
}

/**
 * Extract bare package names from ESM import statements in server source.
 * Used by both run mode (to npm-install before importing) and check mode
 * (to install before tsc resolves modules). Node builtins are skipped in BOTH spellings —
 * `node:fs` by the scheme test below, bare `fs` by the builtin set (TB-CLI.md): `fs` and `path`
 * are squatted npm packages, so letting the bare form through installed stubs and printed
 * `Installing: fs, path` above the error the caller was actually reading. Dropping them can't
 * lose a real dependency — Node resolves a builtin ahead of any same-named package.
 */
export function extractServerImports(code: string): string[] {
  const packages = new Set<string>()
  const regex = /\bimport\s+(?:[\s\S]*?\s+from\s+)?['"]([^./][^'"]*)['"]/g
  let match
  while ((match = regex.exec(code))) {
    const specifier = match[1]!
    // Skip anything carrying a URL scheme — `node:` builtins, and `file://` / `http(s)://`
    // specifiers (e.g. a --replace override rewritten to a local file:// path). An npm
    // package name never contains ':', so this can't drop a real dependency.
    if (specifier.includes(':')) continue
    const root = PackageRef.rootOf(specifier)
    if (!NODE_BUILTINS.has(root)) packages.add(root)
  }
  return [...packages]
}
