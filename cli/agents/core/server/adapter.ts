// The harness-neutral contract every agent mirror realizes (TB-Agent-Harness.md). The neutral engine
// (mirror.ts) tails an on-disk JSONL transcript, walks its parent-linked tree from the newest leaf to
// the root, and renders the live chain — none of which reads a harness-specific field. Everything that
// DOES read one (where the sessions live, the entry schema, the cleaning rules, liveness) is supplied
// by an `AgentAdapter`. Claude Code is the first realization (claude/server/adapter.ts); Pi is the
// second.
//
// The seam between engine and adapter is the `Event` union (core/events.ts) — the neutral stream the
// client also consumes (as `ServerEvent`). The adapter's job is to turn one raw JSONL entry into that
// stream; the engine owns the tree walk, the locks, the poll buffer, and the RPC surface.

import type { ComposerDialogRequest, ComposerQueue, ComposerStats, ComposerStatus, Event, SessionFile, TokenCounts } from '../events.js'

/**
 * A harness the mirror can drive, through a process the mirror itself spawned and owns
 * (TB-Agent-Composer.md). Optional capability: an adapter that implements `createDriver` gets the
 * composer panel; one that doesn't (Claude Code — the billing footgun) never exposes any of this.
 * The driver never renders conversation: the transcript tail stays the sole render path (Invariant
 * C1); a driver only supplies the ephemeral `draft`/`streaming` that ride the poll response.
 */
export interface AgentDriver {
  /** Route a user message: a fresh prompt when idle, a steer when mid-turn — or, with `followUp`,
   *  queued until the turn ends (Alt+Enter; parity #2). Resolves once the harness accepts/queues
   *  it — not when the turn ends (the tail renders that). */
  send(text: string, opts?: { followUp?: boolean }): Promise<{ ok: boolean; error?: string }>
  /** Abort the in-flight turn (the Stop button). Best-effort; never throws. */
  stop(): Promise<void>
  /** Mid-turn? Authoritative (from the harness's own event stream) — unlike the engine's
   *  file-mtime heuristic, which goes stale during a long single-message stream. */
  readonly streaming: boolean
  /** The partial assistant message accumulated from stream deltas; null when there's nothing to
   *  show. Retained after a message completes until the engine sees its durable row (below). */
  readonly draft: { text: string; thinking: string; tool?: string } | null
  /** The just-sent user prompt, held until its durable row lands (pi flushes entries at
   *  message_end, so the assistant draft would otherwise render before the prompt that caused it).
   *  Ephemeral, rides the poll like `draft`. */
  readonly echo: string | null
  /** Ambient one-line state (TB-Agent-Composer-Toolkit.md Piece 2): a retry/compaction in progress, an
   *  extension notice, joined extension statuses. Ephemeral, rides the poll response like `draft`. */
  readonly status: ComposerStatus | null
  /** Pending steer/follow-up texts (the harness's queue_update; parity #2), null when empty.
   *  Ephemeral, rides the poll response like `status`. */
  readonly queue: ComposerQueue | null
  /** The harness's own session totals (pi's get_session_stats: cost + context usage — parity #5),
   *  refreshed at turn/compaction end. null until first fetched. Ephemeral, rides the poll. */
  readonly stats: ComposerStats | null
  /** The harness's currently CONFIGURED model id (pi's get_state at boot, set_model responses) —
   *  what the next turn will use, unlike the disk-derived latestModel (last turn's resolution).
   *  null until first fetched. Ephemeral, rides the poll. */
  readonly model: string | null
  /** The oldest unanswered blocking extension dialog (Piece 3), or null. Reading it may expire
   *  stale requests (the poll is the expiry clock — deliberate, see the toolkit spec's gotchas). */
  readonly dialog: ComposerDialogRequest | null
  /** Answer (or cancel) a pending dialog by id. Unknown/expired ids are a soft error. */
  respondUi(id: string, resp: { value?: string; confirmed?: boolean; cancelled?: boolean }): { ok: boolean; error?: string }
  /** Forward one allowlisted harness command (TB-Agent-Composer-Toolkit.md Piece 4). The allowlist is the
   *  driver's own — never `prompt`/`steer`/`follow_up` (messages go through `send`, the one door). */
  rpc(cmd: { type: string } & Record<string, unknown>): Promise<{ ok: boolean; data?: unknown; error?: string }>
  /** The session file this driver is appending to. Undefined until resolved (a driver spawned
   *  sessionless creates its file on boot); the engine attaches to it once it appears. */
  readonly sessionFile: string | undefined
  /** Fatal driver error (spawn failure, process death), surfaced in the panel. A driver with an
   *  error is dead — the engine disposes and replaces it on the next send. */
  readonly error: string | undefined
  /** Drop a COMPLETED draft (no message currently streaming into it). The engine calls this when
   *  the drain emits a live-chain assistant event — the durable row has arrived, so the ephemeral
   *  bubble hands off without a gap. A draft mid-accumulation is kept. */
  clearCompletedDraft(): void
  /** Drop the echoed prompt — the same handoff, user side: called when the drain emits a
   *  live-chain user event. */
  clearEcho(): void
  /** Kill the owned process (abort first if streaming, brief grace, then kill). Idempotent. */
  dispose(): Promise<void>
}

