import { VersionResolver } from './versionResolver.js'
import type { PackageRanges } from './types.js'
import { PackageRef } from './packageRef.js'
import { CdnClient } from './cdnClient.js'
import { ESM_HOST } from './cdnConstants.js'
import { PeerResolver, peerNames, depNames, type ResolvedRoot, type PackageFlags } from './peerResolver.js'
import { init, parse } from 'es-module-lexer'

export type ImportMap = { imports: Record<string, string> }

export class PackageService {

  private static importPatterns = [
    /\bimport\s+(?:[^'";]*?from\s*)?['"]([^'"]+)['"]/g,
    /\bexport\s+[^'";]*?from\s*['"]([^'"]+)['"]/g
  ]

  constructor(private version: VersionResolver, private cdn: CdnClient, private peer: PeerResolver) {}

  /** Fast sync import extraction using regex (for quick comparisons) */
  extractImportsSync(source: string): string[] {
    const imports = new Set<string>()
    for (const pattern of PackageService.importPatterns) {
      pattern.lastIndex = 0  // Reset regex state
      for (const match of source.matchAll(pattern)) {
        if (PackageRef.isBare(match[1])) imports.add(match[1])
      }
    }
    return Array.from(imports)
  }

  /** Async import extraction using es-module-lexer (more accurate) */
  async extractImports(source: string) {
    const imports = new Set<string>()
    const addIfBare = (pkg: string) => { if (PackageRef.isBare(pkg)) imports.add(pkg) }

    try {
      await init
      const [recs] = parse(source)
      recs.forEach(rec => addIfBare(source.slice(rec.s, rec.e).trim()))
    } catch {
      // Fallback to sync regex parser
      return this.extractImportsSync(source)
    }
    return Array.from(imports)
  }

  /**
   * Build an import map for a bulb's code.
   *
   * `skipRoots` names roots the caller supplies itself (serving them from
   * elsewhere); their imports are dropped before resolution, so they're never
   * looked up on the CDN. Optional and caller-agnostic — callers that resolve
   * the whole graph simply omit it.
   */
  async buildImportMap(code: string, ranges: PackageRanges, skipRoots?: ReadonlySet<string>) {
    const directImports = (await this.extractImports(code))
      .filter(imp => !skipRoots?.has(PackageRef.rootOf(imp)))
    const directRoots = [...new Set(directImports.map(PackageRef.rootOf))]

    const resolvedRoots = await Promise.all(
      directRoots.map(async name => ({ name, version: await this.resolveVersion(name, ranges) }))
    )

    const { allRoots, flags, autoAddedPeers } = await this.peer.resolve(
      resolvedRoots, name => this.resolveVersion(name, ranges)
    )

    const entries = this.buildEntries(
      [...directImports, ...autoAddedPeers.map(p => p.name)], allRoots, flags
    )

    return {
      importMap: { imports: Object.fromEntries(entries) },
      prefetchUrls: entries.map(([, url]) => url)
    }
  }

  /** Resolution is `resolveExactForRoot`'s pipeline or a clear failure — never an unpinned range.
   *  (Its final esm.sh probe counts only when the response URL names an exact in-range version;
   *  current esm.sh answers 200 with `X-Esm-Path` instead, so the version index is the only source.) */
  private async resolveVersion(name: string, ranges: PackageRanges): Promise<string> {
    const range = ranges[name]
    const version = await this.version.resolveExactForRoot(name, range)
    if (!version) {
      // Don't claim "network down" — the usual cause is a range that matches
      // no published version (e.g. ^0.3.0 before 0.3.0 ships), not an outage.
      throw new Error(
        `Cannot resolve ${range ? `${name}@${range}` : name}: no matching version is published (the package or version may not exist, or the registry was unreachable).`,
      )
    }
    return version
  }

  private buildEntries(imports: string[], roots: ResolvedRoot[], flags: Map<string, PackageFlags>) {
    const rootMap = new Map(roots.map(r => [r.name, r]))

    const versionedPkg = (pkg: string) => {
      const root = rootMap.get(PackageRef.rootOf(pkg))!
      return new PackageRef(pkg).withVersion(root.version).format()
    }

    // Packages that must be singletons: peer roots OR shared deps
    // - Peer roots: packages appearing in peerDependencies (react, vue, three)
    // - Shared deps: packages appearing in 2+ packages' dependencies (@codemirror/state)
    const singletonRoots = new Set(
      [...flags.entries()]
        .filter(([, f]) => f.isPeerRoot || f.isSharedDep)
        .map(([name]) => name)
    )

    // If any subpath of a root is imported, don't bundle that root (they must share module graph)
    const rootsWithSubpaths = new Set(
      imports.filter(pkg => pkg !== PackageRef.rootOf(pkg)).map(PackageRef.rootOf)
    )

    const entries: [string, string][] = []
    const addedPkgs = new Set<string>()

    // Track which root packages are directly imported (not just via subpath)
    const directlyImportedRoots = new Set(imports.filter(pkg => pkg === PackageRef.rootOf(pkg)))

    // Roots that get externalized from their own subpath bundles. esm.sh's bundle for
    // those subpaths may reference internal chunk paths (e.g. `domeleon/dist/chunk-XXX`),
    // so we need a trailing-slash entry to resolve them — even if the root isn't a singleton.
    const externalizedSubpathRoots = new Set<string>()

    for (const pkg of imports) {
      const rootName = PackageRef.rootOf(pkg)
      const root = rootMap.get(rootName)!
      const { isPeerRoot, hasPeers, isSharedDep } = flags.get(rootName)!
      const hasSubpathImports = rootsWithSubpaths.has(rootName)
      const isSubpath = pkg !== rootName
      const isSingleton = isPeerRoot || isSharedDep

      // Bundle strategy:
      // - Never bundle singletons (peer roots or shared deps) - must have single instance
      // - Bundle packages with subpath imports (even with peers) - fixes broken internal modules (drizzle-orm)
      // - Plain libraries without peers can be bundled
      // - Don't bundle packages with peers but no subpaths (use external instead)
      const canBundle = !isSingleton && (hasSubpathImports || !hasPeers)

      // External strategy:
      // - Packages with peers externalize their singleton peers
      // - Packages with deps externalize their singleton deps
      // - Subpaths externalize their root ONLY if root is also directly imported
      const externalSingletons = this.singletonDepsOf(root, singletonRoots)
      const shouldExternalizeRoot = isSubpath && directlyImportedRoots.has(rootName)
      if (shouldExternalizeRoot) externalizedSubpathRoots.add(rootName)
      const external = shouldExternalizeRoot
        ? [...externalSingletons, rootName]
        : (externalSingletons.length ? externalSingletons : undefined)

      entries.push([pkg, this.cdn.buildEsmUrl(versionedPkg(pkg), { bundle: canBundle, external })])
      addedPkgs.add(pkg)
    }

    // Roots that need both a root entry and a trailing-slash entry in the import map:
    // - Singletons (peer roots or shared deps): always externalized; consumers may use subpaths
    // - Externalized subpath roots: their own sub-bundles may reference internal chunk paths
    const rootsNeedingTrailingSlash = new Set([...singletonRoots, ...externalizedSubpathRoots])

    // Root entry: "react" for `import React from "react"`
    // Trailing slash: "react/" for `import { useState } from "react/client"` or for
    // internal chunks emitted by a sub-bundle that externalized the root.
    for (const name of rootsNeedingTrailingSlash) {
      if (!rootMap.has(name)) continue

      if (!addedPkgs.has(name)) {
        entries.push([name, this.cdn.buildEsmUrl(versionedPkg(name), {})])
      }
      entries.push([`${name}/`, `${ESM_HOST}/${versionedPkg(name)}/`])
    }

    return entries
  }

  /** Get dependencies (peer or regular) that are singletons and need to be externalized */
  private singletonDepsOf(root: ResolvedRoot, singletonRoots: Set<string>): string[] {
    return [...new Set([...peerNames(root.meta), ...depNames(root.meta)])].filter(name => singletonRoots.has(name))
  }
}
