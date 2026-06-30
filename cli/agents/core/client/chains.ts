// Same-name chain supersession for live ````bulb```` embeds, in transcript order.
//
// A consecutive run of embeds sharing a (non-empty) frontmatter `name` is one evolving artifact: the
// agent emitting a revision under the same name. Every member but the last is *superseded* — folded to
// an unmounted stub while only the newest stays live. The rule reduces to a next-sibling check: an embed
// is superseded iff the next embed in order carries the same name. A differently-named (or unnamed) embed
// between two same-named ones breaks the run, so each is its own singleton — exactly what we want when
// the agent renamed because the bulb changed enough to be a new thing.
//
// Pure and DOM-free so it unit-tests in node. See TB-Agent-Mirror-Embed.md, Iteration
// Invariant 4.
export function supersededFlags(names: (string | undefined)[]): boolean[] {
  return names.map((name, i) => !!name && names[i + 1] === name)
}

// The 1-based position of each embed within its consecutive same-name run — its "attempt" number.
// Resets to 1 whenever the name changes (a run break) or is empty. So a run A,A,A is 1,2,3; the folded
// stubs show "Version 1" / "Version 2" and the live tail is the (unlabelled) latest.
export function chainPositions(names: (string | undefined)[]): number[] {
  const pos: number[] = []
  for (let i = 0; i < names.length; i++) {
    pos[i] = i > 0 && !!names[i] && names[i] === names[i - 1] ? pos[i - 1]! + 1 : 1
  }
  return pos
}