/**
 * The contract a coding agent's transcript format realizes so the neutral mirror engine can render it.
 * `E` is the adapter's parsed-entry type (CC's JsonlEntry, Pi's session entry): the adapter produces it
 * from a line via `parseEntry`, and the engine stores `Map<id, E>` and walks the tree purely through
 * `idOf`/`parentOf`, never inspecting E's shape itself — the one seam that lets a new agent land as a
 * single adapter file. The methods the engine calls on the leaf scan / fork walk must be cheap and
 * pure; the filesystem ones (`listSessionFiles`, `readPreview`, `sessionAlive`) run per poll / per menu.
 */
export abstract class AgentAdapter<E = unknown> {
  /** Tab title + the mirror's display name ("Claude Mirror" / "Pi Mirror"). */
  abstract readonly displayName: string

  /**
   * Is the CURRENT process running under this harness? Read from `process.env`: a coding agent sets a
   * marker its subprocesses inherit (CC `CLAUDECODE=1`, pi `PI_CODING_AGENT=true`), so a `typebulb
   * agent` the agent runs in a turn inherits it. Bare `typebulb agent` uses this to mirror the *calling*
   * harness instead of a hardcoded default (resolveAgent, agentViewer/resolve.ts); a human in a plain
   * terminal sets none, so every adapter returns false and resolution falls through to the disk signal.
   * Markers are mutually exclusive in practice, and this must be a cheap, pure env read — no I/O.
   */
  abstract detectsSelf(): boolean

  /**
   * Is this harness installed on the MACHINE, regardless of whether it has touched this project?
   * The signal is the harness's home dir (CC `~/.claude/`, pi `~/.pi/agent/`) — created on the
   * harness's first run anywhere, so a pure `existsSync`, no PATH scan, no process spawn. Bare
   * `typebulb agent` resolves the harness off THIS (resolveAgent): installed is the full claim set
   * (sessions ⊂ installed), so two installed harnesses always make the picker and per-cwd sessions
   * only order it. A harness installed but unused HERE is therefore still offered — the fix for a
   * folder with claude history but no pi turns silently launching claude. Misses "installed via npm
   * but never launched once" by design (the dir appears on first launch); that window closes itself.
   */
  abstract detectsInstalled(): boolean

  // ── CLI-side harness integration (called from agentViewer/resolve.ts, not the mirror engine — the
  //    same src→adapter direction detectsSelf uses) ──
  /**
   * Install whatever CLI-side support this harness needs. The default is a no-op — Claude Code's
   * case (`run_in_background` is native, and the skill stays emit-only per TB-Skill.md). Pi
   * overrides it: the background-`wait` shim extension (TB-Wait.md — pi has no background bash),
   * and the bulb-authoring skill into pi's global skills dir (TB-Skill.md's scoped pi exception —
   * a composer-driven session has no cold-start command to learn from). Runs on the CLI hot path,
   * so an override MUST be idempotent, gated (write nothing if the harness isn't present), and
   * never throw.
   */
  ensureHarnessSupport(): void {}

