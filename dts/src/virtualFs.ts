import { normalizeRelative } from 'typebulb/resolver'

const NODE_MODULES_PREFIX = 'file:///node_modules'

/**
 * Virtual filesystem layout for DTS resolution. Each entry lives under
 * `file:///node_modules/__tsepoch_N/<pkg>/...`. The CLI's emit step strips
 * the epoch and writes real files; the web client's TypeChecker treats
 * these paths as virtual.
 *
 * Epoch is bumpable so reactive consumers (web client) can invalidate the
 * world when package ranges change. CLI never bumps within a single emit.
 */
export class VirtualFs {
  private epoch = 0

  bumpEpoch(): void {
    this.epoch += 1
  }

  epochDir(): string {
    return `__tsepoch_${this.epoch}`
  }

  pathForMain(pkg: string): string {
    return `${NODE_MODULES_PREFIX}/${this.epochDir()}/${pkg}/index.d.ts`
  }

  pathFor(pkg: string, rel: string): string {
    const clean = normalizeRelative(rel)
    return `${NODE_MODULES_PREFIX}/${this.epochDir()}/${pkg}/${clean}`
  }
}
