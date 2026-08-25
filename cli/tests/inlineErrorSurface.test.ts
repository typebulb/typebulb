import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { renderHtml } from '../src/bulb/template.js'
import { loadAndCompile } from '../src/pipeline.js'

// The window after a release reaches npm and before the CDNs carry it: every resolution of the
// new range fails. Mocked here so the failure is deterministic and offline.
vi.mock('../src/deps/resolver.js', () => ({
  packageService: { buildImportMap: async () => { throw new Error('Cannot resolve tensorgrad@^0.5.0: no matching version is published') } },
  versionResolver: {}, cdnClient: {}, peerResolver: {},
}))

/**
 * The inline bulb forwards failures to the host only via `window` 'error' / 'unhandledrejection'
 * (template.ts) → createBulbFrame.onError → `typebulb logs claude`. Those catch thrown
 * exceptions and rejected promises — the compile and runtime classes. But a failed module /
 * resource fetch (an unresolvable dependency) fires a NON-bubbling 'error' that a bubble-phase
 * listener never sees, so the dep 404s, React never mounts, the inline bulb collapses to zero height,
 * and nothing reaches the log (the globe.gl failure). The inline bulb must also surface this third
 * class — load failure. A capture-phase 'error' listener is the standard mechanism, since
 * resource-load errors reach `window` only during capture.
 *
 * Structural pin (RED today). Whether capture-phase alone catches a failed module *sub*-fetch is
 * browser-dependent; the implementation should pair it with an "empty body shortly after load"
 * backstop, and the behavioral proof is the browser-level check (client/_probe.mjs). This test
 * guards the floor: the inline bulb registers capture-phase error handling at all.
 */
const base = {
  name: 'T', code: '', css: '', html: '<div id="root"></div>',
  data: [] as string[], insight: '', importMap: { imports: {} }, watch: false,
}

describe('inline bulb surfaces module/resource load failures', () => {
  it('registers a capture-phase error listener in the inline bulb srcdoc', () => {
    const html = renderHtml({ ...base, inline: true })
    // addEventListener('error', handler, true) — the `true` (capture) is what catches
    // non-bubbling resource/module load errors.
    expect(html).toMatch(/addEventListener\(\s*['"]error['"][\s\S]*?,\s*true\s*\)/)
  })
})

/**
 * Every build failure takes one route: the page still serves, with no code and the reason in
 * `__TB_COMPILE_ERROR__`, so the browser, `tb:` reads, and the launcher's registry all see a running
 * bulb that says why it is empty. A throw instead leaves the watcher serving the previous build
 * (a bulb "stuck" on the old version of a dependency) and kills a launched child before it registers
 * (the launcher's 20s shimmer with nothing shown). TB-CLI.md § Build failures.
 */
describe('a build failure serves a page that says why, never a throw', () => {
  let project: string
  beforeAll(() => { project = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-build-')) })
  afterAll(() => { fs.rmSync(project, { recursive: true, force: true }) })

  const bulb = (code: string, config?: string) => [
    '---', 'format: typebulb/v1', 'name: T', '---', '',
    '**code.tsx**', '', '```tsx', code, '```', '',
    ...(config ? ['**config.json**', '', '```json', config, '```', ''] : []),
  ].join('\n')

  it('a dependency the CDNs cannot resolve', async () => {
    const file = path.join(project, 'dep.bulb.md')
    fs.writeFileSync(file, bulb('import { packRGBA8 } from "tensorgrad"\npackRGBA8()', '{ "dependencies": { "tensorgrad": "^0.5.0" } }'))
    const { html } = await loadAndCompile(file, false, false, undefined)
    expect(html).toContain('__TB_COMPILE_ERROR__')
    expect(html).toContain('Cannot resolve tensorgrad@^0.5.0')
    expect(html).not.toContain('packRGBA8')   // no bulb code on the page: it renders nothing, and says so
  })

  it('an import the config does not declare', async () => {
    const file = path.join(project, 'undeclared.bulb.md')
    fs.writeFileSync(file, bulb('import { packRGBA8 } from "tensorgrad"\npackRGBA8()'))
    const { html } = await loadAndCompile(file, false, false, undefined)
    expect(html).toContain('__TB_COMPILE_ERROR__')
    expect(html).toContain('Lint failed')
    expect(html).not.toContain('packRGBA8')
  })
})
