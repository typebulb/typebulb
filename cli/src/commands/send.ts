import * as path from 'path'
import * as http from 'http'
import { mkdir, writeFile } from 'fs/promises'
import { listBulbServers, serversForBulb } from '../serve/serverRegistry.js'
import { canvasPngPath } from '../serve/paths.js'
import { lastRunTimes } from '../serve/portBlocks.js'
import { DEFAULT_SEND_WAIT_MS } from '../args.js'

/**
 * `typebulb send <file> [message]` — push a value from the terminal into a running bulb's page, where
 * its `tb.onMessage(cb)` handlers receive it. The client-side dual of `typebulb call` (which invokes
 * `server.ts` in Node and never reaches the browser): the canonical "kick it off when I'm ready"
 * trigger, so a bulb gates expensive work behind `tb.onMessage(() => start())` rather than running it
 * on every hot reload (TB-CLI.md).
 *
 * Resolves the target in the cross-project registry by canonical file path (like `logs`/`stop`), POSTs
 * the message to its `/__send` (data-in, trust-free — no capability boundary crossed), and reports the
 * connected-page count the endpoint returns. Delivery is best-effort, never buffered: a send that
 * reaches no page (none open, or its SSE hasn't attached yet) is reported, not queued — retry.
 *
 * `--wait[=ms]` bounds the whole exchange (TB-Interrogation.md). First the reattach retry: a
 * hot reload aborts the page's SSE before the fresh page re-attaches, so the first POST can land on
 * zero listeners; we re-POST until a page attaches or the window elapses — never a server-side queue,
 * so the "never buffered" contract is intact. Then the reply leg: the delivering POST holds while the
 * page awaits its handlers, and a non-`undefined` return prints on stdout (JSON; a bare string raw) —
 * the delivery line stays on stderr so the reply owns stdout, `call`'s exact contract. One reply owns
 * stdout: zero keeps the fire-and-forget behavior, more than one (extra handlers, extra pages) is an
 * error, as is a handler throw. `tb:*` messages are shim-answered (never reach `tb.onMessage`) and
 * imply `--wait` — a reply is their only purpose, so silence is an error for them alone.
 */
interface SendOutcome { clients?: number; results?: string[]; errors?: string[]; timedOut?: boolean; droppedMsAgo?: number; refused?: boolean }

/**
 * POST to the running server over `node:http` rather than global `fetch`. `--wait` is the only ceiling
 * the exchange has: undici (what `fetch` is) caps a response at a 300s header timeout, so a longer
 * `--wait` died at five minutes as a bare `fetch failed` — on exactly the long-running client work
 * `send` exists to drive. Node exposes no dispatcher to raise it, and the target is loopback plain
 * HTTP, so we make the request directly and disable timeouts outright (TB-CLI.md).
 */
function postToServer(url: string, body: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text }))
    })
    req.setTimeout(0)
    req.on('error', reject)
    req.end(body)
  })
}

