// The neutral data contracts an agent mirror's server and client agree on — the poll() event stream
// and the token/session shapes. NEUTRAL GROUND at core/ top-level (not under server/ or client/) so
// BOTH halves import the same canonical definitions and the wire contract can't drift: the client
// never redefines the event union, the server never redefines the token shape (TB-Harness.md). A pure-types
// module with no imports, so it crosses the client/server boundary without dragging either half's
// dependencies along (the boundary test allows a client module to import it — no `src/`, no node
// builtin, no `server/` path).

/** The current-window token counts the token chip shows (last response's usage, never a session sum). */
export interface TokenCounts { in: number; out: number; cached: number; cacheCreate: number }

/** A session transcript file the mirror can attach to. `sessionId` is the adapter's stable id
 *  (CC: the `.jsonl` stem; Pi: the `<ts>_<uuid>` stem); `file` the absolute path; `mtime` for sorting. */
export interface SessionFile { sessionId: string; file: string; mtime: number }

/** One conversational event the server emits to the client via poll(). The client consumes ONLY this
 *  union — it never sees a CC or Pi transcript entry; every adapter maps its on-disk schema onto these. */
export type Event =
  | { type: 'session'; sessionId: string }
  | { type: 'user'; text: string }
  | { type: 'assistant'; text: string; thinking: string; tools: { id: string; name: string; input: Record<string, unknown> }[]; live: boolean }
  // `digest` is the one-line OUT summary a collapsed tool row shows ("463 lines", "2 files",
  // the first stdout line) — adapter-computed: CC from the structured `toolUseResult` its own
  // condensed UI renders from, Pi from the raw result text. '' / absent ⇒ nothing to show.
  | { type: 'tool_result'; id: string; content: string; isError: boolean; digest?: string }
  | { type: 'cleared' }
  | { type: 'usage'; in: number; out: number; cached: number; cacheCreate: number }
  // An abandoned (orphaned) branch off a fork point — the agent drops these; the mirror surfaces them
  // as a collapsed stub at the fork parent's position (TB-LostMessage.md). `events` are the orphan's
  // own rendered messages, `count` the user/assistant tally for the stub label, `atId` the fork-point
  // entry id.
  | { type: 'fork'; atId: string; count: number; events: Event[] }
