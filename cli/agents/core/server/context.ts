// Shared primitives for the mirror's server-side modules (server/*.ts), kept dependency-free so the
// transcript core and the feature modules (launcher, switcher) can all import them with no cycle.

export function errorMessage(err: unknown): string {
  return (err as Error)?.message ?? String(err)
}

// The project this mirror serves — captured once at load (the process never chdir's). The transcript
// core seeds its `state.cwd` from this; the launcher and switcher read it directly. One source of truth.
export const projectCwd = process.cwd()
