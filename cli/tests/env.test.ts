import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import * as path from 'path'
import { loadEnv, referencedEnvKeys } from '../src/env.js'

// Test keys are deleted from process.env after each case so loadEnv's `??=` (first writer
// wins) sees them unset on the next run. See TB-Env.md for the ladder.
const KEYS = ['TB_T_BASE', 'TB_T_WIN', 'TB_T_SHELL']

describe('loadEnv precedence ladder', () => {
  let dir: string
  const write = (name: string, body: string) => writeFile(path.join(dir, name), body)

  beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'tb-env-')) })
  afterEach(async () => {
    for (const k of KEYS) delete process.env[k]
    await rm(dir, { recursive: true, force: true })
  })

  it('.env.local overrides .env (the inversion fix)', async () => {
    await write('.env', 'TB_T_WIN=from_base\nTB_T_BASE=base')
    await write('.env.local', 'TB_T_WIN=from_local')
    const r = loadEnv(undefined, dir)
    expect(process.env.TB_T_WIN).toBe('from_local')
    expect(process.env.TB_T_BASE).toBe('base')
    expect(r.sources.TB_T_WIN).toBe('.env.local')
    expect(r.sources.TB_T_BASE).toBe('.env')
  })

  it('mode files outrank the base cascade, with .local highest', async () => {
    await write('.env', 'TB_T_WIN=base')
    await write('.env.local', 'TB_T_WIN=local')
    await write('.env.staging', 'TB_T_WIN=mode')
    await write('.env.staging.local', 'TB_T_WIN=mode_local')
    const r = loadEnv('staging', dir)
    expect(process.env.TB_T_WIN).toBe('mode_local')
    expect(r.sources.TB_T_WIN).toBe('.env.staging.local')
    expect(r.loaded).toEqual(['.env.staging.local', '.env.staging', '.env.local', '.env'])
  })

  it('an exported shell var wins over every file', async () => {
    process.env.TB_T_SHELL = 'shell'
    await write('.env', 'TB_T_SHELL=file')
    const r = loadEnv(undefined, dir)
    expect(process.env.TB_T_SHELL).toBe('shell')
    expect(r.sources.TB_T_SHELL).toBeUndefined()   // not file-sourced
  })

  it('reports only the files that exist, highest precedence first', async () => {
    await write('.env', 'TB_T_BASE=1')
    const r = loadEnv('nope', dir)            // no .env.nope / .env.local on disk
    expect(r.loaded).toEqual(['.env'])
  })
})

describe('referencedEnvKeys', () => {
  it('finds dotted and bracketed process.env reads', () => {
    const src = `const a = process.env.DATABASE_URL!; const b = process.env['API_KEY']; const c = process.env["X_Y"]`
    expect(referencedEnvKeys(src).sort()).toEqual(['API_KEY', 'DATABASE_URL', 'X_Y'])
  })

  it('returns nothing when env is untouched', () => {
    expect(referencedEnvKeys('const x = 1')).toEqual([])
  })
})
