import { slugify } from 'typebulb/format'

/**
 * `typebulb slug <name>` — print the slug a bulb title derives to, so an agent naming a file is
 * told the answer instead of guessing it. The filename IS the bulb's remote identity
 * (TB-Push-Pull.md Invariant 4) and the derivation is a library, not a rule you can apply in your
 * head — `Rock & Roll` → `rock-and-roll`, `Prisoner's Dilemma` → `prisoners-dilemma` — so a guess
 * publishes under the wrong URL. Prints the bare slug, nothing else, so it composes.
 */
export function runSlug(name: string | undefined): void {
  if (!name?.trim()) {
    console.error('Usage: typebulb slug <bulb name>')
    process.exit(1)
  }
  const slug = slugify(name)
  if (!slug) {
    console.error(`'${name}' has no slug — a bulb name needs at least one letter or digit.`)
    process.exit(1)
  }
  console.log(slug)
}
