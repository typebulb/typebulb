/**
 * Reserved agent viewers the CLI can launch via `agent:<name>`.
 *
 * An agent viewer is a browser view over a coding-agent's session — it tails the on-disk
 * transcript and renders the bulbs the agent emits inline. Its code lives under `agents/<name>/`
 * (Specs/Typebulb-CLI-Agent-Viewer.md). `claude` is the canonical — and, for now, only — agent. Adding
 * one is a one-line entry here, plus its `agents/<name>/` code and a dispatch case in `index.ts`.
 */
const AGENTS = new Set(['claude'])

/** Is `name` a reserved agent the CLI can launch (`agent:<name>`)? */
export function isKnownAgent(name: string): boolean {
  return AGENTS.has(name)
}

/** Every reserved agent name — for the `agent:<name>` help and the unknown-agent error. */
export function listAgentNames(): string[] {
  return [...AGENTS]
}
