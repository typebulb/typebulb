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

/** One row of the session picker, from `listSessions` or `searchSessions` — one shape rather than two,
 *  because the menu joins both into a single list and a row's origin is readable from which optional
 *  fields it carries. */
export interface SessionRow {
  sessionId: string
  mtime: number
  preview: string
  /** A conversation this mirror owns whose file the harness hasn't written yet: listed so a turn left
   *  running is reachable, but with no transcript to peek, search or name (TB-Agent-Composer.md C7). */
  pending?: boolean
  /** Is this session mid-turn RIGHT NOW, per the harness's own report (`adapter.sessionsWorking`)?
   *  `undefined` ⇒ the harness can't say, and the row shows no working cue rather than a wrong one.
   *  Deliberately not "the process is alive", which is true of every window left open
   *  (TB-Agent-Mirror-Ready.md). */
  working?: boolean
  /** The full-text decoration, set only on a search result. */
  hitCount?: number
  snippet?: string
  /** Set when the hit is inside a session's CHILD transcript (TB-Agent-Children.md): an indented row
   *  under its parent's, opened by attaching the parent and then swapping. */
  child?: { id: string; kind?: string; depth: number }
}

/** Which thread of a transcript a view renders (TB-Agent-Children.md). A child transcript is its own
 *  file, so the adapter's off-thread test inverts inside one; the engine passes this and reads no
 *  harness field of its own. */
export type Thread = 'main' | 'child'

/** One child transcript of a session — a conversation the session spawned and the mirror can swap
 *  into (TB-Agent-Children.md). Claude's sub-agents are the only realization today; the record is
 *  neutral, so `core/` says child where the adapter and the UI say agent. */
export interface ChildTranscript {
  id: string                 // stable within the session (CC: the agentId)
  file: string
  mtime: number
  started?: number           // when it began (ms epoch; CC: the file's birth, which is the spawn)
  tokens?: number            // its context window as of its last response, where the harness reads one
  label: string              // the caller's one-line description; '' when the harness records none
  kind?: string              // the child's own type, only where it says more than "agent": CC omits
                             // general-purpose, the type every plain Agent call gets, as `model`
                             // omits the session's own
  model?: string             // set only where the caller overrode the session's model
  spawnId?: string           // the parent tool call that spawned it (CC: toolUseId)
  parentId?: string          // the child that spawned it, above depth 1
  depth: number              // 1 = spawned by the session itself
  stopped: boolean           // the user killed it — the one terminal state only the harness knows
  /** The harness's OWN answer to whether this child is still working, when it has one: Codex writes
   *  its turn boundaries into the child's own file, so its tail says outright
   *  (TB-Agent-Children-Codex.md). `undefined` leaves the question to the engine's settlement scan,
   *  which is CC's shape — there a child's tail cannot tell a finished run from one stalled
   *  mid-flush, so only the parent's record of the spawn can answer. */
  running?: boolean
}

/** A `ChildTranscript` as the client sees it: the engine adds the state it alone can decide, since
 *  "finished" is the parent holding a tool result for `spawnId` (TB-Agent-Children.md). */
export interface ChildRow extends ChildTranscript { state: 'running' | 'done' | 'stopped' }

/** What one entry says about a spawn (TB-Agent-Children.md): the child it names has stopped, or has
 *  been woken again. Read from the parent's transcript and each child's own, since a child can wake
 *  itself. `at` orders them: a harness may write an old stop after a newer
 *  wake (CC delivers a queued notification at the turn's end, stamped with its enqueue time), so the
 *  latest by time wins, never the latest by file position. */
export interface SpawnSignal { id: string; stopped: boolean; at: number }

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
  // The in-flight turn belongs to a process the mirror does NOT own (a terminal pi), so the composer
  // is watch-only: driving now would fork that turn. Server-decided, because only the mirror knows
  // which conversations it holds a driver for.
  foreign: boolean
  // `tool` names a streaming toolCall block — the live tail the text/thinking fields can't show.
  draft: { text: string; thinking: string; tool?: string } | null
  // The just-sent user prompt awaiting its durable row — an ephemeral user bubble above the draft
  // (pi flushes the user entry at message_end, seconds into a long turn).
  echo: string | null
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
  // `agent` marks a turn the harness delivered on a sub-agent's behalf rather than one the user
  // typed: `from` is the child's id (TB-Agent-Children.md), so the mirror frames it and links to
  // that transcript. Its text is the report alone, the envelope already reduced away by the adapter.
  | { type: 'user'; text: string; agent?: { from: string } }
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
