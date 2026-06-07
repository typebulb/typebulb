/**
 * Sucrase transpiler — strips TypeScript/JSX to runnable JS for the bulb's code
 * blocks. Not a type-checking compiler: Sucrase removes types without validating
 * them (that's `tsc`'s job, via `typebulb check`). Shared by typebulb.com and the
 * CLI so a bulb compiles identically in both — the "just make it run" path.
 */

import { transform, type Transform } from 'sucrase'

export interface TranspileOptions {
  /** Skip the JSX transform. Use for `server.ts`, which is plain TypeScript. */
  serverOnly?: boolean
  /** JSX runtime source (e.g. 'react', 'preact'). Ignored when `serverOnly`. */
  jsxImportSource?: string
}

export interface TranspileResult {
  code: string
  /** Set instead of `code` when Sucrase couldn't parse the source. */
  error?: string
}

export function transpile(source: string, options: TranspileOptions = {}): TranspileResult {
  const transforms: Transform[] = options.serverOnly ? ['typescript'] : ['typescript', 'jsx']
  try {
    const { code } = transform(source, {
      transforms,
      jsxRuntime: 'automatic',
      jsxImportSource: options.jsxImportSource || 'react',
      production: true,
    })
    return { code }
  } catch (e) {
    return { code: '', error: String(e) }
  }
}
