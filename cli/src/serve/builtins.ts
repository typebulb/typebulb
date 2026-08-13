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
export function resolveServerFn(exports: Record<string, Function> | undefined, name: string): Function | undefined {
  // Own-property check: BUILTINS is a plain object literal, so a bare index would hand
  // back Object.prototype members (`toString`, `constructor`) as dispatchable "functions".
  const fn = exports?.[name] ?? (Object.hasOwn(BUILTINS, name) ? BUILTINS[name] : undefined)
  return typeof fn === 'function' ? fn : undefined
}

/** True if `fn` is an `async function*` export — the kind both dispatch paths stream (NDJSON over
 *  the bridge / one JSON line per yield from `typebulb call`) rather than await. Keyed on the
 *  function's kind, not on sniffing its return value, so a normal export that returns an iterable is
 *  unaffected. */
export function isAsyncGenerator(fn: Function): boolean {
  return fn.constructor?.name === 'AsyncGeneratorFunction'
}
