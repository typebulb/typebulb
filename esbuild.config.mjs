import { build } from 'esbuild'
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync } from 'fs'

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
  // External only what npm installs anyway (the core areas' runtime deps) and `open`, which spawns
  // the xdg-open script it ships; everything else is bundled, so an install fetches fewer packages.
  external: [
    'sucrase',
    'open',
    'semver', 'es-module-lexer',
    'fflate', 'p-limit', 'resolve.exports',
    // The agent mirror dynamically imports esbuild to rebuild its client bundle on a source
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

// The agent mirror client (TB-Agent-Mirror.md, TB-Agent-Harness.md): ONE browser bundle for every
// harness (`agents/client.ts` picks the harness at runtime; the per-harness code is a few pills), so
// the package ships the shared UI once rather than once per harness. Self-contained (NO externals —
// katex/markdown-it/pele/dompurify/highlight.js, the `agents/*/client/` modules, and the internal
// `../src/render.ts` they import are all inlined). styles.css + index.html are the neutral chrome
// (`agents/core/client/`), copied beside it with KaTeX's stylesheet and fonts, so runAgentViewer reads
// them from `dist/agents/` at runtime. The server halves (`agents/<name>/server.ts`) need no copy:
// they're bundled into `dist/index.js` (serve.ts's static import map).
await build({
  entryPoints: ['cli/agents/client.ts'],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  outfile: 'dist/agents/client.js',
  minify: true,
})
for (const asset of ['styles.css', 'index.html', 'typebulb.png', 'typebulb-inv.png']) {
  copyFileSync(
    new URL(`./cli/agents/core/client/${asset}`, import.meta.url),
    new URL(`./dist/agents/${asset}`, import.meta.url),
  )
}
// KaTeX's stylesheet, self-hosted: on a CDN it was a render-blocking fetch in a localhost tool's
// critical path. Font URLs are absolutised to the mirror's mount because page.ts inlines the css
// into <head>, where the file's own `fonts/` would resolve against `/`. woff2 only — it is
// universally supported, so the css's woff/ttf fallbacks are listed but never fetched.
const katexDist = new URL('./node_modules/katex/dist/', import.meta.url)
writeFileSync(
  new URL('./dist/agents/katex.min.css', import.meta.url),
  readFileSync(new URL('katex.min.css', katexDist), 'utf8').replaceAll('url(fonts/', 'url(/agents/fonts/'),
)
mkdirSync(new URL('./dist/agents/fonts/', import.meta.url), { recursive: true })
for (const font of readdirSync(new URL('fonts/', katexDist)).filter(f => f.endsWith('.woff2'))) {
  copyFileSync(new URL(`fonts/${font}`, katexDist), new URL(`./dist/agents/fonts/${font}`, import.meta.url))
}

// The shipped skill artifact (TB-Skill.md): SKILL.md at the package root — discovery frontmatter +
// freshness note + the README verbatim. Assembled by the same compiled skill.ts the `skill` command
// runs, imported from tsc's output (`build`/`prepublishOnly` both run `tsc --build` first), so the
// shipped file and the runtime emit can't drift. Root, not dist/: it sits beside the README it wraps.
const { buildSkill, bundledReadmePath } = await import('./cli/.tsbuild/src/skill.js')
writeFileSync(new URL('./SKILL.md', import.meta.url), buildSkill(readFileSync(bundledReadmePath(), 'utf8'), pkg.version))

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
  /** Called once, on the embed's first auto-height report — the bulb's code ran to first
   *  paint. Skipped if an error arrives first, so ready never follows a failure. */
  onReady?: () => void
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

/** Structural problems a bulb's Markdown has (chiefly an unterminated fence that swallowed a block);
 *  one message per problem, empty when well-formed. */
export declare function validateBulbStructure(content: string): string[]
`)

// ── Core-subpath firewall (TB-Single-Package.md req 3, TB-Lint-Transpile.md) ─────────────────────
// The core areas ship as their own tsc-emitted subpath entries, all inside the one `typebulb` package,
// and typebulb.com imports them on its published-bulb hot path. Nothing structurally stops one from
// importing code it shouldn't, which would silently bloat that hot path — the catastrophe being a
// "hello world" published bulb dragging in the three ENORMOUS things it must never touch: the CLI /
// agent mirror (`cli/`), the full TypeScript compiler (`typescript`), and Monaco (`monaco-editor`).
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
// ones the firewall exists for; the rest are CLI / agent-mirror only — pocket change by comparison, but
// still out of place in a core area. Sucrase is intentionally NOT here (it's condoned).
const FORBIDDEN_DEPS = [
  'typescript', 'monaco-editor',
  'hono', '@hono/node-server', 'open', 'chokidar',
  'pele', 'katex', 'markdown-it', 'dompurify', 'highlight.js', 'domeleon',
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
