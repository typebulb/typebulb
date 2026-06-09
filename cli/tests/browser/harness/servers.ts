import * as net from 'net'
import * as http from 'http'
import { startServer, type ServerInstance } from '../../../src/serve/server.js'

/** Reserve an ephemeral loopback port, then release it for a server to bind. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo
      srv.close(() => resolve(port))
    })
  })
}

/**
 * Boot a real typebulb server — the victim under test, with the actual `trustGate`
 * + `csrfGuard` ([server.ts]). Served on 127.0.0.1:<port>, addressable as
 * http://localhost:<port> (the DNS-rebind guard accepts the `localhost` Host).
 * `trusted: true` is the only tier where the privileged endpoints are open, so the
 * only tier the same-site CSRF can target.
 */
export async function startTypebulb(opts: { basePath: string; trusted: boolean }): Promise<ServerInstance> {
  return startServer({
    getHtml: () => '<html><body>victim</body></html>',
    basePath: opts.basePath,
    port: await freePort(),
    trusted: opts.trusted,
  })
}

/**
 * Serve a single static HTML page (the attacker origin) on its own loopback port —
 * a plain node server, because the attacker only needs to be *a different localhost
 * origin* (another bulb, a dev server, any local tool), not a typebulb. A different
 * port on the same host is what makes the browser stamp `Sec-Fetch-Site: same-site`.
 */
export async function startStaticPage(html: string): Promise<{ origin: string; close: () => void }> {
  const port = await freePort()
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(html)
  })
  await new Promise<void>(resolve => server.listen(port, '127.0.0.1', () => resolve()))
  return { origin: `http://localhost:${port}`, close: () => server.close() }
}
