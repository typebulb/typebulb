// The harness-neutral contract every agent mirror realizes (TB-Harness.md). The neutral engine
// (mirror.ts) tails an on-disk JSONL transcript, walks its parent-linked tree from the newest leaf to
// the root, and renders the live chain — none of which reads a harness-specific field. Everything that
// DOES read one (where the sessions live, the entry schema, the cleaning rules, liveness) is supplied
// by an `AgentAdapter`. Claude Code is the first realization (claude/server/adapter.ts); Pi is the
// second.
//
// The seam between engine and adapter is the `Event` union (core/events.ts) — the neutral stream the
// client also consumes (as `ServerEvent`). The adapter's job is to turn one raw JSONL entry into that
// stream; the engine owns the tree walk, the locks, the poll buffer, and the RPC surface.

import type { Event, SessionFile, TokenCounts } from '../events.js'

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
   * `usage`/`model` only on the live chain (an orphaned branch takes `events` alone), so a dead branch
   * never moves the token chip or the switcher watchdog.
   */
  abstract apply(e: E, sessionStartMs: number): { events: Event[]; usage?: TokenCounts; model?: string }

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
}
