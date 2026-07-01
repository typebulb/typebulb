import { listAgentNames } from './registry.js'
import type { AgentAdapter } from '../../agents/core/server/adapter.js'
import { ClaudeAdapter } from '../../agents/claude/server/adapter.js'
import { PiAdapter } from '../../agents/pi/server/adapter.js'

/**
 * Which harness bare `typebulb agent` should mirror (TB-Skill.md, TB-Harness.md). Historically bare
 * `agent` hardcoded `claude`; with a second harness (pi) that silently mirrored the wrong agent. This
 * resolves the harness instead — restoring the symmetry of the single universal instruction "run
 * `npx typebulb agent`", which now does the right thing under whichever harness invoked it.
 *
 * Per-agent adapter constructors. Constructing an adapter is side-effect free, so the resolver can read
 * a harness's env marker + session dir WITHOUT importing its server *barrel* (which would boot the
 * Claude switcher on import — TB-Agent-Switcher.md). Static imports, like AGENT_SERVERS in serve.ts:
 * adding a harness adds an entry here too (TB-Harness.md "Adding a harness").
 */
const AGENT_ADAPTERS: Record<string, () => AgentAdapter> = {
  claude: () => new ClaudeAdapter(),
  pi: () => new PiAdapter(),
}

/**
 * Install every harness's CLI-side `wait`-support through the adapter contract (pi's background-wait
 * shim; harnesses that need none inherit the no-op default). Called on every CLI invocation — the
 * adapter guarantees each call is idempotent, gated, and non-throwing; the extra try/catch guards
 * construction. This is the ONLY way the CLI reaches harness `wait` behaviour — through `AgentAdapter`,
 * never a direct `agents/<name>` import (the boundary the adapter exists to manage, like `detectsSelf`).
 */
export function ensureHarnessWaitSupport(): void {
  for (const make of Object.values(AGENT_ADAPTERS)) {
    try { make().ensureWaitSupport() } catch {}
  }
}

/** The harness the CURRENT process is running under — read from its env marker via each adapter's
 *  `detectsSelf` (CC `CLAUDECODE`, pi `PI_CODING_AGENT`), or undefined for an unmarked caller (a human
 *  terminal). This is an agent's OWN identity, so `wait`/`logs agent` can resolve *this* agent's mirror
 *  deterministically — (caller-harness, cwd) is a unique mirror (Inv. 2) — instead of guessing among the
 *  mirrors in a cwd when more than one harness runs there (a Claude wait must never watch the pi log). */
export function detectCallerHarness(): string | undefined {
  for (const name of Object.keys(AGENT_ADAPTERS)) {
    try { if (AGENT_ADAPTERS[name]().detectsSelf()) return name } catch {}
  }
  return undefined
}

/** Launch/reuse the `{ name }` mirror, or `{ ambiguous }`: multiple harnesses have sessions and there's
 *  no other signal, so the user must pick (`agent:claude` / `agent:pi`). */
export type AgentChoice = { name: string } | { ambiguous: string[] }

/**
 * Resolve the harness for bare `typebulb agent`, first hit wins:
 *
 *  1. **Caller identity** — the process that ran `typebulb agent` inherited its harness's env marker
 *     (`detectsSelf`). This is the agent path; a human in a terminal sets no marker and falls through.
 *  2. **Disk signal** — harnesses with sessions under this cwd: exactly one → it; none → the canonical
 *     default (nothing to show and no preference expressed, so don't nag); two or more → ambiguous,
 *     ask the user. All pure parse / `statSync`, no inference (Invariant 1).
 *
 * A live mirror already serving this cwd is deliberately NOT a resolution signal: reusing whatever
 * harness happens to be showing silently skipped the picker when a human had sessions for both, which
 * read as the command ignoring them. Dedup still happens — `launchAgentViewer` reuses a running mirror
 * for the *resolved* harness (TB-Agent-Mirror.md Invariant 2) — it just no longer decides *which*.
 */
export function resolveAgent(cwd: string): AgentChoice {
  const names = listAgentNames()
  const adapters = new Map(names.filter(n => AGENT_ADAPTERS[n]).map(n => [n, AGENT_ADAPTERS[n]()]))

  // 1. Caller is a harness.
  for (const [name, adapter] of adapters) {
    if (adapter.detectsSelf()) return { name }
  }

  // 2. Which harnesses have sessions here.
  const withSessions = [...adapters].filter(([, a]) => a.listSessionFiles(cwd).length > 0).map(([n]) => n)
  if (withSessions.length === 1) return { name: withSessions[0] }
  if (withSessions.length === 0) return { name: names[0] }   // canonical default (first registered)
  return { ambiguous: withSessions }
}
