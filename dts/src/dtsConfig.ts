export const DtsConfig = {
  maxRelativeTypeRefs: 500,
  maxBareDeps: 8,
  maxBareDepth: 3,
  prefetchConcurrency: 4,
  negativeTtlMs: 10_000,
} as const

export const DECLARATION_EXTENSIONS = ['index.d.ts', 'index.d.mts'] as const
export const DTS_REGEX = /\.d\.(ts|mts|cts)$/i

/** A path/URL that IS a type declaration: a `.d.ts`/`.d.mts`/`.d.cts` file (trailing
 *  query/hash tolerated), or one carrying esm.sh's bare `?dts` marker param. The single
 *  predicate shared by the resolver's relative-ref walk and the provider's fetch validation. */
export function isDtsFile(p: string): boolean {
  return /\.d\.(ts|mts|cts)(?:[?#].*)?$/i.test(p) || /[?&]dts(?:[&#]|$)/i.test(p)
}

export function makeDeclarationCandidates(base: string): string[] {
  return [`${base}.d.ts`, `${base}.d.mts`]
}

export function declarationCandidatesFor(runtimePath: string): string[] {
  if (!runtimePath || runtimePath === './' || runtimePath === '/') {
    return [...DECLARATION_EXTENSIONS]
  }
  const base = runtimePath.replace(/\.(mjs|cjs|js|mts|cts|ts)$/i, '')
  const candidates = makeDeclarationCandidates(base)
  const trailingBase = base.endsWith('/') ? base : `${base}/`
  candidates.push(...makeDeclarationCandidates(`${trailingBase}index`))
  return candidates
}
