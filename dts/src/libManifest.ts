/**
 * Declarative list of TypeScript lib file names used by Typebulb bulbs.
 *
 * Single source of truth for both the web client (loaded via Vite ?raw imports
 * into Monaco/standalone TypeChecker) and the CLI (emitted into tsconfig's
 * compilerOptions.lib array).
 *
 * Names match TypeScript's lib.<name>.d.ts naming (without the `lib.` prefix
 * and without the `.d.ts` suffix). The corresponding tsconfig `lib` entry is
 * derived by transforming `es2015.core` → `ES2015.Core`, etc.
 */

/**
 * Minimum TypeScript version required for an entry. Used to filter the manifest
 * against the consumer's available TS version.
 */
export type TsVersionGate = '5.0' | '5.5'

export interface LibEntry {
  /** Lib name as used in the lib.<name>.d.ts file (e.g. 'es2015.core'). */
  name: string
  /** Minimum TS version required, if any. */
  since?: TsVersionGate
}

/**
 * ES core libs (no DOM, no WebGPU). Ordered by ES version, then alphabetically.
 */
export const esLibEntries: LibEntry[] = [
  { name: 'es5' },

  { name: 'es2015.core' },
  { name: 'es2015.collection' },
  { name: 'es2015.promise' },
  { name: 'es2015.iterable' },
  { name: 'es2015.symbol' },
  { name: 'es2015.symbol.wellknown' },
  { name: 'es2015.generator' },
  { name: 'es2015.proxy' },
  { name: 'es2015.reflect' },

  { name: 'es2016.array.include' },
  { name: 'es2016.intl' },

  { name: 'es2017.object' },
  { name: 'es2017.string' },
  { name: 'es2017.sharedmemory' },
  { name: 'es2017.typedarrays' },
  { name: 'es2017.date' },
  { name: 'es2017.intl' },

  { name: 'es2018.asynciterable' },
  { name: 'es2018.asyncgenerator' },
  { name: 'es2018.promise' },
  { name: 'es2018.regexp' },
  { name: 'es2018.intl' },

  { name: 'es2019.array' },
  { name: 'es2019.object' },
  { name: 'es2019.string' },
  { name: 'es2019.symbol' },
  { name: 'es2019.intl' },

  { name: 'es2020.bigint' },
  { name: 'es2020.promise' },
  { name: 'es2020.string' },
  { name: 'es2020.sharedmemory' },
  { name: 'es2020.date' },
  { name: 'es2020.number' },
  { name: 'es2020.symbol.wellknown' },
  { name: 'es2020.intl' },

  { name: 'es2021.promise' },
  { name: 'es2021.string' },
  { name: 'es2021.weakref' },
  { name: 'es2021.intl' },

  { name: 'es2022.array' },
  { name: 'es2022.object' },
  { name: 'es2022.error' },
  { name: 'es2022.string' },
  { name: 'es2022.regexp' },
  { name: 'es2022.intl' },

  { name: 'es2023.array' },
  { name: 'es2023.collection' },
  { name: 'es2023.intl', since: '5.5' },

  { name: 'es2024.arraybuffer', since: '5.5' },
  { name: 'es2024.collection', since: '5.5' },
  { name: 'es2024.object', since: '5.5' },
  { name: 'es2024.promise', since: '5.5' },
  { name: 'es2024.regexp', since: '5.5' },
  { name: 'es2024.sharedmemory', since: '5.5' },
  { name: 'es2024.string', since: '5.5' },

  { name: 'esnext.array', since: '5.5' },
  { name: 'esnext.collection' },
  { name: 'esnext.decorators' },
  { name: 'esnext.disposable' },
  { name: 'esnext.error', since: '5.5' },
  { name: 'esnext.float16', since: '5.5' },
  { name: 'esnext.iterator', since: '5.5' },
  { name: 'esnext.object' },
  { name: 'esnext.promise' },
  { name: 'esnext.sharedmemory', since: '5.5' },
  { name: 'esnext.intl' },
]

/**
 * DOM libs (separate from ES core so server-side emit can omit them).
 */
export const domLibEntries: LibEntry[] = [
  { name: 'dom' },
  { name: 'dom.iterable' },
  { name: 'dom.asynciterable' },
]

/**
 * Filter a list of entries against an available TS version.
 * Entries without `since` are always included.
 */
export function filterByTsVersion(entries: LibEntry[], tsVersion?: TsVersionGate): LibEntry[] {
  if (!tsVersion) {
    return entries.filter(e => !e.since)
  }
  const order: Record<TsVersionGate, number> = { '5.0': 0, '5.5': 1 }
  const available = order[tsVersion]
  return entries.filter(e => !e.since || order[e.since] <= available)
}
