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
import { satisfies } from 'semver'

const execFileAsync = promisify(execFile)

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
export async function ensureBulbServerPackages(
  specs: string[],
  bulbCacheDir: string,
  declaredRanges?: Record<string, string>,
): Promise<void> {
  const resolved = specs.map(spec => applyDeclaredRange(spec, declaredRanges))
  const missing = resolved.filter(spec => !isInstalled(spec, bulbCacheDir))
  if (missing.length === 0) return

  await fs.mkdir(bulbCacheDir, { recursive: true })
  const pkgJsonPath = path.join(bulbCacheDir, 'package.json')
  if (!existsSync(pkgJsonPath)) {
    await fs.writeFile(pkgJsonPath, JSON.stringify({ name: 'typebulb-server', private: true }))
  }

  console.log(`  Installing: ${missing.join(', ')}`)
  await execFileAsync('npm', ['install', '--no-audit', '--no-fund', ...missing], { cwd: bulbCacheDir, shell: true })
}

/** A bare spec declared in the bulb's config.json installs at that range; a spec
 *  that already carries a version is left as-is. */
export function applyDeclaredRange(spec: string, declaredRanges?: Record<string, string>): string {
  if (!declaredRanges || specVersion(spec)) return spec
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
  const pkgDir = path.join(bulbCacheDir, 'node_modules', bareName(spec))
  if (!existsSync(pkgDir)) return false
  const range = specVersion(spec)
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
 * (to install before tsc resolves modules). Built-ins (`node:fs`, `node:crypto`)
 * are skipped; bare node built-ins (`fs`, `crypto`) fall through but ensureBulbServerPackages
 * is idempotent and Node's resolver prefers the built-in.
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
    const pkgName = specifier.startsWith('@')
      ? specifier.split('/').slice(0, 2).join('/')
      : specifier.split('/')[0]!
    packages.add(pkgName)
  }
  return [...packages]
}

/** "@types/node@^22" → "@types/node"; "three" → "three"; "@scope/pkg" → "@scope/pkg". */
function bareName(spec: string): string {
  if (spec.startsWith('@')) {
    const slash = spec.indexOf('/')
    if (slash < 0) return spec
    const at = spec.indexOf('@', slash + 1)
    return at < 0 ? spec : spec.slice(0, at)
  }
  const at = spec.indexOf('@')
  return at < 0 ? spec : spec.slice(0, at)
}

/** The version/range suffix of a spec, or '' if bare. "@types/node@^22" → "^22". */
function specVersion(spec: string): string {
  const name = bareName(spec)
  return spec.length > name.length ? spec.slice(name.length + 1) : ''
}
