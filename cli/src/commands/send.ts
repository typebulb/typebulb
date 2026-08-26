import * as path from 'path'
import * as http from 'http'
import { mkdir, writeFile } from 'fs/promises'
import { listBulbServers, serversForBulb } from '../serve/serverRegistry.js'
import { canvasPngPath } from '../serve/paths.js'
import { lastRunTimes } from '../serve/portBlocks.js'
import { DEFAULT_SEND_WAIT_MS } from '../args.js'
import { type PageOutcome } from '../serve/server.js'
import { PAGE_LOG } from '../serve/pages.js'
import { readStdin, normalizeContent } from '../payload.js'

/**
 * `typebulb send <file> [message]` — push a value from the terminal into a running bulb's page, where
 * its `tb.onMessage(cb)` handlers receive it. The client-side dual of `typebulb call` (which invokes
 * `server.ts` in Node and never reaches the browser): the canonical "kick it off when I'm ready"
 * trigger, so a bulb gates expensive work behind `tb.onMessage(() => start())` rather than running it
 * on every hot reload (TB-CLI.md).
 *
 * Resolves the target in the cross-project registry by canonical file path (like `logs`/`stop`), POSTs
 * the message to its `/__send` (data-in, trust-free — no capability boundary crossed), and reports the
 * connected-page count the endpoint returns. Never buffered: a message is fanned out over the pages
 * attached at that instant or not at all — no server-side queue. **A send that reached no page is a
 * failed send and exits 1** (TB-Page-Lifecycle.md, invariant 8): the caller chains (`send … && wait …`)
 * and reads a tool result only when the whole chain returns, so a true diagnosis printed ahead of a
 * blocking successor is one nobody reads until the damage is done.
 *
 * `--wait[=ms]` sizes the REPLY window (TB-Interrogation.md): the delivering POST holds while the
 * page awaits its handlers, and a non-`undefined` return prints on stdout (JSON; a bare string raw) —
 * the delivery line stays on stderr so the reply owns stdout, `call`'s exact contract. One reply owns
 * stdout: zero keeps the fire-and-forget behavior, more than one (extra handlers, extra pages) is an
 * error, as is a handler throw. `tb:*` messages are shim-answered (never reach `tb.onMessage`) and
 * imply `--wait` — a reply is their only purpose, so silence is an error for them alone.
 *
 * **Every** send that finds no page asks the server to open one where the agent mirror is
 * (`?open=1` → server.ts `requestPage`, TB-VSCode-Browser.md), so a closed tab reopens for the agent
 * that needs it. **The hold for that arrival is the server's**, not this command's: one POST goes out
 * and comes back once the page is here or the ask has run out, so there is no deadline arithmetic on
 * this side to get wrong (opening without waiting would move a window and still lose the message).
 * It costs a plain send nothing where there is nothing to open through — `none` is an answer and it
 * fails at once.
 * `--no-open` governs the launch only.
 */
interface SendOutcome { clients?: number; results?: string[]; errors?: string[]; timedOut?: boolean; droppedMsAgo?: number; refused?: boolean; opening?: PageOutcome['how']; via?: string }

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
  // `-` is the payload-from-stdin token `call --args -` and `put <kind>=-` already speak. Normalized
  // like theirs, so a piped message and the same text passed positionally deliver the same value.
  if (message === '-') message = normalizeContent(await readStdin())
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
    const query = [replyMs > 0 ? `reply=${replyMs}` : '', actuation ? 'solo=1' : '', 'open=1'].filter(Boolean).join('&')
    const resp = await postToServer(`${server.url}/__send${query ? `?${query}` : ''}`, message ?? '')
    if (resp.status < 200 || resp.status >= 300) {
      console.error(`send failed: HTTP ${resp.status} from ${server.url}/__send`)
      process.exit(1)
    }
    try { return JSON.parse(resp.text) as SendOutcome } catch { return {} }
  }

  let outcome: SendOutcome = {}
  const started = Date.now()
  try {
    // One POST: the server holds for the page, then for the replies. No retry, so nothing can be
    // delivered twice (an actuation fired in two frames is the hazard that ordering protects).
    outcome = await post(waitMs)
  } catch (e) {
    console.error(`send failed: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(1)
  }

  const clients = outcome.clients ?? 0
  const pages = `${clients} page${clients === 1 ? '' : 's'}`
  if (outcome.refused) {
    // Name the reset, not a gesture an agent can't make: it cannot reach into a browser to close a
    // tab, and `stop` now closes the pages before it goes (TB-Page-Lifecycle.md).
    console.error(`Actuation needs exactly one connected page; ${pages} are open on ${server.url} — the reset is \`typebulb stop ${file}\` then relaunch.`)
    process.exit(1)
  }
  if (clients === 0) {
    // Report what the server observed, not just that nobody answered: a page that WAS attached and
    // hasn't come back is a stale tab in front of the user, and saying so is the whole difference
    // between a one-keystroke fix and an hour of hunting (TB-CLI.md, observed state).
    const dropped = outcome.droppedMsAgo
    const noRelay = outcome.opening === 'none' ? ' and no agent mirror page is open to open one through' : ''
    const stale = outcome.opening === 'unreached'
      ? ` — the page was opened ${outcome.via ? `in VS Code via ${outcome.via}` : 'in your browser'} and never attached; is the browser it opened in still there?`
      : dropped !== undefined
        ? ` — a page disconnected ${Math.round(dropped / 1000)}s ago and hasn't reconnected${noRelay}; reload it, or open ${server.url}`
        : ` — no page has ever connected${noRelay}; share ${server.url} and arm: typebulb wait ${file} --match "${PAGE_LOG.connected}"`
    // One outcome for every send, `--wait` or not (invariant 8). "Sent, but no page is connected"
    // was the old plain-send line and it read as a success it wasn't: nothing was sent.
    console.error(`No page connected after ${((Date.now() - started) / 1000).toFixed(1)}s, so nothing was delivered${stale}`)
    process.exit(1)
  }

  // Where the page came from, when this send is why it exists: the launch prints the same fact, and
  // an agent that asked for a bulb it had closed should read that a window moved.
  if (outcome.opening === 'editor') console.error(`Opened in VS Code via ${outcome.via}.`)
  else if (outcome.opening === 'external') console.error('Opened in your browser, where the agent mirror is.')
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
    console.error(`(no reply within ${waitMs / 1000}s — slow work needs a larger --wait=ms; a reply that NEVER comes is a done-promise that missed an exit, or a blocked main thread: tb:snapshot runs no page code, so its silence too means blocked)`)
  }
}
