import { gunzipSync } from 'fflate'
import { fetchWithRetry } from './httpFetch.js'

/**
 * Fetches an npm tarball from registry.npmjs.org and extracts .d.ts / .d.mts
 * files in-memory. Uses fflate (isomorphic). No deps to inject — usable
 * from both web client and CLI.
 */
export class TarballFetcher {
  async fetchAndExtract(packageName: string, version: string): Promise<Map<string, string>> {
    const tarballUrl = this.getTarballUrl(packageName, version)
    // Tarballs are large; give them double the default timeout for slow networks.
    const response = await fetchWithRetry(tarballUrl, { timeoutMs: 30_000 })
    if (!response?.ok) return new Map()

    const gzipped = new Uint8Array(await response.arrayBuffer())
    return this.extractDtsFiles(gzipped)
  }

  private getTarballUrl(packageName: string, version: string): string {
    const encodedName = packageName.replace('/', '%2F')
    return `https://registry.npmjs.org/${encodedName}/-/${packageName.split('/').pop()}-${version}.tgz`
  }

  private normalizeTarPath(tarPath: string): string {
    let p = tarPath.replace(/^package\//, '')
    const firstSlash = p.indexOf('/')
    return firstSlash > 0 ? p.substring(firstSlash + 1) : p
  }

  private extractDtsFiles(gzipped: Uint8Array): Map<string, string> {
    const files = new Map<string, string>()
    try {
      const tarData = gunzipSync(gzipped)
      const decoder = new TextDecoder('utf-8')
      let offset = 0

      while (offset < tarData.length - 512) {
        const header = tarData.slice(offset, offset + 512)
        if (header[0] === 0) break

        const filenameBytes = header.slice(0, 100)
        const nullIndex = filenameBytes.indexOf(0)
        const filename = decoder.decode(filenameBytes.slice(0, nullIndex > 0 ? nullIndex : 100)).trim()

        const sizeBytes = header.slice(124, 136)
        const sizeStr = decoder.decode(sizeBytes).trim().replace(/\0/g, '')
        const fileSize = parseInt(sizeStr, 8) || 0

        const fileType = String.fromCharCode(header[156])

        offset += 512

        if ((fileType === '0' || fileType === '\0') &&
            (filename.endsWith('.d.ts') || filename.endsWith('.d.mts'))) {
          const fileData = tarData.slice(offset, offset + fileSize)
          files.set(this.normalizeTarPath(filename), decoder.decode(fileData))
        }

        offset += Math.ceil(fileSize / 512) * 512
      }
    } catch {}
    return files
  }
}

export const tarballFetcher = new TarballFetcher()
