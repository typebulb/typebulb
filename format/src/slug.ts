import slugifyLib from '@sindresorhus/slugify'

/** The one name→slug derivation (TB-CLI.md § One slug derivation): a bulb's slug is its identity —
 *  URL, local filename, asset keys — so every surface calls this, never a local regex. */
export function slugify(name: string): string {
  return slugifyLib(name)
}
