import { describe, it, expect } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import { emitClientTypecheck } from '../src/dts/emit.js'

/**
 * Real-CDN integration tier for DTS emit — the headless replacement for the
 * browser-only `client/tests/e2e/types.spec.ts` resolution cases. Drives the
 * exact production pipeline (`emitClientTypecheck` → real resolver → real
 * jsDelivr/npm → FsDtsCache → materialized node_modules), no Monaco, no browser.
 *
 * GATED: off by default so `pnpm test` stays fast and offline. Run with:
 *   TB_NET_TESTS=1 pnpm vitest run cli/tests/dtsEmit.net.test.ts
 * First run cold-fetches tarballs (~seconds); reruns warm from ~/.typebulb/cache.
 *
 * Fidelity fakes can't provide: this catches drift in a real package's on-disk
 * layout / `exports` map — the class of bug that produced the OrbitControls miss
 * (types live in @types/three as `OrbitControls.d.ts`, and the import carries a
 * runtime `.js` the provider has to strip).
 */

const RUN = process.env.TB_NET_TESTS === '1'

describe.skipIf(!RUN)('dts emit against the real CDN', () => {
  it('resolves a three addon subpath (with .js) to its real @types/three declaration', async () => {
    const code = [
      `import * as THREE from "three"`,
      `import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js"`,
      `const c = new OrbitControls(new THREE.PerspectiveCamera(), document.body)`,
      `void c`,
    ].join('\n')

    const { dir } = await emitClientTypecheck({
      code,
      dependencies: { three: '^0.160.0' },
      // Synthetic key → isolated emit dir; need not be a real file on disk.
      emitKey: '__net_test__/three-orbitcontrols.bulb.md',
    })

    const tsconfig = JSON.parse(await fs.readFile(path.join(dir, 'tsconfig.json'), 'utf8'))
    const paths: Record<string, string[]> = tsconfig.compilerOptions.paths ?? {}

    // Root import still maps to three's own types.
    expect(paths['three']?.[0]).toBeDefined()

    // The subpath must map to a real OrbitControls declaration — NOT the bug's
    // fallback onto three/index.d.ts (which yielded TS2305 "no exported member").
    const subpath = paths['three/examples/jsm/controls/OrbitControls.js']?.[0]
    expect(subpath, 'subpath should have a paths entry').toBeDefined()
    expect(subpath).toMatch(/OrbitControls\.d\.ts$/)
    expect(subpath).not.toMatch(/three\/index\.d\.ts$/)

    // And the materialized file genuinely declares OrbitControls.
    const content = await fs.readFile(path.join(dir, subpath!), 'utf8')
    expect(content).toMatch(/OrbitControls/)
  }, 60_000)

  /** Emit `code` with `dependencies` and return the generated tsconfig `paths`. */
  async function emitPaths(emitKey: string, code: string, dependencies: Record<string, string>) {
    const { dir } = await emitClientTypecheck({ code, dependencies, emitKey })
    const tsconfig = JSON.parse(await fs.readFile(path.join(dir, 'tsconfig.json'), 'utf8'))
    return (tsconfig.compilerOptions.paths ?? {}) as Record<string, string[]>
  }

  // Packages that ship their own types resolve to a shim (a `paths` entry).
  it('resolves the React Three Fiber stack to shims', async () => {
    const code = [
      `import { Canvas } from "@react-three/fiber"`,
      `import { OrbitControls } from "@react-three/drei"`,
      `import { Physics } from "@react-three/cannon"`,
      `import * as THREE from "three"`,
      `void [Canvas, OrbitControls, Physics, THREE]`,
    ].join('\n')
    const paths = await emitPaths('__net_test__/r3f-stack.bulb.md', code, {
      react: '^18', 'react-dom': '^18', three: '*',
      '@react-three/fiber': '*', '@react-three/drei': '*', '@react-three/cannon': '*',
    })
    for (const pkg of ['three', '@react-three/fiber', '@react-three/drei', '@react-three/cannon']) {
      expect(paths[pkg]?.[0], pkg).toBeDefined()
    }
  }, 60_000)

  // DefinitelyTyped fallback: lodash-es ships no own types; @types/lodash-es supplies them.
  it('resolves lodash-es types via DefinitelyTyped', async () => {
    const paths = await emitPaths(
      '__net_test__/lodash.bulb.md',
      `import { groupBy } from "lodash-es"\nvoid groupBy`,
      { 'lodash-es': '*' },
    )
    expect(paths['lodash-es']?.[0]).toBeDefined()
  }, 60_000)
})
