import * as fs from 'fs/promises'
import * as path from 'path'
import { pathToFileURL } from 'url'
import { parseBulb, toLocalBulb, parseDataChunks, parseConfig, validateBulbStructure, type LocalBulb } from './bulb/bulbParser.js'
import { transpile } from 'typebulb/transpile'
import { assertDeclaredImports } from './bulb/lintGate.js'
import { packageService } from './deps/resolver.js'
import { renderHtml } from './bulb/template.js'
import { ensureBulbServerPackages, extractServerImports } from './serve/serverDeps.js'
import { rewriteServerOverrideImports, type ResolvedLocalOverride } from './localOverride.js'

export async function findBulbFile(dir: string): Promise<string | null> {
  const files = await fs.readdir(dir)
  const bulbFile = files.find(f => f.endsWith('.bulb.md'))
  return bulbFile ? path.join(dir, bulbFile) : null
}

/**
 * Read a .bulb.md file from disk and pre-parse the bits the rest of the CLI
 * always needs together: the structured `LocalBulb` (subscripts plus the
 * CLI-only `server.ts`) and the parsed `config.json` block. Throws on malformed
 * input — callers decide whether to exit or propagate.
 */
export async function readBulb(bulbPath: string): Promise<{ bulb: LocalBulb; config: ReturnType<typeof parseConfig>; warnings: string[] }> {
  const content = await fs.readFile(bulbPath, 'utf-8')
  const parsed = parseBulb(content)
  if (!parsed) throw new Error('Invalid .bulb.md file format')
  const bulb = toLocalBulb(parsed)
  return { bulb, config: parseConfig(bulb.config), warnings: validateBulbStructure(content) }
}

/** Compile server source, write to .typebulb/server.mjs, and dynamic-import it */
export async function importServerModule(serverSource: string, basePath: string, local?: ResolvedLocalOverride, dependencies?: Record<string, string>): Promise<Record<string, Function>> {
  const compiled = transpile(serverSource, { serverOnly: true })
  if (compiled.error) {
    throw new Error(`Server compilation error: ${compiled.error}`)
  }

  // --replace also covers server.ts (the same flag, resolved per consumer: the client
  // import map takes the package's browser entry, this takes its node entry). Rewrite
  // the override's bare imports to file:// URLs of the local build BEFORE extracting
  // imports — Node resolves bare names by filesystem, not the client map, so this both
  // points server code at the local copy and drops it from the npm-install set below.
  let code = compiled.code
  if (local) code = await rewriteServerOverrideImports(code, local)

  const cacheDir = path.join(basePath, '.typebulb')
  await fs.mkdir(cacheDir, { recursive: true })

  // Auto-install any npm packages the server code imports
  const packages = extractServerImports(code)
  if (packages.length > 0) await ensureBulbServerPackages(packages, cacheDir, dependencies)

  const serverPath = path.join(cacheDir, 'server.mjs')
  await fs.writeFile(serverPath, code, 'utf-8')

  // Cache-bust with query param so re-imports pick up changes
  const fileUrl = `${pathToFileURL(serverPath).href}?t=${Date.now()}`
  const mod = await import(fileUrl)
  return mod
}

export async function loadAndCompile(bulbPath: string, watch: boolean, trusted: boolean, local: ResolvedLocalOverride | undefined, serverCacheDir: string) {
  const { bulb, config } = await readBulb(bulbPath)
  const dataChunks = parseDataChunks(bulb.data)

  // Enforce the CLI's authored-config contract before compiling — every bare client import declared in
  // config.json `dependencies`, else the import-driven resolver silently CDN-resolves "latest" and the
  // bulb runs config-less (the GLM incident). See assertDeclaredImports for why only that one rule fires.
  assertDeclaredImports(bulb.code, config.dependencies ?? {})

  // Compile TypeScript
  const compileResult = transpile(bulb.code, {
    jsxImportSource: config.ts?.jsxImportSource,
  })

  if (compileResult.error) {
    console.error('Compilation error:', compileResult.error)
  }

  // Build import map using full resolver (peer deps, singletons, shared deps).
  // When overriding a package, skip resolving it on the CDN: its declared
  // version may be unpublished (a range like ^0.3.0 then throws), and even when
  // it does resolve we'd only discard the result for the shadow below. The rest
  // of the graph is unaffected — the override is self-contained (Invariant 6).
  const { importMap } = await packageService.buildImportMap(
    compileResult.code,
    config.dependencies ?? {},
    local ? new Set([local.name]) : undefined,
  )

  // Shadow exactly one import-map entry with the local override (Invariant 5).
  // routeImportsThroughProxy only rewrites https:// values, so this local URL
  // passes through to the browser untouched and is served by the /local/* route.
  if (local) {
    importMap.imports[local.name] = local.entryUrl
  }

  // Serve the bulb directly as a top-level page on localhost:<port> — a real origin, so
  // storage / SharedArrayBuffer / Workers / clipboard all work. (Untrusted launches used to
  // mount the bulb in an opaque-origin `allow-scripts` iframe; that origin has none of those
  // — see TB-Security.md.) Default-deny on the privileged tier does NOT need the
  // frame: the server-side trustGate 403s /__fs, /__ai, /__api when untrusted — the protection
  // that actually matters on a single-user loopback box, where each bulb is already
  // origin-isolated by its own port. The shim turns that 403 into a `--trust` message (the
  // hint rides in the response body), so a denied capability stays actionable without a frame.
  const html = renderHtml({
    name: bulb.name,
    code: compileResult.code,
    css: bulb.css,
    html: bulb.html,
    data: dataChunks,
    insight: bulb.insight,
    importMap,
    watch,
  })

  // Env is already loaded into process.env by the caller (index.ts runWeb/runConsole) from the
  // cwd cascade, before this import — see TB-Env.md. The caller also owns where the
  // `.typebulb` cache lives via serverCacheDir (the bulb's parent dir).
  //
  // server.ts top-level code runs in Node the moment it's imported — that's the
  // /__api capability. An untrusted launch must not execute it, so skip the import
  // entirely (the trustGate 403s /__api regardless, but importing the module is itself
  // the privileged act — never run it without trust).
  let serverExports: Record<string, Function> | null = null
  if (bulb.server && trusted) {
    serverExports = await importServerModule(bulb.server, serverCacheDir, local, config.dependencies)
  }

  return { html, bulb, serverExports }
}
