import type { CopyButton } from './copyButton.js'
import type { BulbEmbed } from './bulbEmbed.js'

export interface TokenCounts { in: number; out: number; cached: number; cacheCreate: number }

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
  tokens: TokenCounts
  messageList: IMessageList
  closePopups(except?: unknown): void
  updateTitle(): void
}

// Mirror of the server's Event union (the RPC boundary is untyped). Keep in sync.
export type ServerEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'user'; text: string }
  | { type: 'assistant'; text: string; thinking: string; tools: { id: string; name: string; input: Record<string, unknown> }[]; live: boolean }
  | { type: 'tool_result'; id: string; content: string; isError: boolean }
  | { type: 'cleared' }
  | { type: 'usage'; in: number; out: number; cached: number; cacheCreate: number }

export interface Tool { id: string; name: string; input: Record<string, unknown>; result?: string; isError: boolean }
// `segments` is set only when consecutive user sends are merged into one bubble. `body` is set
// only when an assistant message contains live ````bulb```` embeds: the text split into markdown
// chunks (string) and BulbEmbed components, rendered in order in place of the single markdown div.
export interface Msg { id: number; role: 'user' | 'assistant'; text: string; thinking: string; tools: Tool[]; copy?: CopyButton; segments?: string[]; body?: (string | BulbEmbed)[] }

export interface RunningServer { pid: number; port: number; url: string; file: string; startedAt: number; trust?: boolean; predicted?: string; denied?: string }
export interface BulbFile { path: string; name: string; mtime: number; trusted?: boolean }
// One full-text hit over a project bulb file (searchBulbs), joined onto its BulbRow for display.
export interface BulbHit { path: string; hitCount: number; snippet: string }
// One launcher row: a project bulb and/or a running server, merged by path. `running`
// present ⇒ live (open link + stop); absent ⇒ stopped (launch). `recent` = MRU sort key.
// `trusted` = a remembered trust decision (applies to the next launch). `hitCount`/`snippet`
// are the full-text decoration, set only on search-mode rows.
export interface BulbRow { path: string; name: string; recent: number; trusted?: boolean; running?: RunningServer; hitCount?: number; snippet?: string }
