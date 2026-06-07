import { build } from 'esbuild'
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'fs'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

// Bundled CJS deps (e.g. yaml) call require('process') at module top; ESM has no global
// require, so esbuild's shim throws "Dynamic require of X". Give node bundles a real one.
const nodeRequireBanner = "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);"

await build({
  entryPoints: ['cli/src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: 'dist/index.js',
  minify: true,
  banner: { js: '#!/usr/bin/env node\n' + nodeRequireBanner },
  // Inject the package.json version at build time so `typebulb --version`
  // always matches the published package — no more drifted constants in src/.
  define: {
    __TYPEBULB_VERSION__: JSON.stringify(pkg.version),
  },
  external: [
    'hono', '@hono/node-server',
    'sucrase',
    'open', 'chokidar',
    'semver', 'es-module-lexer',
    'fflate', 'lru-cache', 'p-limit', 'resolve.exports',
    // The agent viewer dynamically imports esbuild to rebuild its client bundle on a source
    // change (dev hot reload, repo only — see agentViewer/serve.ts). External so it resolves from
    // node_modules at runtime rather than being bundled (esbuild ships a native binary).
    'esbuild',
  ],
})

// Browser entry (the package's `exports["."]`): renderBulb, for embedding a bulb
// inside a bulb. Fully bundled with NO externals so the shipped file is self-
// contained — what esm.sh relays untouched and what `--replace` requires.
await build({
  entryPoints: ['cli/src/render.ts'],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  outfile: 'dist/render.js',
  minify: true,
})

// Node entry (the package's `exports["./servers"]`): the breakout server-management
// capability (launch/list/stop). platform:'node' so it can spawn processes and touch
// the registry — kept strictly separate from the browser entry above (Embed-spec
// Invariant 6). Only node builtins, so nothing to externalize.
await build({
  entryPoints: ['cli/src/servers.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: 'dist/servers.js',
  minify: true,
  banner: { js: nodeRequireBanner },
})

// Agent viewer client (Specs/Typebulb-CLI-Agent-Viewer.md): the browser UI, bundled self-contained
// (NO externals — katex/markdown-it/beautiful-mermaid/dompurify/highlight.js and the internal
// `../../../src/render.ts` it imports are all inlined). Served as a static asset by runAgentViewer.
const clientBuildOpts = {
  entryPoints: ['cli/agents/claude/client/index.ts'],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  outfile: 'dist/agents/claude/client.js',
  minify: true,
}

// The viewer's two non-bundled assets — the inlined stylesheet and the mount stub — copied next to
// the client bundle so runAgentViewer reads them from `dist/` at runtime and they ship via
// `files: ["dist"]`. The server half (`agents/claude/server.ts`) needs no copy: it's bundled into
// `dist/index.js` transitively (runAgentViewer dynamically imports it).
function copyViewerAssets() {
  mkdirSync(new URL('./dist/agents/claude/', import.meta.url), { recursive: true })
  for (const asset of ['styles.css', 'index.html']) {
    copyFileSync(
      new URL(`./cli/agents/claude/${asset}`, import.meta.url),
      new URL(`./dist/agents/claude/${asset}`, import.meta.url),
    )
  }
}

await build(clientBuildOpts)
copyViewerAssets()

// Hand-authored, dependency-free .d.ts so the public surface is a stable, tiny
// contract (a generated rollup would drag in internal types). Written here so it
// survives prepublishOnly's `rimraf dist`, which runs before this script.
writeFileSync(new URL('./dist/render.d.ts', import.meta.url), `export interface RenderBulbResult {
  /** Complete standalone HTML document, ready for an iframe srcdoc. */
  html?: string
  /** Set instead of \`html\` when the source couldn't be rendered. */
  error?: string
}

/** Compile a bulb source string to a standalone HTML document (client-only).
 *  Pass \`theme\` to force the embed's light/dark mode (e.g. match the host). */
export declare function renderBulb(source: string, opts?: { theme?: 'light' | 'dark' }): Promise<RenderBulbResult>

export interface BulbFrameOptions {
  /** Force light/dark. Omit to inherit the host's \`data-theme\` automatically. */
  theme?: 'light' | 'dark'
  /** Height shown before the embed reports its content height, and the height a
   *  full-bleed (\`height:100%\`) bulb settles at. Flow content settles above OR below
   *  this to its true height. Default 320. */
  initialHeight?: number
  /** Ceiling for auto-height; bounds an absurd height from a buggy/hostile embed. Default 100000. */
  maxHeight?: number
  /** Called with a message when the embed throws at runtime (post-mount). */
  onError?: (message: string) => void
  /** Abort to remove the frame's host-side \`message\` listener (host owns lifecycle). */
  signal?: AbortSignal
}

/** Render a bulb and return a ready-to-mount, sandboxed iframe: owns the
 *  \`allow-scripts\` sandbox policy and the host<->embed protocol (auto-height +
 *  runtime-error forwarding). Rejects if the bulb can't compile. */
export declare function createBulbFrame(source: string, opts?: BulbFrameOptions): Promise<HTMLIFrameElement>

/** The bulb's \`name:\` from its leading frontmatter, or undefined if absent. */
export declare function bulbName(source: string): string | undefined

/** A filesystem-safe slug from the bulb's name; 'bulb' when unnamed. */
export declare function slugifyBulbName(source: string): string

/** The source with its leading \`---\` frontmatter block stripped. */
export declare function stripFrontmatter(source: string): string
`)

// Hand-authored .d.ts for the node `./servers` entry, same rationale as render.d.ts.
writeFileSync(new URL('./dist/servers.d.ts', import.meta.url), `export interface BulbServer {
  /** OS process id of the dev server. */
  pid: number
  /** Bound loopback port. */
  port: number
  /** http://localhost:<port>. */
  url: string
  /** Absolute path to the .bulb.md being served. */
  file: string
  /** The cwd the server was launched in (the project it belongs to). */
  cwd?: string
  /** Epoch ms the server began listening. */
  startedAt: number
  /** Launched with --trust (filesystem / AI / server.ts enabled)? */
  trust?: boolean
  /** Human label of a capability the proactive scan predicts this untrusted bulb will need
   *  (set at register time; probabilistic, not enforcement). */
  predicted?: string
  /** Human label of a privileged capability this untrusted server denied (set by the gate). */
  denied?: string
}

/** Launch (or re-attach to) a standalone \`typebulb\` dev server for \`file\`. Idempotent
 *  per file: a live server already serving it is returned, not re-spawned. Always silent
 *  (no console window); detached so it outlives the caller. \`trust\` passes --trust. */
export declare function launchBulbServer(file: string, opts?: { cwd?: string; open?: boolean; trust?: boolean }): Promise<BulbServer>

/** Every live dev server, oldest first. Dead entries are pruned on read. Pass \`cwd\` to scope the
 *  list to that project's bulbs (the machine-global default is for explicit pid/file targeting). */
export declare function listBulbServers(cwd?: string): Promise<BulbServer[]>

/** Stop a server by pid (SIGTERM + deregister). Idempotent. */
export declare function stopBulbServer(pid: number): Promise<void>

/** New console bytes of a server (its \`<pid>.log\`) since \`offset\`; returns the text and
 *  the new offset. A trim past the cap resyncs from 0. Absent file ⇒ empty. */
export declare function readServerLog(pid: number, offset?: number): { text: string; offset: number }

/** Absolute path of a server's console log, sibling of its registry entry. */
export declare function serverLogPath(pid: number): string

export interface BulbFileInfo {
  /** Absolute path to the .bulb.md. */
  path: string
  /** The bulb's \`name:\` frontmatter title, or the filename stem when unnamed. */
  name: string
  /** File mtime (epoch ms); 0 if it vanished mid-walk. */
  mtime: number
}

/** Every \`*.bulb.md\` under \`cwd\` (dot-dirs and node_modules skipped, depth-bounded),
 *  each with its frontmatter name (or filename stem) and mtime. */
export declare function listBulbFiles(cwd: string): BulbFileInfo[]

/** Scan a \`.bulb.md\` and return the privileged capability it probably needs (or undefined),
 *  so a host can offer --trust before launching. Probabilistic hint, never enforcement. */
export declare function predictBulbTrust(file: string): Promise<string | undefined>

/** The bulb's \`name:\` from its leading frontmatter, or undefined if absent. */
export declare function bulbName(source: string): string | undefined

/** A filesystem-safe slug from the bulb's name; 'bulb' when unnamed. */
export declare function slugifyBulbName(source: string): string

/** The source with its leading \`---\` frontmatter block stripped. */
export declare function stripFrontmatter(source: string): string

/** Is this bulb remembered as Trusted in the CLI's per-machine trust store? */
export declare function isBulbTrusted(file: string): boolean

/** Set or clear a bulb's remembered trust (written only by user/agent action, never bulb code). */
export declare function setBulbTrusted(file: string, trust: boolean): void

/** Every remembered-trusted bulb path (absolute, normalized). */
export declare function listTrustedBulbs(): string[]

/** Open \`filePath\` (optionally at \`line\`) in the user's editor, detached. Defaults to VS Code
 *  (\`code\`); override with \`TYPEBULB_EDITOR\`. Fire-and-forget. */
export declare function openInEditor(filePath: string, line?: number): void
`)

// ── Core-subpath firewall (TB-Single-Package.md req 3, TB-Lint.md) ───────────────────────────────
// The core areas ship as their own tsc-emitted subpath entries, all inside the one `typebulb` package,
// and typebulb.com imports them on its published-bulb hot path. Nothing structurally stops one from
// importing code it shouldn't, which would silently bloat that hot path — the catastrophe being a
// "hello world" published bulb dragging in the three ENORMOUS things it must never touch: the CLI /
// agent viewer (`cli/`), the full TypeScript compiler (`typescript`), and Monaco (`monaco-editor`).
// Sucrase IS condoned (typebulb/transpile uses it). Bundle each entry (no externals) purely to read
// its import graph; metafile-only (write:false) — no artifact, no new dev dep.
const CORE_ENTRIES = {
  ai: 'ai/src/index.ts',
  format: 'format/src/index.ts',
  resolver: 'resolver/src/index.ts',
  dts: 'dts/src/index.ts',
  lint: 'lint/src/index.ts',
  transpile: 'transpile/src/index.ts',
}
// Packages a core area (hence the published hot path) must never pull. The first two are the enormous
// ones the firewall exists for; the rest are CLI / agent-viewer only — pocket change by comparison, but
// still out of place in a core area. Sucrase is intentionally NOT here (it's condoned).
const FORBIDDEN_DEPS = [
  'typescript', 'monaco-editor',
  'hono', '@hono/node-server', 'open', 'chokidar',
  'beautiful-mermaid', 'katex', 'markdown-it', 'dompurify', 'highlight.js', 'domeleon',
]
function firewallBreach(input) {
  const p = input.replace(/\\/g, '/')
  if (/(^|\/)cli\//.test(p)) return 'cli/ source'
  for (const dep of FORBIDDEN_DEPS) if (p.includes(`node_modules/${dep}/`)) return dep
  return null
}
for (const [name, entry] of Object.entries(CORE_ENTRIES)) {
  const { metafile } = await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    write: false,
    metafile: true,
    logLevel: 'silent',
  })
  const breaches = Object.keys(metafile.inputs)
    .map((i) => [i, firewallBreach(i)])
    .filter(([, why]) => why)
  if (breaches.length) {
    throw new Error(
      `Firewall: typebulb/${name} pulls forbidden code into its bundle:\n` +
        breaches.map(([i, why]) => `  ${i}  (${why})`).join('\n'),
    )
  }
}
console.log('✓ core-subpath firewall: ai, format, resolver, dts, lint, transpile stay lean')
