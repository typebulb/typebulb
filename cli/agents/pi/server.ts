// pi's agent-mirror server entry — its RPC surface for the browser (tb.server.<name>). Same shape as
// the Claude barrel (TB-Agent-Mirror.md, TB-Agent-Harness.md): the neutral mirror engine (../server/mirror.ts)
// constructed with the PiAdapter, plus the neutral launcher. There is deliberately NO model switcher —
// pi switches models natively, so the proxy the Claude mirror needs is absent here (TB-Agent-Harness.md).
// The composer RPCs ARE here and not in the Claude barrel: PiAdapter implements createDriver
// (TB-Agent-Composer.md), so this mirror can drive pi; `shutdownComposer` is serve.ts's reap hook,
// the same shape as Claude's shutdownSwitcher.
import { createMirror } from '../core/server/mirror.js'
import { PiAdapter } from './server/adapter.js'

const adapter = new PiAdapter()
export const displayName = adapter.displayName
export const { info, poll, logInlineStatus, listSessions, searchSessions, sessionPeek, attach, composerSend, composerStop, composerNew, composerFiles, composerUiRespond, composerRpc, composerPaste, composerPasteRead, summarizeTurn, shutdownComposer } = createMirror(adapter)

export * from '../core/server/launcher.js'
export * from '../core/server/git.js'

// The /model palette's local-Ollama sync (TB-Agent-Composer-Toolkit.md Piece 5) — mirror RPCs on
// typebulb's side (probe + models.json write), not pi passthroughs; pi-barrel-only.
export { ollamaOffer, ollamaSync } from './server/ollama.js'
