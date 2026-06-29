import * as path from 'path'
import { listBulbServers, serversForBulb } from '../serve/serverRegistry.js'

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
 * `--wait[=ms]` automates exactly that retry on the client side, for the post-edit self-test loop: a
 * hot reload aborts the page's SSE before the fresh page re-attaches, so the first POST can land on
 * zero listeners. We re-POST until a page attaches or the window elapses — never a server-side queue,
 * so the "never buffered" contract is intact (the no-op POSTs hit zero listeners; only the one that
 * finds a live page delivers, and we stop there).
 */
export async function runSend(file: string, message: string | undefined, waitMs = 0): Promise<void> {
  const abs = path.resolve(file)
  const server = serversForBulb(await listBulbServers(), abs)[0]
  if (!server) {
    console.error(`No running server for '${file}'. Start it first: npx typebulb ${file}`)
    process.exit(1)
  }

  const post = async (): Promise<number> => {
    const resp = await fetch(`${server.url}/__send`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: message ?? '',
    })
    if (!resp.ok) {
      console.error(`send failed: HTTP ${resp.status} from ${server.url}/__send`)
      process.exit(1)
    }
    const data = (await resp.json().catch(() => ({}))) as { clients?: number }
    return data.clients ?? 0
  }

  let clients = 0
  try {
    const deadline = Date.now() + waitMs
    do {
      clients = await post()
      if (clients > 0 || Date.now() >= deadline) break
      await new Promise(r => setTimeout(r, 150))
    } while (true)
  } catch (e) {
    console.error(`send failed: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(1)
  }

  if (clients > 0) console.log(`Sent to ${clients} page${clients === 1 ? '' : 's'}.`)
  else if (waitMs > 0) console.log(`No page connected after ${waitMs / 1000}s — is the bulb open?`)
  else console.log('Sent, but no page is connected yet — open the bulb and retry.')
}
