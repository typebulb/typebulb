// The mirror's RPC surface, assembled from the server/ submodules. Kept as a barrel at THIS path
// because serve.ts (the RPC host, via `import * as`) and the tests import from './server.js' by name —
// so the split is invisible to them. See TB-Agent-Mirror.md.
//
// The three submodules and their one-way dependency (features → core → context):
//   - server/transcript.ts — THE CORE: tails CC's JSONL, the live chain, poll/session-picker/search.
//     Importing it runs its boot side-effects (lock sweep + initial attach), so it comes first.
//   - server/launcher.ts   — breakout / bulb launcher / openFile (depends on the core's searchHits).
//   - server/switcher.ts   — the agent switcher + model probe (depends on neither — only cwd + catalog).
// The core depends on nothing but server/context.ts; the features never reach back into it beyond the
// shared search helper. That one-way edge is what let these peel off the former god-object server.ts.
export * from './server/transcript.js'
export * from './server/launcher.js'
export * from './server/switcher.js'
