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
 */
export async function runSend(file: string, message: string | undefined): Promise<void> {
  const abs = path.resolve(file)
  const server = serversForBulb(await listBulbServers(), abs)[0]
  if (!server) {
    console.error(`No running server for '${file}'. Start it first: npx typebulb ${file}`)
    process.exit(1)
  }

  let clients = 0
  try {
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
    clients = data.clients ?? 0
  } catch (e) {
    console.error(`send failed: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(1)
  }

  if (clients > 0) console.log(`Sent to ${clients} page${clients === 1 ? '' : 's'}.`)
  else console.log('Sent, but no page is connected yet — open the bulb and retry.')
}
