export {
  esLibEntries,
  domLibEntries,
  filterByTsVersion,
  type LibEntry,
  type TsVersionGate,
} from './libManifest.js'

export { clientTbTypings, serverTbTypings } from './tbTypings.js'

export { type DtsCache } from './cache.js'

// DTS resolver pipeline
export {
  DtsResolver,
  type DtsResolverDeps,
  type TypeFetchResult,
  type ModuleShim,
  type ResolvedTypeFile,
  type ResolvedTypeDef,
} from './dtsResolver.js'
