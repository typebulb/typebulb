export const DtsConfig = {
  maxRelativeTypeRefs: 500,
  maxBareDeps: 8,
  maxBareDepth: 3,
  prefetchConcurrency: 4,
  negativeTtlMs: 10_000,
} as const

export const DECLARATION_EXTENSIONS = ['index.d.ts', 'index.d.mts'] as const
export const DTS_REGEX = /\.d\.(ts|mts)$/i

export function isDtsFile(p: string): boolean {
  if (DTS_REGEX.test(p)) return true
  try {
    const url = new URL(p, 'file://')
    return url.search.includes('dts')
  } catch {
    return p.includes('?') && p.includes('dts')
  }
}

export function makeDeclarationCandidates(base: string): string[] {
  return [`${base}.d.ts`, `${base}.d.mts`]
}
