// Codex's agent-mirror server entry — its RPC surface for the browser (tb.server.<name>). Same shape
// as the Claude/Pi barrels (TB-Agent-Mirror.md, TB-Agent-Harness.md): the neutral mirror engine
// constructed with the CodexAdapter, plus the neutral launcher. Read-only by construction
// (TB-Agent-Codex.md): no switcher (Codex switches models natively) and no composer (no createDriver
// — driving Codex, if ever, is its own spec).
import { createMirror } from '../core/server/mirror.js'
import { CodexAdapter } from './server/adapter.js'

const adapter = new CodexAdapter()
export const displayName = adapter.displayName
// composerPasteRead (read-only, paste-dir-scoped) and summarizeTurn (render-only) ride along
// composer-less: any mirror renders a paste-mention thumbnail it encounters in a transcript, and
// every content view carries the summarize pill.
export const { info, poll, logInlineStatus, listSessions, searchSessions, sessionPeek, attach, composerPasteRead, summarizeTurn } = createMirror(adapter)

export * from '../core/server/launcher.js'
export * from '../core/server/git.js'
