import { ESM_HOST, JSDELIVR_BASE } from './cdnConstants.js'

export type IPackageRef = {
  name: string
  version?: string
  subpath?: string
}

function splitSegments(path: string): string[] {
  const clean = (path || '').replace(/^\/+/, '').replace(/\/+$/, '')
  return clean ? clean.split('/') : []
}

export class PackageRef implements IPackageRef {
  readonly name: string
  readonly version?: string
  readonly subpath?: string

  constructor(input: string | IPackageRef, version?: string, subpath?: string) {
    const ref = typeof input === 'string' ? PackageRef.parse(input) : input
    this.name = ref.name
    this.version = undefIfEmpty(version ?? ref.version)
    this.subpath = undefIfEmpty(subpath ?? ref.subpath)
  }

  static parse(input: string): PackageRef {
    const segs = splitSegments(input || '')
    if (!segs.length) return new PackageRef({ name: '' })

    const scoped = segs[0].startsWith('@')
    if (scoped) {
      const scope = segs[0]
      const [pkg, ver] = splitAtVer(segs[1] ?? '')
      const sub = undefIfEmpty(segs.slice(2).join('/'))
      return new PackageRef({ name: `${scope}/${pkg}`, version: ver, subpath: sub })
    } else {
      const [name, ver] = splitAtVer(segs[0])
      const sub = undefIfEmpty(segs.slice(1).join('/'))
      return new PackageRef({ name, version: ver, subpath: sub })
    }
  }

  static fromUrl(url: string): PackageRef | undefined {
    try {
      const u = new URL(url)
      const esmHost = new URL(ESM_HOST).host
      const jsdHost = new URL(JSDELIVR_BASE).host

      if (u.host === esmHost) {
        // Trim optional /v{n}/; extract head that may include version and scope
        const segs = splitSegments(u.pathname.replace(/^\/v\d+\//, '/'))
        if (!segs.length) return undefined
        const head = segs[0].startsWith('@') ? `${segs[0]}/${segs[1] ?? ''}` : segs[0]
        return PackageRef.parse(head)
      }

      if (u.host === jsdHost) {
        const after = u.pathname.split('/npm/')[1]
        if (!after) return undefined
        const first = after.split('/')[0] || ''
        return PackageRef.parse(first)
      }
      return undefined
    } catch {
      return undefined
    }
  }

  format(): string {
    const base = this.version ? `${this.name}@${this.version}` : this.name
    return this.subpath ? `${base}/${this.subpath}` : base
  }

  root(): string { return this.name }

  static rootOf(pkg: string): string {
    return PackageRef.parse(pkg).name
  }

  withVersion(v: string | undefined): PackageRef {
    // Preserve both version and subpath by constructing from an object, not a string
    // Using a string would trigger the string constructor path and drop the provided args
    return new PackageRef({ name: this.name, version: undefIfEmpty(v), subpath: this.subpath })
  }

  static isBare(pkg: string) {
    if (!pkg || pkg.startsWith('.') || pkg.startsWith('/')) return false
    // Any scheme is not a package — `node:` builtins as much as `http(s):`, `data:`, `blob:`.
    // Same rule as the lint's importRoot, which this is meant to stay in step with.
    return !/^[a-z][a-z0-9+.-]*:/i.test(pkg)
  }
}

const undefIfEmpty = (s?: string) => (s && s.length ? s : undefined)
const splitAtVer = (s: string): [string, string | undefined] => {
  const i = s.indexOf('@')
  return i < 0 ? [s, undefined] : [s.slice(0, i), undefIfEmpty(s.slice(i + 1))]
}
