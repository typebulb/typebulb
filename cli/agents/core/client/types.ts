import type { VElement } from 'domeleon'
import type { CopyButton } from './copyButton.js'
import type { BulbEmbed } from './bulbEmbed.js'
// The poll() event union + token shape are the server↔client wire contract — one canonical definition
// in core/events.ts (no more "keep in sync" copy). `ServerEvent` is the client's name for `Event`.
import type { ComposerDialogRequest, ComposerPoll, ComposerQueue, ComposerStats, ComposerStatus, Event as ServerEvent, TokenCounts } from '../events.js'
export type { ComposerDialogRequest, ComposerPoll, ComposerQueue, ComposerStats, ComposerStatus, ServerEvent, TokenCounts }

// An agent-specific status-bar pill injected into the neutral Root (e.g. Claude's model switcher).
// Root renders `view()` in its status bar — which wires the pill's `ctx.parent` to Root (IRoot), the
// same as a hard-coded field — and calls `close()` when another popup opens. Kept structural so the
// neutral client never imports a concrete agent pill.
export interface StatusPillLike {
  view(): VElement
  close?(): void
}

// The harness-specific configuration the agent's client entry passes to the neutral Root. Everything
// that differs per agent (the tab title, the extra pills, any overlay banners, a per-poll hook) lives
// here, so Root itself carries no Claude/Pi knowledge. Claude supplies its ModelPill as a pill, the
// switcher watchdog as an overlay, and `modelPill.tickState` as onPollTick; Pi supplies none of these.
export interface RootConfig {
  title: string
  pills: StatusPillLike[]
  overlays?: (() => VElement | null)[]
  onPollTick?: () => void
  // The prompt panel, only for a harness whose adapter implements createDriver (TB-Agent-Composer.md):
  // pi passes one, Claude passes none. Root hoists it to a direct field (domeleon child discovery —
  // same invariant as `pills`).
  composer?: ComposerLike
}

// Structural twin of StatusPillLike for the composer, so the neutral Root/types never import the
// concrete component. `enabled` mirrors info().composer; `syncFromPoll` returns "visibly changed".
export interface ComposerLike {
  enabled: boolean
  view(): VElement
  syncFromPoll(c: ComposerPoll): boolean
}

// A dialog's answer — the wire shape composerUiRespond takes, and what a recipe primitive resolves
// with (TB-Agent-Composer-Toolkit.md Piece 3).
export interface DialogResponse { value?: string; confirmed?: boolean; cancelled?: boolean }

// The palette's recipe contract (TB-Agent-Composer-Toolkit.md Piece 5). The interpreter + primitives are
// neutral (Composer); the TABLE is the harness's (pi supplies agents/pi/client/recipes.ts via the
// Composer constructor — the same neutral-shell/harness-config split as RootConfig.pills). A recipe
// only sequences allowlisted RPCs and dialogs (T4); anything durable renders from the tail.
export interface RecipeCtx {
  /** composerRpc with spawn:true — a palette pick is the user gesture that may create the driver. */
  rpc(cmd: { type: string } & Record<string, unknown>): Promise<{ ok: boolean; data?: unknown; error?: string }>
  /** Modal pick from a list; `selected` preselects the current value's row; null = cancelled. */
  select(title: string, options: string[], selected?: string): Promise<string | null>
  /** Modal one-line text; null = cancelled ('' is a real answer). */
  input(title: string, placeholder?: string, prefill?: string): Promise<string | null>
  confirm(title: string, message?: string): Promise<boolean>
  /** Put text in the composer editor (fork's restored prompt). */
  setInput(text: string): void
  /** Re-fetch the session list (re-runs readPreview server-side) and re-render — a recipe that
   *  changes session metadata (e.g. /name) uses it so the pill/title/picker update without a reopen. */
  refreshSessions(): void
}
// `hidden` keeps a row out of the palette listing (its only entry point) while the code stays —
// for shipped-but-not-yet-live-verified commands; it still shadows a same-named pass-through row.
export interface ComposerRecipe { name: string; description: string; hidden?: boolean; run(ctx: RecipeCtx): Promise<string | void> }

// The slice of MessageList the status-bar pills reach through IRoot. Declared here so the pills never
// import the concrete component (which would re-introduce a child→host cycle).
export interface IMessageList {
  stickToBottomNextRender(): void
}

