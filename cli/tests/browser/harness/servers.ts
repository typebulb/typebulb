import * as net from 'net'
import * as http from 'http'
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { spawn, type ChildProcess } from 'child_process'
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

/** The published bin (dist build) — for suites whose fidelity point is spawning the real CLI. */
export const distBin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../dist/index.js')

export function requireDistBuild(): void {
  if (!fs.existsSync(distBin)) throw new Error(`${distBin} missing — run \`pnpm run build\` before the browser suite`)
}

/**
 * Launch a bulb via the real bin the way a terminal does, resolving once it prints the URL it
 * bound. `--no-watch` so only a replace can ever reload the page, never a save. The child lands in
 * `track` for the caller's afterAll to reap. `args` appends extra flags (e.g. `--trust`).
 */
export function launchBulb(file: string, opts: { cwd: string; env: NodeJS.ProcessEnv; track: ChildProcess[]; args?: string[] }): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [distBin, file, '--no-open', '--no-watch', ...(opts.args ?? [])], { cwd: opts.cwd, env: opts.env })
    opts.track.push(child)
    let out = ''
    const onData = (chunk: Buffer) => {
      out += chunk.toString()
      const m = out.match(/http:\/\/localhost:\d+/)
      if (m) resolve(m[0])
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('exit', code => reject(new Error(`server exited (${code}): ${out}`)))
    setTimeout(() => reject(new Error(`no URL printed: ${out}`)), 60_000)
  })
}

/** Run the real bin once and collect its outcome (for `send` probes: the reply owns stdout). */
export function runCli(args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [distBin, ...args], { cwd: opts.cwd, env: opts.env })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (c: Buffer) => { stdout += c.toString() })
    child.stderr?.on('data', (c: Buffer) => { stderr += c.toString() })
    child.on('error', reject)
    child.on('exit', code => resolve({ code: code ?? -1, stdout, stderr }))
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
