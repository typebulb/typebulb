import { listAgentNames, agentAdapterFactories } from './registry.js'

/**
 * Which harness bare `typebulb agent` should mirror (TB-Skill.md, TB-Agent-Harness.md). Historically bare
 * `agent` hardcoded `claude`; with a second harness (pi) that silently mirrored the wrong agent. This
 * resolves the harness instead — restoring the symmetry of the single universal instruction "run
 * `npx typebulb agent`", which now does the right thing under whichever harness invoked it.
 *
 * Per-agent adapter constructors, sourced from the one harness registry (registry.ts). Constructing an
 * adapter is side-effect free, so the resolver can read a harness's env marker + session dir WITHOUT
 * importing its server *barrel* (which would boot the Claude switcher on import — TB-Agent-Switcher.md).
 * Reading the shared map here is what lets adding a harness be a single registry entry
 * (TB-Agent-Harness.md "Adding a harness").
 */
const AGENT_ADAPTERS = agentAdapterFactories()

/**
 * Install every harness's CLI-side support through the adapter contract (pi's background-wait shim
 * and bulb-authoring skill; harnesses that need none inherit the no-op default). Called on every CLI
 * invocation — the
 * adapter guarantees each call is idempotent, gated, and non-throwing; the extra try/catch guards
 * construction. This is the ONLY way the CLI reaches harness-support behaviour — through `AgentAdapter`,
 * never a direct `agents/<name>` import (the boundary the adapter exists to manage, like `detectsSelf`).
 */
export function ensureHarnessSupport(): void {
  for (const make of Object.values(AGENT_ADAPTERS)) {
    try { make().ensureHarnessSupport() } catch {}
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

/** Launch/reuse the `{ name }` mirror, or `{ ambiguous }`: more than one harness is installed and the
 *  caller is a human, so the user must pick (`agent:claude` / `agent:codex` / `agent:pi`). The order is the picker's
 *  order — this cwd's active harness first (the Enter default). */
export type AgentChoice = { name: string } | { ambiguous: string[] }

/**
 * Resolve the harness for bare `typebulb agent`, first hit wins:
 *
 *  1. **Caller identity** — the process that ran `typebulb agent` inherited its harness's env marker
 *     (`detectsSelf`). This is the agent path; a human in a terminal sets no marker and falls through.
 *  2. **Machine signal** — which harnesses are *installed* on the machine (`detectsInstalled` — the
 *     harness home dir): none → the canonical default; exactly one → it; two or more → ambiguous, ask
 *     the user. Installed is the full claim set: a harness can't have sessions without being installed
 *     (sessions live under its home dir), so gating on per-cwd sessions only ever *narrowed* this — and
 *     that was the bug (a folder with claude history but no pi turns silently launched claude and never
 *     offered installed-but-unused-here pi). Per-cwd sessions now only **order** the picker, never gate
 *     it (below). All pure env reads / fs stats, no inference (Invariant 1).
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

  // 2. Which harnesses are installed on the machine (sessions ⊂ installed, so this is the full claim set).
  const installed = [...adapters].filter(([, a]) => a.detectsInstalled()).map(([n]) => n)
  if (installed.length === 0) return { name: names[0] }   // canonical default (first registered)
  if (installed.length === 1) return { name: installed[0] }

  // Two or more installed → the user picks. Order by local session presence so this cwd's active
  // harness is the default (first), without ever hiding an installed-but-unused-here one. sort() is
  // stable, so a tie (both or neither have sessions) keeps registry order.
  const hasSessions = (n: string) => adapters.get(n)!.listSessionFiles(cwd).length > 0
  return { ambiguous: [...installed].sort((a, b) => Number(hasSessions(b)) - Number(hasSessions(a))) }
}
