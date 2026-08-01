// Claude Code's agent-mirror server entry — its RPC surface for the browser (tb.server.<name>). Kept at
// THIS path because serve.ts (the RPC host, via `import * as`) and the tests import './server.js' by
// name. See TB-Agent-Mirror.md and TB-Agent-Harness.md (the harness-neutral split).
//
// The mirror engine (../server/mirror.ts) is harness-NEUTRAL; this barrel realizes it for Claude by
// constructing it with the ClaudeAdapter, then re-exporting:
//   - the engine's transcript RPCs (info/poll/listSessions/searchSessions/attach/logInlineStatus),
//   - the neutral launcher (breakout / bulb launcher / openFile — ../server/launcher.ts),
//   - the Claude-only agent switcher + model probe (./server/switcher.ts — the wire proxy, which Pi
//     does not have: TB-Agent-Switcher.md). `export *` runs switcher's boot reconcile on import.
// Constructing the mirror here runs its boot side-effects (lock sweep + initial attach), so it stays
// first, the same ordering the former transcript core had.
import { createMirror } from '../core/server/mirror.js'
import { ClaudeAdapter } from './server/adapter.js'

const adapter = new ClaudeAdapter()
// The mirror's display name (page title, the startup log line), read by serve.ts off the imported
// module — one source of truth with the adapter. The RPC surface is the engine's, re-exported by name.
export const displayName = adapter.displayName
// composerPasteRead (read-only, paste-dir-scoped) rides along composer-less: any mirror renders a
// paste-mention thumbnail it encounters in a transcript.
export const { info, poll, logInlineStatus, listSessions, searchSessions, sessionPeek, attach, composerPasteRead } = createMirror(adapter)

export * from '../core/server/launcher.js'
export * from '../core/server/git.js'
export * from './server/switcher.js'

// Test surface (imported by name from './server.js'): the Claude cleaning/schema helpers and the
// neutral text cap. `openFile` rides the launcher re-export above.
export { isHiddenTurn, blockToMarkdown, cleanUserText, toolResultDigest } from './server/adapter.js'
export { capText, firstLineDigest } from '../core/server/text.js'
