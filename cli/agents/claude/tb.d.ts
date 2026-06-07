/**
 * Ambient `tb` global for the agent mirror's client (`client/`).
 *
 * The mirror runs as ordinary CLI-bundled code, not through the bulb pipeline, so it
 * gets a minimal `tb` injected by the page (see `agentViewer/page.ts`) rather than the
 * full bulb shim. It uses exactly one surface — `tb.server.<name>(...)` for the RPC
 * into `server.ts`, and `tb.server.log(...)` for diagnostics — so that is all this
 * declares. The RPC is dynamically dispatched (a Proxy → `POST /__api/<name>`), so the
 * member type is the honest one: any args, a promised result.
 */
declare const tb: {
  server: Record<string, (...args: any[]) => Promise<any>> & {
    log(...args: any[]): Promise<void>
  }
}
