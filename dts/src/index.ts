export {
  esLibEntries,
  domLibEntries,
  filterByTsVersion,
  WEBGPU_TYPES_PACKAGE,
  type LibEntry,
  type TsVersionGate,
} from './libManifest.js'

export { clientTbTypings, serverTbTypings } from './tbTypings.js'

export { type DtsCache } from './cache.js'

export {
  NegativeCacheHelper,
  type NegativeCacheStore,
  type NegativeRecord,
} from './negativeCacheHelper.js'

// DTS resolver pipeline
export {
  DtsResolver,
  createDtsResolver,
  type DtsResolverDeps,
  type TypeFetchResult,
  type ModuleShim,
  type ResolvedTypeFile,
  type ResolvedTypeDef,
} from './dtsResolver.js'
export { VirtualFs } from './virtualFs.js'
export { TypeRefScanner } from './typeRefScanner.js'
export { TarballFetcher, tarballFetcher } from './tarballFetcher.js'
export { TypescriptProvider } from './typescriptProvider.js'
export { DefinitelyTypedProvider } from './definitelyTypedProvider.js'
export { createFetchDts, type FetchDtsWithCache } from './fetchDts.js'
export { fetchWithRetry, type FetchWithRetryOptions } from './httpFetch.js'
export {
  DtsConfig,
  DECLARATION_EXTENSIONS,
  DTS_REGEX,
  isDtsFile,
  makeDeclarationCandidates,
} from './dtsConfig.js'
