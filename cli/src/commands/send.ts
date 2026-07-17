import * as path from 'path'
import { listBulbServers, serversForBulb } from '../serve/serverRegistry.js'
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
interface SendOutcome { clients?: number; results?: string[]; errors?: string[]; timedOut?: boolean }

export async function runSend(file: string, message: string | undefined, waitMs = 0): Promise<void> {
  const reserved = message !== undefined && message.startsWith('tb:')
  if (reserved && waitMs <= 0) waitMs = DEFAULT_SEND_WAIT_MS

  const abs = path.resolve(file)
  const server = serversForBulb(await listBulbServers(), abs)[0]
  if (!server) {
    console.error(`No running server for '${file}'. Start it first: npx typebulb ${file}`)
    process.exit(1)
  }

  const post = async (replyMs: number): Promise<SendOutcome> => {
    const resp = await fetch(`${server.url}/__send${replyMs > 0 ? `?reply=${replyMs}` : ''}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: message ?? '',
    })
    if (!resp.ok) {
      console.error(`send failed: HTTP ${resp.status} from ${server.url}/__send`)
      process.exit(1)
    }
    return (await resp.json().catch(() => ({}))) as SendOutcome
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
  if (clients === 0) {
    if (waitMs > 0) console.error(`No page connected after ${waitMs / 1000}s — is the bulb open?`)
    else console.error('Sent, but no page is connected yet — open the bulb and retry.')
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
    // A bare-string reply prints raw (a tb:snapshot outline stays readable); everything else as JSON.
    let decoded: unknown
    try { decoded = JSON.parse(results[0]) } catch { decoded = undefined }
    console.log(typeof decoded === 'string' ? decoded : results[0])
  } else if (outcome.timedOut) {
    if (reserved) {
      console.error(`No reply to '${message}' within ${waitMs / 1000}s — reload the page and retry.`)
      process.exit(1)
    }
    console.error(`(no reply within ${waitMs / 1000}s — a slow handler's return needs a larger --wait=ms)`)
  }
}
