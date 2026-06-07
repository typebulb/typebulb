import type { FetchDtsWithCache } from './fetchDts.js'

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

export abstract class TypeProvider {
  constructor(protected fetchDts: FetchDtsWithCache) {}

  protected fetchDtsText(url: string) {
    return this.tryUrls([url])
  }

  protected async tryUrls(urls: string[]) {
    for (const url of urls) {
      const out = await this.fetchDts(url)
      if (!out) continue

      if (this.looksLikeDts(out.dts)) return out
      if (/\.(d\.ts|d\.mts)(?:[?#].*)?$/i.test(out.url)) return out
      if (/[?&]dts(?:[&#]|$)/i.test(out.url)) return out
    }
    return undefined
  }

  private looksLikeDts(text: string) {
    if (/^\s*export\s*\{\s*\}\s*;?\s*$/m.test(text)) return true
    return /declare\s+(module|namespace|class|interface|function|const|var|let)/.test(text)
      || /interface\s+\w+/.test(text)
      || /type\s+\w+\s*=/.test(text)
  }

  abstract resolve(pkg: string): Promise<TypeFetchResult | undefined>
}
