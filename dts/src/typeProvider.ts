export type TypeFetchResult = { dts: string; url: string; resolvedPkg?: string }
export type ModuleShim = { module: string; path: string }

// `ambient: true` marks a file/def whose types come from non-module `declare module`
// blocks (a script, not an ES module). Such a file must be *included* in the program,
// never used as a `paths` import target (that yields TS2306 "is not a module").
export interface ResolvedTypeFile { path: string; content: string; ambient?: boolean }
export interface ResolvedTypeDef {
  pkg: string
  mainPath: string
  files: ResolvedTypeFile[]
  shims: ModuleShim[]
  ambient?: boolean
}

export interface TypeProvider {
  resolve(pkg: string): Promise<TypeFetchResult | undefined>
}
