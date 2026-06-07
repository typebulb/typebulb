import { CdnClient, type PackageMeta } from './cdnClient.js'

export type ResolvedRoot = { name: string; version: string; meta?: PackageMeta }
export type PackageFlags = { isPeerRoot: boolean; hasPeers: boolean; isSharedDep: boolean }
export type AutoAddedPeer = { name: string; requiredBy: string }

const isTypesPackage = (name: string) => name.startsWith('@types/')
export const peerNames = (meta?: PackageMeta) => Object.keys(meta?.peerDependencies || {}).filter(n => !isTypesPackage(n))
export const depNames = (meta?: PackageMeta) => Object.keys(meta?.dependencies || {}).filter(n => !isTypesPackage(n))

/** Only peers NOT marked as optional in peerDependenciesMeta */
const requiredPeerNames = (meta?: PackageMeta) =>
  peerNames(meta).filter(name => !meta?.peerDependenciesMeta?.[name]?.optional)

export class PeerResolver {

  constructor(private cdn: CdnClient) {}

  async resolve(
    roots: Array<{ name: string; version: string }>,
    resolveVersion: (name: string) => Promise<string>
  ) {
    const initialRoots = await this.fetchMeta(roots)
    const { allRoots, autoAddedPeers } = await this.expandWithPeers(initialRoots, resolveVersion)
    const flags = this.computeFlags(allRoots)
    return { allRoots, flags, autoAddedPeers }
  }

  private async fetchMeta(roots: Array<{ name: string; version: string }>): Promise<ResolvedRoot[]> {
    return Promise.all(roots.map(async ({ name, version }) => ({
      name, version, meta: await this.cdn.fetchPackageMeta(name, version)
    })))
  }

  private async expandWithPeers(
    initialRoots: ResolvedRoot[],
    resolveVersion: (name: string) => Promise<string>
  ) {
    const rootMap = new Map(initialRoots.map(r => [r.name, r]))
    const autoAddedPeers: AutoAddedPeer[] = []

    for (const root of initialRoots) {
      for (const name of requiredPeerNames(root.meta)) {
        if (!rootMap.has(name) && !autoAddedPeers.some(p => p.name === name)) {
          autoAddedPeers.push({ name, requiredBy: root.name })
        }
      }
    }

    // Resolve peers sequentially
    for (const { name, requiredBy } of autoAddedPeers) {
      try {
        const version = await resolveVersion(name)
        const meta = await this.cdn.fetchPackageMeta(name, version)
        rootMap.set(name, { name, version, meta })
      } catch (err) {
        console.warn(`[typebulb] Failed to resolve peer "${name}" for "${requiredBy}":`, err)
      }
    }

    return { allRoots: [...rootMap.values()], autoAddedPeers: autoAddedPeers.filter(p => rootMap.has(p.name)) }
  }

  private computeFlags(roots: ResolvedRoot[]): Map<string, PackageFlags> {
    // Packages appearing in peerDependencies of any imported package
    const peerRootSet = new Set(roots.flatMap(r => peerNames(r.meta)))

    // Packages appearing in dependencies of 2+ imported packages (shared deps)
    // These need singleton behavior even if not declared as peers (e.g., @codemirror/state)
    const depCounts = new Map<string, number>()
    for (const root of roots) {
      for (const dep of depNames(root.meta)) {
        depCounts.set(dep, (depCounts.get(dep) || 0) + 1)
      }
    }
    const sharedDepSet = new Set(
      [...depCounts.entries()].filter(([, count]) => count >= 2).map(([name]) => name)
    )

    return new Map(roots.map(root => [
      root.name,
      {
        isPeerRoot: peerRootSet.has(root.name),
        hasPeers: peerNames(root.meta).length > 0,
        isSharedDep: sharedDepSet.has(root.name)
      }
    ]))
  }
}
