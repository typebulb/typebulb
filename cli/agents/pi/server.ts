// pi's agent-mirror server entry — its RPC surface for the browser (tb.server.<name>). Same shape as
// the Claude barrel (TB-Agent-Mirror.md, TB-Harness.md): the neutral mirror engine (../server/mirror.ts)
// constructed with the PiAdapter, plus the neutral launcher. There is deliberately NO model switcher —
// pi switches models natively, so the proxy the Claude mirror needs is absent here (TB-Harness.md).
import { createMirror } from '../core/server/mirror.js'
import { PiAdapter } from './server/adapter.js'

const adapter = new PiAdapter()
export const displayName = adapter.displayName
export const { info, poll, logEmbedStatus, listSessions, searchSessions, attach } = createMirror(adapter)

export * from '../core/server/launcher.js'
