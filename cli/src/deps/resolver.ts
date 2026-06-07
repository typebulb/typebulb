/**
 * Node.js adapter for typebulb/resolver.
 * Uses an on-disk cache under ~/.typebulb/cache/packages/ so resolver metadata
 * persists across CLI invocations.
 */

import { createResolver } from 'typebulb/resolver'
import { FsPackageCache } from './cache/fsPackageCache.js'
import { fetchHttpClient } from './fetchHttpClient.js'

// Singleton resolver: disk-backed cache (metadata persists across CLI runs) +
// the shared fetch HttpClient.
const cache = new FsPackageCache()
export const { packageService, versionResolver, cdnClient, peerResolver } = createResolver(cache, fetchHttpClient)
