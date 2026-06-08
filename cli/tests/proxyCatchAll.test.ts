import { describe, it, expect } from 'vitest'
import { isEsmAbsoluteImportPath } from '../src/serve/esmProxyPaths.js'

/**
 * specs/Proxy.md Invariant 3: the CLI serves esm.sh module bytes from localhost, so EVERY
 * absolute import shape esm.sh emits in those bytes must be re-proxyable — versioned or not.
 * A shape the catch-all misses 404s the whole module graph against localhost with no thrown
 * exception (the globe.gl → d3-array failure). typebulb.com never hits this because it loads
 * modules from the CDN origin, where absolute sub-imports resolve against the CDN.
 */
describe('esm absolute-import catch-all coverage', () => {
  it('matches the versioned / build-prefixed shapes esm.sh emits', () => {
    for (const p of [
      '/preact@10.29.2/es2022/preact.mjs',
      '/@scope/pkg@1.0.0/index.mjs',
      '/v135/react@19.0.0/es2022/react.mjs',
      '/stable/foo@1.0.0/x.mjs',
      '/node/buffer.mjs',
      '/gh/owner/repo@1.0.0/x.mjs',
    ]) expect(isEsmAbsoluteImportPath(p)).toBe(true)
  })

  it('does NOT relay plain app paths upstream', () => {
    for (const [pathname, search] of [
      ['/favicon.ico', ''],
      ['/about', ''],
      ['/main.css.map', ''],
      ['/', ''],
      // An unversioned path with NO esm marker is an app route, not an import — must stay a 404.
      ['/about/team', ''],
    ] as const) expect(isEsmAbsoluteImportPath(pathname, search)).toBe(false)
  })

  // RED — the globe.gl regression. esm.sh emits unversioned d3 subpaths under `bundle=`, marked
  // by the `?target=` query. They must be recognized (else they 404 against localhost), while the
  // marker keeps genuine app routes (above) out.
  it('matches unversioned esm subpaths carrying an esm marker query', () => {
    for (const [pathname, search] of [
      ['/d3-array/src/ascending', '?target=es2022'],
      ['/d3-array/src/bisect', '?target=es2022'],
      ['/d3-scale/src/linear', '?target=es2022&bundle='],
    ] as const) expect(isEsmAbsoluteImportPath(pathname, search)).toBe(true)
  })
})
