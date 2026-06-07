/**
 * Proactive trust prediction — a best-effort, PURELY PROBABILISTIC guess at whether a bulb
 * will need `--trust`, from a scan of its source for privileged `tb.*` usage. This is a
 * PREDICTOR, never a gate (Specs/Typebulb-CLI-Trust.md): the server-side trust gate is the
 * sole enforcement. The scan only ever lets a host offer `--trust` *before* the bulb runs and
 * trips the gate (sparing the failed-first-run); it never decides access.
 *
 *   - A false negative (returns undefined for a bulb that does need trust) is harmless — the
 *     gate still 403s at runtime and the reactive elevation path takes over. So `undefined`
 *     NEVER means "safe"; it means "nothing obvious spotted". (A bulb that scans clean yet
 *     trips the gate anyway is the static-evasion signature — the host can warn harder.)
 *   - A false positive (flags a bulb that turns out not to need it) costs one extra, one-click
 *     elevation offer. Cheap by design — hence no attempt to exclude matches in comments or
 *     strings; gold-plating the scan would buy nothing.
 *
 * Returns the same human capability label the gate stamps on a real denial (so the proactive
 * prompt and the reactive one read alike), or undefined if nothing matched.
 */
export function predictTrust(bulb: { code: string; server: string }): string | undefined {
  // A server.ts block is server-side Node, reached through /__api — the strongest signal, and
  // structural (its mere presence) rather than a textual guess.
  if (bulb.server.trim()) return 'server-side code (server.ts)'

  const code = bulb.code
  if (/\btb\s*\.\s*fs\b/.test(code) || code.includes('/__fs')) return 'the filesystem'
  if (/\btb\s*\.\s*ai\b/.test(code) || code.includes('/__ai')) return 'AI (your API keys)'
  // tb.server.<fn> other than the ungated tb.server.log, or a raw /__api call.
  if (/\btb\s*\.\s*server\s*\.\s*(?!log\b)\w/.test(code) || code.includes('/__api')) {
    return 'server-side code (server.ts)'
  }
  return undefined
}