// The host surface the child components (status pills, message list) talk to. Root implements it; the
// children type their `parent` as IRoot so nothing under client/ imports root.js — the whole point is
// to keep the dependency graph acyclic, with types.ts as the shared contract.
export interface IRoot {
  ready: boolean
  cwd: string
  // null = no session event yet (boot moment, or a project with no sessions); '' = deliberately
  // attached to nothing (the composer's "+ new conversation" blank state, mirror.ts detachToBlank).
  // The session pill hides only on null — in the blank state the menu is the way back.
  sessionId: string | null
  ownPid: number
  prose: boolean
  working: boolean
  // The model the last assistant turn resolved to (from poll) — the agent switcher's live watchdog
  // reads it to catch an Anthropic model riding the OpenRouter route (TB-Agent-Switcher.md L1).
  latestModel: string | null
  // The driver's CONFIGURED model (poll composer.model) — what the next turn will use. The pi model
  // pill prefers it over latestModel so a fresh conversation isn't pill-less until its first turn.
  // null when not driving (foreign session, Claude mirror).
  driverModel: string | null
  // Sessions with a driven turn currently streaming (poll's `busy`) — the one cross-conversation
  // signal (TB-Agent-Composer.md C4); the session picker badges these rows with the working shimmer.
  busy: string[]
  // The composer driver's in-flight assistant message (poll's composer.draft) — rendered by
  // MessageList as one ephemeral bubble after the transcript, replaced by the durable row when the
  // entry lands on disk (TB-Agent-Composer.md, Invariant C1). null when idle or no composer.
  draft: { text: string; thinking: string; tool?: string } | null
  // The just-sent user prompt awaiting its durable row (poll composer.echo) — rendered as an
  // ephemeral user bubble above the draft; null when idle or landed.
  echo: string | null
  tokens: TokenCounts
  // Session cost so far: the sum of the usage events' per-entry harness-computed costs (pi writes
  // usage.cost.total; CC writes none, so this stays 0 there). Reset by `cleared` like tokens.
  cost: number
  // The harness's own live totals from the driver (poll composer.stats) — preferred by the token
  // chip over tokens/cost when present; null when not driving (foreign session, Claude mirror).
  stats: ComposerStats | null
  messageList: IMessageList
  closePopups(except?: unknown): void
  updateTitle(): void
  // Re-fetch the session list and re-render; the session pill/tab title read from that fetched data,
  // so a metadata change (e.g. a /name recipe) needs this to show without reopening the picker.
  refreshSessions(): void
}


// `digest` is the tool_result event's one-line OUT summary ("463 lines", "2 files"), shown as the
// collapsed row's indented ⎿ line once the result lands.
export interface Tool { id: string; name: string; input: Record<string, unknown>; result?: string; isError: boolean; digest?: string }
// `segments` is set only when consecutive user sends are merged into one bubble. `body` is set
// only when an assistant message contains live ````bulb```` embeds: the text split into markdown
// chunks (string) and BulbEmbed components, rendered in order in place of the single markdown div.
// `turnCopy` is the prose-mode copy shared across a turn's assistant messages — one pill over the
// joined turn prose, rendered on the turn's last prose bubble (see MessageList.renderTurn).
// `fork` is set only on a `role: 'fork'` pseudo-message — a collapsed stub for an abandoned branch
// (TB-LostMessage.md); `sub` are the orphan's own (read-only) messages, rendered when the stub is open.
export interface Msg { id: number; role: 'user' | 'assistant' | 'fork'; text: string; thinking: string; tools: Tool[]; copy?: CopyButton; turnCopy?: CopyButton; segments?: string[]; body?: (string | BulbEmbed)[]; fork?: { count: number; sub: Msg[] } }

export interface RunningServer { pid: number; port: number; url: string; file: string; startedAt: number; trust?: boolean; batch?: string; predicted?: string; denied?: string }
// `batches` = the bulb's named batch scopes (TB-Batch.md), newest first — what the stopped row's
// scope picker lists; empty/absent for the common batch-less bulb. `lastRunAt` = the port block's
// launch time for this bulb (0 when never run) — the use half of the launcher's MRU.
export interface BulbFile { path: string; name: string; mtime: number; lastRunAt?: number; trusted?: boolean; batches?: string[] }
// A typebulb.com remote bulb (tb.server.listSamples / listMyBulbs): a muted launcher row while no
// local file exists — play pulls it to typebulbs/u/<user>/ and launches (server launcher.ts).
export interface RemoteBulb { slug: string; name: string; description: string }
// One full-text hit over a project bulb file (searchBulbs), joined onto its BulbRow for display.
export interface BulbHit { path: string; hitCount: number; snippet: string }
// One launcher row: a project bulb and/or a running server, merged by path. `running`
// present ⇒ live (open link + stop); absent ⇒ stopped (launch). `recent` = MRU sort key.
// `trusted` = a remembered trust decision (applies to the next launch). `hitCount`/`snippet`
// are the full-text decoration, set only on search-mode rows. `remote` = a remote bulb not yet
// pulled (its `path` is the project-relative path the pull will land at — the owner rides in the
// path, TB-Push-Pull.md Invariant 4). `group` = a catalog fold header (one per remote owner slug,
// folding `count` rows), a synthetic row with no bulb behind it.
export interface BulbRow { path: string; name: string; recent: number; trusted?: boolean; batches?: string[]; running?: RunningServer; hitCount?: number; snippet?: string; remote?: RemoteBulb; group?: { user: string; count: number } }
