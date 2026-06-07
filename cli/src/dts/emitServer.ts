/**
 * Emits a self-contained typecheck-server/ directory for a bulb's server.ts.
 *
 * Self-sufficient: parses the bulb's server source for npm imports and installs
 * them into the bulb's `.typebulb/node_modules` before linking it in. Otherwise
 * `typebulb check` on a never-run bulb would fail with TS2307 for every server
 * import — exactly the AI-author / CI workflow `check` exists to serve.
 *
 *   - npm-install bare imports (plus `@types/node`) into `<bulb-dir>/.typebulb`
 *   - link `<emit-dir>/node_modules` → `<bulb-dir>/.typebulb/node_modules`
 *   - emit a tsconfig with types:[node], lib:[es2023], no DOM, node resolution
 *   - emit a tb.d.ts using the Node-flavored serverTbTypings
 *
 * Layout:
 *   <emit-dir>/typecheck-server/
 *     tsconfig.json
 *     server.ts
 *     tb.d.ts
 *     node_modules -> <bulb-dir>/.typebulb/node_modules  (junction/symlink)
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import { existsSync } from 'fs'
import { serverTbTypings } from 'typebulb/dts'
import { ensureCacheRoot, resolveEmitDir } from '../deps/cache/cacheRoot.js'
import { ensureBulbServerPackages, extractServerImports } from '../serve/serverDeps.js'

export interface ServerEmitOptions {
  /** Bulb's server.ts source */
  server: string
  /** Directory of the bulb file (for resolving .typebulb/node_modules) */
  bulbDir: string
  /** Stable key for the emit location (typically bulb's absolute path) */
  emitKey: string
  /** Active `--replace` override, if any. When the server imports the override package,
   *  typecheck must resolve it to the LOCAL .d.ts (the published version may lack the
   *  subpath/types entirely) — the server-check half of `--replace`, mirroring how the
   *  run path rewrites the import. Without it, `check` regresses with TS2307. */
  local?: { name: string; typesAbs?: string }
  /** The bulb's `config.json` `dependencies`. A server import also declared here installs
   *  at that range, matching the version the run path and browser import map resolve to. */
  dependencies?: Record<string, string>
}

export interface ServerEmitResult {
  dir: string
}

/** Pinned default for `@types/node`. Conservative — latest LTS major as of writing. */
const TYPES_NODE_VERSION = '^22'

export async function emitServerTypecheck(opts: ServerEmitOptions): Promise<ServerEmitResult> {
  const targetDir = resolveEmitDir(opts.emitKey, 'typecheck-server')

  await ensureCacheRoot()
  await fs.rm(targetDir, { recursive: true, force: true })
  await fs.mkdir(targetDir, { recursive: true })

  // Install @types/node plus every npm package the bulb's server.ts imports,
  // mirroring run-mode (src/index.ts → importServerModule). Without this,
  // `typebulb check` on a never-run bulb fails with TS2307 for each import —
  // the symlink below would point at a node_modules that was never populated.
  const bulbCacheDir = path.join(opts.bulbDir, '.typebulb')
  // Drop the override from the install set — it's resolved via tsconfig `paths` to the
  // local .d.ts below, not npm (the published version may not even carry the subpath).
  const serverPackages = extractServerImports(opts.server).filter(p => p !== opts.local?.name)
  await ensureBulbServerPackages(
    [`@types/node@${TYPES_NODE_VERSION}`, ...serverPackages],
    bulbCacheDir,
    opts.dependencies,
  )

  // Link the bulb's server node_modules into the emit dir so tsc's default
  // node resolution finds packages without any paths shims.
  const sourceNm = path.join(bulbCacheDir, 'node_modules')
  const linkPath = path.join(targetDir, 'node_modules')
  await linkDir(sourceNm, linkPath)

  await fs.writeFile(path.join(targetDir, 'server.ts'), opts.server, 'utf8')
  await fs.writeFile(path.join(targetDir, 'tb.d.ts'), serverTbTypings, 'utf8')
  await fs.writeFile(
    path.join(targetDir, 'tsconfig.json'),
    JSON.stringify(buildServerTsconfig(opts.local), null, 2) + '\n',
    'utf8',
  )

  return { dir: targetDir }
}

function buildServerTsconfig(local?: { name: string; typesAbs?: string }) {
  const compilerOptions: Record<string, unknown> = {
    target: 'es2023',
    module: 'esnext',
    // 'bundler' (not 'node') so tsc honours a package's `exports` map — a server
    // import like `typebulb/servers` is an `exports` subpath, unresolvable under
    // classic node resolution. Without --replace's `paths` shim (the published path)
    // it would otherwise TS2307, cascading the import to `any`.
    moduleResolution: 'bundler',
    lib: ['ES2023'],
    types: ['node'],
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    forceConsistentCasingInFileNames: true,
  }

  // Map the override package (bare name + any subpath) to its local .d.ts so tsc
  // resolves `typebulb` / `typebulb/servers` against the local build, not node_modules.
  // The subpath map assumes subpath dts files sit beside the `.` types in the same dir
  // and are named for the subpath (e.g. ./servers → servers.d.ts) — true of the typebulb
  // build; a dev-only typecheck affordance, so the heuristic is acceptable.
  if (local?.typesAbs) {
    const fwd = (p: string) => p.replace(/\\/g, '/')
    const distDir = fwd(path.dirname(local.typesAbs))
    const bareTypes = fwd(local.typesAbs).replace(/\.d\.ts$/, '')
    compilerOptions.baseUrl = '.'
    compilerOptions.paths = {
      [local.name]: [bareTypes],
      [`${local.name}/*`]: [`${distDir}/*`],
    }
  }

  return { compilerOptions, include: ['server.ts', 'tb.d.ts'] }
}

/** Cross-platform directory link. Uses 'junction' on Windows (no admin needed). */
async function linkDir(source: string, link: string): Promise<void> {
  if (!existsSync(source)) {
    // No node_modules at all (rare — would mean no server deps AND ensureTypesNode failed).
    // Create an empty dir so tsc has somewhere to look.
    await fs.mkdir(link, { recursive: true })
    return
  }
  await fs.rm(link, { recursive: true, force: true })
  const type = process.platform === 'win32' ? 'junction' : 'dir'
  await fs.symlink(source, link, type)
}

