/**
 * The single registry of reserved agent mirrors the CLI can launch via `agent:<name>`.
 *
 * An agent mirror is a browser view over a coding-agent's session — it tails the on-disk
 * transcript and renders the bulbs the agent emits inline. Its code lives under `agents/<name>/`
 * (TB-Agent-Mirror.md). `claude` is the canonical agent; `pi` the second.
 *
 * Each entry pairs the two harness-specific factories the rest of the CLI needs:
 *   - `adapter` — construct the harness's `AgentAdapter`. Side-effect free, so `resolve.ts` can read
 *     a harness's env marker / session dir without loading its server barrel (importing the barrel
 *     boots the Claude switcher — TB-Agent-Switcher.md).
 *   - `server`  — lazily import the harness's server barrel (its RPC surface), the module `serve.ts`
 *     hands to `startServer`. A *static* `import()` literal so esbuild inlines it into `dist/index.js`
 *     (a `import(variable)` would not bundle); the thunk defers the barrel's boot side-effects until
 *     a mirror actually launches.
 *
 * Adding a harness is one entry here plus its `agents/<name>/` code (adapter + server barrel + client
 * entry) — `resolve.ts` and `serve.ts` read this map, so neither needs a parallel edit.
 */
import type { AgentAdapter } from '../../agents/core/server/adapter.js'
import { ClaudeAdapter } from '../../agents/claude/server/adapter.js'
import { PiAdapter } from '../../agents/pi/server/adapter.js'
import { CodexAdapter } from '../../agents/codex/server/adapter.js'

interface AgentRegistration {
  adapter: () => AgentAdapter
  server: () => Promise<Record<string, unknown>>
}

const AGENTS: Record<string, AgentRegistration> = {
  claude: { adapter: () => new ClaudeAdapter(), server: () => import('../../agents/claude/server.js') },
  pi: { adapter: () => new PiAdapter(), server: () => import('../../agents/pi/server.js') },
  codex: { adapter: () => new CodexAdapter(), server: () => import('../../agents/codex/server.js') },
}

/** Is `name` a reserved agent the CLI can launch (`agent:<name>`)? */
export function isKnownAgent(name: string): boolean {
  return name in AGENTS
}

/** Every reserved agent name, in registration order — for the `agent:<name>` help, the unknown-agent
 *  error, and harness resolution (the first registered is the canonical default). */
export function listAgentNames(): string[] {
  return Object.keys(AGENTS)
}

/** The per-agent adapter constructors, keyed by name. Constructing an adapter is side-effect free
 *  (no barrel load), so `resolve.ts` uses these for the env-marker / session-dir reads that back
 *  bare `typebulb agent`'s harness resolution and `ensureHarnessSupport`. */
export function agentAdapterFactories(): Record<string, () => AgentAdapter> {
  return Object.fromEntries(Object.entries(AGENTS).map(([name, reg]) => [name, reg.adapter]))
}

/** Lazily load `name`'s server barrel — its RPC surface plus a `displayName` const. Caller has
 *  already validated `name` via `isKnownAgent` (serve.ts). */
export function loadAgentServer(name: string): Promise<Record<string, unknown>> {
  return AGENTS[name].server()
}
