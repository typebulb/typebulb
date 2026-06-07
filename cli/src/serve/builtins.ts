/**
 * Server-function dispatch, shared by the browser bridge (`serve/server.ts`, the `/__api/:name`
 * route) and `typebulb call` so the two paths resolve the *identical* function and can never drift
 * (TB-Call.md Invariant 1). Holds the built-in fallbacks and the one resolution rule over them.
 */

/** Built-ins available without a **server.ts** section; a user export of the same name overrides one. */
export const BUILTINS: Record<string, Function> = {
  // Dispatch through the live global `console` rather than capturing `console.log` here, so a caller
  // that redirects console (e.g. `call` routes all diagnostics to stderr) is honored at call time.
  // The web bridge leaves console untouched, so this still prints to the CLI's stdout there.
  log: (...args: unknown[]) => console.log(...args),
}

/** Resolve a server function by name: a user `server.ts` export wins, else the built-in, and only if
 *  it's actually callable. The single rule both dispatch paths share (Invariant 1). */
export function resolveServerFn(exports: Record<string, Function> | null | undefined, name: string): Function | undefined {
  const fn = exports?.[name] ?? BUILTINS[name]
  return typeof fn === 'function' ? fn : undefined
}
