// Tag-keyed idempotency for the mirror's inline bulb-status forward
// (TB-Agent-Mirror-Inline.md, Iteration Invariant 7).
//
// The forward rides the shared diagnostic *transport* (console → `<pid>.log` → `typebulb logs`/`wait`) but
// the inline bulb-specific *semantics* — name+version tagging and "don't repeat an unchanged state" — stay with
// the mirror host, off the generic `/__log` channel a standalone bulb shares. A browser refresh rebuilds the
// mirror from scratch and re-forwards every inline bulb's identical outcome (the original pile-up), so a line is
// dropped when it equals the last one accepted for that inline bulb's tag. Distinct states still log: ok vs an
// error, a compile error vs a runtime error, and any line from a *re-emit* — its chain version is part of
// the line, so it differs even when the text repeats.
//
// Pure and side-effect-free so it unit-tests in node — it decides *whether* a line is fresh; server.ts owns
// the console emission.
export class InlineStatusDedup {
  #last = new Map<string, string>()

  // True iff `line` differs from the last accepted line for `tag` (recording it as the new last). False ⇒ a
  // duplicate to drop. Keyed by tag so two inline bulbs never mask each other's status.
  accept(tag: string, line: string): boolean {
    if (this.#last.get(tag) === line) return false
    this.#last.set(tag, line)
    return true
  }
}
