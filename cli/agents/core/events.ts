// The neutral data contracts an agent mirror's server and client agree on — the poll() event stream
// and the token/session shapes. NEUTRAL GROUND at core/ top-level (not under server/ or client/) so
// BOTH halves import the same canonical definitions and the wire contract can't drift: the client
// never redefines the event union, the server never redefines the token shape (TB-Agent-Harness.md).
// Types plus a few shared literal constants, no imports, so it crosses the client/server boundary
// without dragging either half's dependencies along (the boundary test allows a client module to
// import it — no `src/`, no node builtin, no `server/` path).

/** Where composer pastes land, relative to the project cwd (posix separators — it's prompt text). */
export const PASTE_DIR = '.typebulb/paste'

/** ext → mime for pasted images; the server's write/read paths and the client's thumbnail
 *  detection all derive from this one map. */
export const PASTE_IMAGE_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp',
}

/** The current-window token counts the token chip shows (last response's usage, never a session sum). */
export interface TokenCounts { in: number; out: number; cached: number; cacheCreate: number }

/** The harness's OWN session totals (pi's get_session_stats): session cost + current context usage,
 *  every value computed by the harness — the mirror does no cost/percent math of its own (parity #5).
 *  tokens/percent null = the harness says "unknown" (pi, right after a compaction, until the next
 *  response). Ephemeral, rides the poll like `draft`. */
export interface ComposerStats { cost: number; contextTokens: number | null; contextPercent: number | null }

/** A session transcript file the mirror can attach to. `sessionId` is the adapter's stable id
 *  (CC: the `.jsonl` stem; Pi: the `<ts>_<uuid>` stem); `file` the absolute path; `mtime` for sorting. */
export interface SessionFile { sessionId: string; file: string; mtime: number }

/** One line of ambient driver state (TB-Agent-Composer-Toolkit.md Piece 2): a retry/compaction in
 *  progress, an extension notify, or joined extension setStatus entries. Display-only. */
export interface ComposerStatus { text: string; kind: 'info' | 'warning' | 'error' }

/** The driver's pending steer/follow-up texts (pi's queue_update — parity #2). Display-only: the
 *  strip above the input; Stop restores them to the editor. null when nothing is queued. */
export interface ComposerQueue { steering: string[]; followUp: string[] }

/** A blocking extension UI dialog awaiting the user (TB-Agent-Composer-Toolkit.md Piece 3) — the head of
 *  the driver's FIFO. The client renders it as a modal and answers via composerUiRespond(id, …). */
export interface ComposerDialogRequest {
  id: string
  method: 'select' | 'confirm' | 'input' | 'editor'
  title?: string
  message?: string
  options?: string[]
  /** A select's current value — the active row opens here instead of row 0. */
  selected?: string
  placeholder?: string
  prefill?: string
}

/** The composer's slice of the poll() response (TB-Agent-Composer.md) — present only when the adapter
 *  implements `createDriver`. Ephemeral display state, never part of the event buffer: `draft` is the
 *  in-flight assistant message accumulated from the driver's stream, replaced by the durable transcript
 *  row once the entry lands on disk (Invariant C1). This is the OWNED-PROCESS channel — the designed
 *  counterpart to the durable `Event` stream (TB-Agent-Harness.md, *The read/write boundary*); grow it
 *  deliberately. */
export interface ComposerPoll {
  streaming: boolean
  draft: { text: string; thinking: string } | null
  status: ComposerStatus | null
  dialog: ComposerDialogRequest | null
  queue: ComposerQueue | null
  stats: ComposerStats | null
  // The driver's configured model id (what the NEXT turn will use) — the pill prefers it over the
  // disk-derived latestModel, so a fresh conversation shows its model before the first turn lands.
  model: string | null
  error?: string
}

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
  // `cost` is THIS entry's harness-computed spend (pi writes usage.cost.total into every assistant
  // entry; CC transcripts carry none) — the client sums it for the driverless session-cost display.
  | { type: 'usage'; in: number; out: number; cached: number; cacheCreate: number; cost?: number }
  // An abandoned (orphaned) branch off a fork point — the agent drops these; the mirror surfaces them
  // as a collapsed stub at the fork parent's position (TB-LostMessage.md). `events` are the orphan's
  // own rendered messages, `count` the user/assistant tally for the stub label, `atId` the fork-point
  // entry id.
  | { type: 'fork'; atId: string; count: number; events: Event[] }