  // ── discovery: where this agent stores the mirrored project's transcripts ──
  /** The directory holding `cwd`'s session files (e.g. `~/.claude/projects/<sanitized>/`). */
  abstract sessionsDir(cwd: string): string
  /** The `*.jsonl` session files under `sessionsDir(cwd)`, each with its id + mtime. */
  abstract listSessionFiles(cwd: string): SessionFile[]

  // ── tree schema: the engine walks the parent-linked tree through these, never a literal field ──
  /** Parse one JSONL line into a typed entry, or null to drop it (a JSON error, a header, a line with
   *  no node id). The engine calls this for every line; everything downstream sees only `E`. */
  abstract parseEntry(line: string): E | null
  /** The entry's own node id (CC `uuid` / Pi `id`); undefined for a non-tree line. */
  abstract idOf(e: E): string | undefined
  /** The entry's parent id (CC `parentUuid` / Pi `parentId`); undefined at the root. */
  abstract parentOf(e: E): string | undefined
  /** The entry's ISO timestamp (used to order an orphan branch chronologically). */
  abstract timestampOf(e: E): string | undefined
  /** A sub-agent / sidechain thread, excluded from the live-chain leaf and from fork surfacing. */
  abstract isSidechain(e: E): boolean
  /** A conversational turn — the candidate set for the live-chain leaf. */
  abstract isLeafType(e: E): boolean
  /** Error-recovery noise dropped from an orphaned branch (CC `isApiErrorMessage`; Pi: none). */
  abstract isRecoveryNoise(e: E): boolean

  // ── entry → neutral events ──
  /**
   * Render one entry: its display-cleaned `events` (user/assistant/tool_result), plus — for an
   * assistant turn — the `usage` (the current window) and `model`. `sessionStartMs` is the engine's
   * one clock, used to set the assistant event's `live` flag (fresh-this-session edits) on both the
   * live chain and an orphan branch. A hidden/noise entry returns `{ events: [] }`. The engine applies
   * `usage`/`model`/`cost` only on the live chain (an orphaned branch takes `events` alone), so a dead
   * branch never moves the token chip or the switcher watchdog. `cost` is the entry's harness-computed
   * spend (pi's usage.cost.total; CC has none) — never a mirror-side calculation.
   */
  abstract apply(e: E, sessionStartMs: number): { events: Event[]; usage?: TokenCounts; model?: string; cost?: number }

  // ── status ──
  /**
   * Is the agent mid-turn? Judged from the chain shape (unresolved leaf). `entries` is the
   * file-ordered entry array — a re-iterable array, NOT a one-shot iterator, because an adapter
   * typically scans it more than once (find the leaf, then collect resolved tool results).
   */
  abstract chainWorking(entries: E[]): boolean
  /** Is the session's owning process alive? `undefined` ⇒ unknowable from disk (engine falls back). */
  abstract sessionAlive(sessionId: string, cwd: string): boolean | undefined

  // ── picker + search ──
  /** The session's dropdown title/preview (harness-specific precedence). */
  abstract readPreview(file: string): string
  /** The display-cleaned searchable text of one entry (user/assistant), or '' to skip it. */
  abstract searchText(e: E): string

  // ── driving (optional capability — TB-Agent-Composer.md) ──
  /**
   * Create a driver bound to `sessionFile` (undefined ⇒ the harness starts a new session in `cwd`).
   * Absent ⇒ this harness has no composer: the RPCs error, the panel never renders. The engine owns
   * the lifecycle — one driver per conversation, pinned to its session at spawn, reaped when idle
   * and not viewed (TB-Agent-Composer.md C2); the adapter only supplies the transport.
   */
  createDriver?(cwd: string, sessionFile: string | undefined): AgentDriver

  /**
   * List `cwd`'s files for the composer's @-mention corpus when it isn't a git repo — the way this
   * harness's own picker would (pi: fd). Relative forward-slash paths, unsorted (the engine owns
   * the mtime ranking); null ⇒ walker unavailable. Optional, composer-only like `createDriver`.
   */
  walkFiles?(cwd: string): Promise<string[] | null>
}
