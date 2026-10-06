import { spawn, execFile } from 'child_process'
import { promisify } from 'util'
import { randomBytes } from 'crypto'

// A client of the shared local Codex app server (TB-Agent-Codex.md § Waking through the app server):
// the daemon that hosts the user's interactive sessions. `codex app-server proxy` exposes its control
// socket on stdio, and that socket speaks JSON-RPC inside WebSocket frames, so this does the upgrade
// and the framing itself. Only what a wake needs: which threads it hosts, and starting a turn on one.

const execFileAsync = promisify(execFile)
const TIMEOUT_MS = 15_000

interface Daemon { exe: string; socket: string }

// The running daemon, as the user's own CLI reports it: its binary and socket follow CODEX_HOME, so
// nothing here guesses a path. Each way this can fail says which, since one generic "no server"
// hid a CLI that could not find its home, and a socket the sandbox denied (Codex's first live run).
async function daemon(): Promise<Daemon> {
  let out: string
  try {
    out = (await execFileAsync('codex', ['app-server', 'daemon', 'version'], { shell: true, timeout: TIMEOUT_MS })).stdout
  } catch (e) {
    const err = e as { code?: string | number; stderr?: string; message?: string }
    const said = (err.stderr || err.message || '').trim().split('\n').at(-1)
    throw new Error(err.code === 'ENOENT' ? 'the codex CLI is not on PATH' : `the codex CLI could not report its app server (${said})`)
  }
  let v: { status?: string; managedCodexPath?: string; socketPath?: string }
  try { v = JSON.parse(out) } catch { throw new Error(`the codex CLI's daemon report was not JSON: ${out.trim().slice(0, 120)}`) }
  if (v.status !== 'running') throw new Error(`no shared Codex app server is running (daemon status: ${v.status ?? 'unknown'})`)
  if (!v.managedCodexPath || !v.socketPath) throw new Error('the codex CLI named no daemon binary or socket')
  return { exe: v.managedCodexPath, socket: v.socketPath }
}

// A client text frame: FIN + text opcode, masked as a client's must be.
function frame(text: string): Buffer {
  const data = Buffer.from(text)
  const mask = randomBytes(4)
  const n = data.length
  const head = n < 126 ? Buffer.from([0x81, 0x80 | n])
    : n < 65536 ? Buffer.from([0x81, 0x80 | 126, n >> 8, n & 255])
    : Buffer.concat([Buffer.from([0x81, 0x80 | 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b })()])
  return Buffer.concat([head, mask, Buffer.from(data.map((x, i) => x ^ mask[i % 4]!))])
}

/** One connection: initialize on open, then calls by id. Server requests (approvals) are not ours to
 *  answer: they belong to the session's own UI, so this never replies to them. */
class Connection {
  #pending = new Map<number, (m: { result?: unknown; error?: { message?: string } }) => void>()
  #next = 1
  #raw = Buffer.alloc(0)
  #open = false
  #ready: Promise<void>
  #stderr = ''
  constructor(private proc: ReturnType<typeof spawn>) {
    let opened: () => void, failed: (e: Error) => void
    this.#ready = new Promise((res, rej) => { opened = res; failed = rej })
    // The proxy's own words are the diagnostic: a socket the sandbox denies reads as an OS error there.
    proc.stderr!.on('data', (d: Buffer) => { this.#stderr += d })
    proc.stdout!.on('data', (d: Buffer) => this.#read(d, opened))
    proc.on('exit', () => {
      const why = this.#stderr.trim().split('\n').filter(l => l.trim()).join(' ').slice(0, 300)
      failed(new Error(`could not reach the Codex app server socket${why ? `: ${why}` : ''}`))
      for (const r of this.#pending.values()) r({ error: { message: 'connection closed' } })
    })
    proc.stdin!.write(`GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`)
  }
  #read(d: Buffer, opened: () => void) {
    this.#raw = Buffer.concat([this.#raw, d])
    if (!this.#open) {
      const end = this.#raw.indexOf('\r\n\r\n')
      if (end < 0) return
      this.#open = true
      this.#raw = this.#raw.subarray(end + 4)
      opened()
    }
    for (;;) {
      if (this.#raw.length < 2) return
      let len = this.#raw[1]! & 127, off = 2
      if (len === 126) { if (this.#raw.length < 4) return; len = this.#raw.readUInt16BE(2); off = 4 }
      else if (len === 127) { if (this.#raw.length < 10) return; len = Number(this.#raw.readBigUInt64BE(2)); off = 10 }
      if (this.#raw.length < off + len) return
      const opcode = this.#raw[0]! & 15
      const text = this.#raw.subarray(off, off + len).toString()
      this.#raw = this.#raw.subarray(off + len)
      if (opcode !== 1) continue
      try {
        const m = JSON.parse(text) as { id?: number; method?: string; result?: unknown; error?: { message?: string } }
        if (m.id !== undefined && !m.method && this.#pending.has(m.id)) { this.#pending.get(m.id)!(m); this.#pending.delete(m.id) }
      } catch {}
    }
  }
  async call(method: string, params: unknown): Promise<unknown> {
    await this.#ready
    const id = this.#next++
    const reply = await new Promise<{ result?: unknown; error?: { message?: string } }>((res, rej) => {
      this.#pending.set(id, res)
      setTimeout(() => rej(new Error(`no reply to ${method}`)), TIMEOUT_MS)
      this.proc.stdin!.write(frame(JSON.stringify({ jsonrpc: '2.0', id, method, params })))
    })
    if (reply.error) throw new Error(reply.error.message ?? `${method} failed`)
    return reply.result
  }
  notify(method: string) { this.proc.stdin!.write(frame(JSON.stringify({ jsonrpc: '2.0', method }))) }
  close() { this.proc.kill() }
}

async function connect(): Promise<Connection> {
  const d = await daemon()
  const c = new Connection(spawn(d.exe, ['app-server', 'proxy', '--sock', d.socket], { stdio: ['pipe', 'pipe', 'pipe'] }))
  await c.call('initialize', { clientInfo: { name: 'typebulb', version: '1' } })
  c.notify('initialized')
  return c
}

/** The threads the shared app server hosts right now: a session the user has open. */
export async function loadedThreads(): Promise<string[]> {
  const c = await connect()
  try { return ((await c.call('thread/loaded/list', {})) as { data?: string[] }).data ?? [] } finally { c.close() }
}

/** Start a turn on a hosted thread, carrying `output` as the result of a tool named `name`, so it
 *  reads as typebulb reporting rather than the user speaking. No model, approval or sandbox override:
 *  the turn takes the session's own settings. Resolves once the server has accepted the turn. */
export async function startToolTurn(threadId: string, name: string, output: string): Promise<void> {
  const c = await connect()
  try { await c.call('turn/start', { threadId, input: [], toolOutput: { name, output }, turnTrigger: 'typebulb' }) } finally { c.close() }
}