const relAgo = (t: number) => {
  const m = Math.round((Date.now() - t) / 60_000)
  return m < 1 ? 'moments ago' : m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`
}

export async function runSend(file: string, message: string | undefined, waitMs = 0): Promise<void> {
  const reserved = message !== undefined && message.startsWith('tb:')
  if (reserved && waitMs <= 0) waitMs = DEFAULT_SEND_WAIT_MS
  // Actuation verbs are gestures: the server must refuse them before dispatch unless exactly one
  // page is connected (TB-Interrogation-Actuation.md) — a read broadcast twice is harmless, a
  // gesture broadcast twice has fired in two divergent pages before the replies can disagree.
  const actuation = message !== undefined && /^tb:(click|set)( |$)/.test(message)

  const abs = path.resolve(file)
  const server = serversForBulb(await listBulbServers(), abs)[0]
  if (!server) {
    // Report what is observed (TB-CLI.md): a bulb that HAS run holds a sticky slot, so a relaunch
    // lands on the same URL — the bare "start it" imperative read as "spawn a fresh window" to an
    // agent whose user owned the still-open tab.
    const last = (await lastRunTimes(process.cwd()))(abs)
    console.error(last
      ? `No running server for '${file}' — it last ran ${relAgo(last)}. Relaunching reuses the same URL (a stale tab is one reload from live): npx typebulb ${file}`
      : `No running server for '${file}'. Start it first: npx typebulb ${file}`)
    process.exit(1)
  }

  const post = async (replyMs: number): Promise<SendOutcome> => {
    const query = [replyMs > 0 ? `reply=${replyMs}` : '', actuation ? 'solo=1' : ''].filter(Boolean).join('&')
    const resp = await postToServer(`${server.url}/__send${query ? `?${query}` : ''}`, message ?? '')
    if (resp.status < 200 || resp.status >= 300) {
      console.error(`send failed: HTTP ${resp.status} from ${server.url}/__send`)
      process.exit(1)
    }
    try { return JSON.parse(resp.text) as SendOutcome } catch { return {} }
  }

  let outcome: SendOutcome = {}
  try {
    const deadline = Date.now() + waitMs
    do {
      outcome = await post(waitMs > 0 ? Math.max(deadline - Date.now(), 1000) : 0)
      if ((outcome.clients ?? 0) > 0 || Date.now() >= deadline) break
      await new Promise(r => setTimeout(r, 150))
    } while (true)
  } catch (e) {
    console.error(`send failed: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(1)
  }

  const clients = outcome.clients ?? 0
  const pages = `${clients} page${clients === 1 ? '' : 's'}`
  if (outcome.refused) {
    console.error(`Actuation needs exactly one connected page; ${pages} are open on ${server.url} — close the extras and retry.`)
    process.exit(1)
  }
  if (clients === 0) {
    // Report what the server observed, not just that nobody answered: a page that WAS attached and
    // hasn't come back is a stale tab in front of the user, and saying so is the whole difference
    // between a one-keystroke fix and an hour of hunting (TB-CLI.md, observed state).
    const dropped = outcome.droppedMsAgo
    const stale = dropped !== undefined
      ? ` — a page disconnected ${Math.round(dropped / 1000)}s ago and hasn't reconnected; reload it, or open ${server.url}`
      : ` — no page has ever connected; share ${server.url} and arm: typebulb wait ${file} --match "[page] connected"`
    if (waitMs > 0) console.error(`No page connected after ${waitMs / 1000}s${stale}`)
    else console.error(`Sent, but no page is connected${stale}`)
    if (reserved) process.exit(1)   // a tb:* message exists only for its reply
    return
  }

  // Delivery is a status line; stdout belongs to the one reply.
  console.error(`Sent to ${pages}.`)

  const results = outcome.results ?? []
  const errors = outcome.errors ?? []
  for (const err of errors) console.error(`handler error: ${err}`)
  if (errors.length) process.exit(1)
  if (results.length > 1) {
    console.error(`${results.length} replies from ${pages} — one reply owns stdout: at most one tb.onMessage handler, in one page, may return a value.`)
    process.exit(1)
  }
  if (results.length === 1) {
    // tb:png's bytes ride the envelope; the file is the transport's business (TB-Interrogation-
    // Pixels.md): decode to the bulb's one stable path, print that path — never megabytes of
    // base64 on stdout.
    if (message !== undefined && /^tb:png( |$)/.test(message)) {
      let reply: { png?: unknown; width?: number; height?: number; backdrop?: string; via?: string } = {}
      try { reply = JSON.parse(results[0]) as typeof reply } catch { /* shape-checked below */ }
      if (typeof reply.png !== 'string') {
        console.error('tb:png replied with an unexpected shape — an older runtime? (`typebulb logs` lists server versions)')
        process.exit(1)
      }
      const out = canvasPngPath(abs)
      await mkdir(path.dirname(out), { recursive: true })
      await writeFile(out, Buffer.from(reply.png, 'base64'))
      // The frame can't show what the read assumed, so the line does (TB-Interrogation-Pixels.md):
      // the flat backdrop composited under a transparent canvas, and the container it resolved
      // through. Both are stated only when they happened — silence means neither did.
      const notes = [
        reply.via ? `inside "${reply.via}"` : '',
        reply.backdrop ? `backdrop ${reply.backdrop}` : '',
      ].filter(Boolean)
      console.error(`canvas ${reply.width}×${reply.height} → PNG${notes.length ? ` (${notes.join('; ')})` : ''}`)
      console.log(out)
      return
    }
    // A bare-string reply prints raw (a tb:snapshot outline stays readable); everything else as JSON.
    let decoded: unknown
    try { decoded = JSON.parse(results[0]) } catch { decoded = undefined }
    console.log(typeof decoded === 'string' ? decoded : results[0])
  } else if (outcome.timedOut) {
    if (reserved) {
      console.error(`No reply to '${message}' within ${waitMs / 1000}s — reload the page and retry.`)
      process.exit(1)
    }
    console.error(`(no reply within ${waitMs / 1000}s — slow work needs a larger --wait=ms; a reply that NEVER comes is a done-promise that missed an exit)`)
  }
}
