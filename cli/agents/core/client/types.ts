import type { VElement } from 'domeleon'
import type { CopyButton } from './copyButton.js'
import type { BulbEmbed } from './bulbEmbed.js'
// The poll() event union + token shape are the server↔client wire contract — one canonical definition
// in core/events.ts (no more "keep in sync" copy). `ServerEvent` is the client's name for `Event`.
import type { Event as ServerEvent, TokenCounts } from '../events.js'
export type { ServerEvent, TokenCounts }

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
}

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
  sessionId: string
  ownPid: number
  prose: boolean
  working: boolean
  // The model the last assistant turn resolved to (from poll) — the agent switcher's live watchdog
  // reads it to catch an Anthropic model riding the OpenRouter route (TB-Agent-Switcher.md L1).
  latestModel: string | null
  tokens: TokenCounts
  messageList: IMessageList
  closePopups(except?: unknown): void
  updateTitle(): void
}


export interface Tool { id: string; name: string; input: Record<string, unknown>; result?: string; isError: boolean }
// `segments` is set only when consecutive user sends are merged into one bubble. `body` is set
// only when an assistant message contains live ````bulb```` embeds: the text split into markdown
// chunks (string) and BulbEmbed components, rendered in order in place of the single markdown div.
// `turnCopy` is the prose-mode copy shared across a turn's assistant messages — one pill over the
// joined turn prose, rendered on the turn's last prose bubble (see MessageList.renderTurn).
// `fork` is set only on a `role: 'fork'` pseudo-message — a collapsed stub for an abandoned branch
// (TB-LostMessage.md); `sub` are the orphan's own (read-only) messages, rendered when the stub is open.
export interface Msg { id: number; role: 'user' | 'assistant' | 'fork'; text: string; thinking: string; tools: Tool[]; copy?: CopyButton; turnCopy?: CopyButton; segments?: string[]; body?: (string | BulbEmbed)[]; fork?: { count: number; sub: Msg[] } }

export interface RunningServer { pid: number; port: number; url: string; file: string; startedAt: number; trust?: boolean; predicted?: string; denied?: string }
export interface BulbFile { path: string; name: string; mtime: number; trusted?: boolean }
// One full-text hit over a project bulb file (searchBulbs), joined onto its BulbRow for display.
export interface BulbHit { path: string; hitCount: number; snippet: string }
// One launcher row: a project bulb and/or a running server, merged by path. `running`
// present ⇒ live (open link + stop); absent ⇒ stopped (launch). `recent` = MRU sort key.
// `trusted` = a remembered trust decision (applies to the next launch). `hitCount`/`snippet`
// are the full-text decoration, set only on search-mode rows.
export interface BulbRow { path: string; name: string; recent: number; trusted?: boolean; running?: RunningServer; hitCount?: number; snippet?: string }
