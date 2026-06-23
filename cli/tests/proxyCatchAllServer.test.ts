import { describe, it, expect } from 'vitest'
import { startServer, findAvailablePort } from '../src/serve/server.js'

/**
 * runtime-specs/TB-Proxy.md Invariant 1/3, end-to-end. The CLI serves esm.sh module bytes from localhost, so
 * an absolute sub-import esm.sh emits (globe.gl → `/d3-array/src/ascending?target=es2022`) hits
 * THIS server and must be re-proxied to esm.sh, not 404'd. Today the catch-all rejects the
 * unversioned shape and returns a local "Not Found" 404, which silently kills the module graph.
 *
 * The RED assertion below is offline (the catch-all rejects before any upstream fetch). Going
 * GREEN re-proxies to esm.sh, so the passing run needs network reachability to esm.sh.
 */
describe('server re-proxies unversioned esm subpaths', () => {
  it('does not local-404 an unversioned esm.sh subpath', async () => {
    const port = await findAvailablePort(38000)
    const server = await startServer({
      getHtml: () => '<!doctype html><div id="root"></div>',
      basePath: process.cwd(),
      port,
    })
    try {
      const res = await fetch(`http://127.0.0.1:${port}/d3-array/src/ascending?target=es2022`)
      // RED: unversioned shape → local catch-all 404. GREEN: re-proxied to esm.sh.
      expect(res.status).not.toBe(404)
    } finally {
      server.close()
    }
  })
})
