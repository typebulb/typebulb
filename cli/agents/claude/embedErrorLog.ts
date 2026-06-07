// Name-keyed idempotency for the viewer's embed-error forward
// (Specs/Typebulb-CLI-Agent-Viewer-Embed-Iterate.md Invariant 7, Guard B).
//
// The forward rides the shared diagnostic *transport* (console → `<pid>.log` → `typebulb logs`) but the
// embed-specific *semantics* — name-tagging and "don't repeat an unchanged failure" — stay with the viewer
// host, off the generic `/__log` channel a standalone bulb shares. A browser refresh rebuilds the viewer
// from scratch and re-forwards a still-broken embed's identical error (the original pile-up), so the line is
// dropped when it equals the last one accepted for that embed's tag. Distinct failures still log: a compile
// error then a runtime error differ; the same error after a fix changes text and logs anew.
//
// Pure and side-effect-free so it unit-tests in node — it decides *whether* a line is fresh; server.ts owns
// the console emission.
export class EmbedErrorDedup {
  #last = new Map<string, string>()

  // True iff `line` differs from the last accepted line for `tag` (recording it as the new last). False ⇒ a
  // duplicate to drop. Keyed by tag so two embeds never mask each other's errors.
  accept(tag: string, line: string): boolean {
    if (this.#last.get(tag) === line) return false
    this.#last.set(tag, line)
    return true
  }
}
