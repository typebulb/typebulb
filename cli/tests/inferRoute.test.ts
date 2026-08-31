import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { startServer, type ServerInstance } from '../src/serve/server.js'
import { encodeToHash } from 'typebulb/ai'
import { freePort } from './browser/harness/servers.js'
import { inferModalJs } from '../src/bulb/inferModalUi.js'
import { writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'

/**
 * The /__infer route's non-provider paths (TB-Inference.md): block/resolver validation on a
 * trusted server, the ungated /__infer-info model line, and the lazy modal asset. The streamed
 * happy path needs a live provider, so it stays out of the unit suite (self-test a real bulb).
 */

let server: ServerInstance
let blocks: { infer: string; insight: string; code: string; config: string; data: string } | null = null
let saved: { data?: string[]; insightJson?: string } | null = null
const url = (p: string) => `http://127.0.0.1:${server.port}${p}`
const post = (p: string, body: unknown) => fetch(url(p), {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})

const ENV_KEYS = ['TB_AI_PROVIDER', 'TB_AI_MODEL', 'ANTHROPIC_API_KEY']

/** Deterministic high-entropy filler. Repetitive text deflates to almost nothing, so a size
 *  assertion written with `'x'.repeat(n)` proves the opposite of what it looks like. xorshift32,
 *  not an LCG: `s * 1103515245` leaves exact-integer range and the sequence degenerates into runs
 *  that deflate almost as well as the repeat it replaced. Bitwise ops stay exact in 32 bits. */
const noise = (n: number) => {
  let s = 123456789
  const out: string[] = []
  for (let i = 0; i < n; i++) {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5
    out.push(String.fromCharCode(33 + (s >>> 0) % 90))
  }
  return out.join('')
}

const savedEnv: Record<string, string | undefined> = {}

beforeAll(async () => {
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k] }
  server = await startServer({
    getHtml: () => '<html>ok</html>',
    basePath: process.cwd(),
    port: await freePort(),
    trusted: true,
    getBulbBlocks: () => blocks,
    saveInferenceResult: async (data, insightJson) => { saved = { data, insightJson } },
  })
})

afterAll(() => {
  server?.close()
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

beforeEach(() => {
  blocks = null
  saved = null
  for (const k of ENV_KEYS) delete process.env[k]
})

describe('/__infer validation', () => {
  it('400s with the unified error shape when the bulb has no infer.md block', async () => {
    const r = await post('/__infer', { data: ['x'] })
    expect(r.status).toBe(400)
    const err = await r.json()
    expect(err.message).toContain('infer.md')
    expect(err.retryable).toBe(false)
  })

  it('400s with the resolver message when no provider is configured', async () => {
    blocks = { infer: 'Score the data.', insight: '', code: '', config: '', data: '' }
    const r = await post('/__infer', { data: ['x'] })
    expect(r.status).toBe(400)
    const err = await r.json()
    expect(err.message).toContain('TB_AI_PROVIDER')
  })

  it('400s when the provider is set but its key is missing', async () => {
    blocks = { infer: 'Score the data.', insight: '', code: '', config: '', data: '' }
    process.env.TB_AI_PROVIDER = 'anthropic'
    process.env.TB_AI_MODEL = 'claude-haiku-4-5-20251001'
    const r = await post('/__infer', {})
    expect(r.status).toBe(400)
    const err = await r.json()
    expect(err.message).toContain('ANTHROPIC_API_KEY')
  })
})

describe('/__infer-info', () => {
  it('returns the resolver message as { error } when unresolvable', async () => {
    const r = await fetch(url('/__infer-info'))
    expect(r.status).toBe(200)
    const info = await r.json()
    expect(info.error).toContain('TB_AI_PROVIDER')
  })

  it('returns the resolved { provider, model } pair', async () => {
    process.env.TB_AI_PROVIDER = 'anthropic'
    process.env.TB_AI_MODEL = 'claude-haiku-4-5-20251001'
    process.env.ANTHROPIC_API_KEY = 'test-key'
    const info = await (await fetch(url('/__infer-info'))).json()
    expect(info).toEqual({ provider: 'anthropic', model: 'claude-haiku-4-5-20251001', data: [], hasInfer: false })
  })

  it('serves the SOURCE data chunks as the modal seed', async () => {
    blocks = { infer: 'x', insight: '', code: '', config: '', data: 'chunk one\n\n\nchunk two' }
    const info = await (await fetch(url('/__infer-info'))).json()
    expect(info.data).toEqual(['chunk one', 'chunk two'])
  })

  // What makes the modal open as the Bulb state panel instead of the run view (TB-Inference.md):
  // without it a bulb that only calls tb.setData meets a Run button whose one outcome is a 400.
  it('reports whether the bulb has an infer.md block', async () => {
    blocks = { infer: '', insight: '', code: '', config: '', data: 'x' }
    expect((await (await fetch(url('/__infer-info'))).json()).hasInfer).toBe(false)
    blocks = { infer: '  \n ', insight: '', code: '', config: '', data: 'x' }
    expect((await (await fetch(url('/__infer-info'))).json()).hasInfer).toBe(false)
    blocks = { infer: 'Echo it back.', insight: '', code: '', config: '', data: 'x' }
    expect((await (await fetch(url('/__infer-info'))).json()).hasInfer).toBe(true)
  })

  it('passes the bulb config.inference labels through', async () => {
    blocks = {
      infer: 'x', insight: '', code: '', data: '',
      config: '{"inference": {"title": "Generate Equation", "dataTitle": "Describe your equation", "submitTitle": "Generate Plot"}}',
    }
    const info = await (await fetch(url('/__infer-info'))).json()
    expect(info.inference).toEqual({ title: 'Generate Equation', dataTitle: 'Describe your equation', submitTitle: 'Generate Plot' })
  })
})

describe('/__infer-ui.js', () => {
  it('serves the modal module as JavaScript', async () => {
    const r = await fetch(url('/__infer-ui.js'))
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toContain('javascript')
    expect(await r.text()).toContain('export function runInference')
  })

  // The modal is a string no compiler ever parses (TB-Inference.md's plain-string decision) —
  // this is the parser: a typo in the string fails here instead of at first click.
  it('parses as a real ES module exporting runInference', async () => {
    const file = join(tmpdir(), `tb-infer-ui-${process.pid}-${Date.now()}.mjs`)
    await writeFile(file, inferModalJs)
    try {
      const mod = await import(pathToFileURL(file).href)
      expect(typeof mod.runInference).toBe('function')
    } finally {
      await rm(file, { force: true })
    }
  })
})

describe('/__tb-decode', () => {
  it('round-trips a fragment the encoder produced', async () => {
    const hash = encodeToHash({ insight: { words: 4 }, insightJson: '{"words": 4}', data: ['alpha beta'] })
    const res = await (await post('/__tb-decode', { hash })).json()
    expect(res.insight).toEqual({ words: 4 })
    expect(res.data).toEqual(['alpha beta'])
  })

  it('answers { error } for garbage and missing fragments', async () => {
    expect((await (await post('/__tb-decode', { hash: '#tb=1:corrupt!!' })).json()).error).toBeTruthy()
    expect((await (await post('/__tb-decode', {})).json()).error).toBeTruthy()
  })
})

describe('/__tb-encode', () => {
  it('round-trips a data-only payload through decode', async () => {
    const { hash } = await (await post('/__tb-encode', { data: ['alpha'] })).json()
    expect(hash.startsWith('#tb=1:')).toBe(true)
    const back = await (await post('/__tb-decode', { hash })).json()
    expect(back.data).toEqual(['alpha'])
    // The slot nobody set stays absent, so the page falls through to insight.json.
    expect(back.insight).toBeUndefined()
  })

  it('carries the insight slot when the key is present, null included', async () => {
    const absent = await (await post('/__tb-encode', { data: ['x'] })).json()
    expect((await (await post('/__tb-decode', { hash: absent.hash })).json()).insight).toBeUndefined()
    const set = await (await post('/__tb-encode', { data: ['x'], insight: { a: 1 } })).json()
    expect((await (await post('/__tb-decode', { hash: set.hash })).json()).insight).toEqual({ a: 1 })
    // Presence is the key, not the value — so null survives as a value rather than reading as unset.
    const nul = await (await post('/__tb-encode', { data: ['x'], insight: null })).json()
    expect((await (await post('/__tb-decode', { hash: nul.hash })).json()).insight).toBeNull()
  })

  it('answers an empty hash for empty state and for a payload past the ceiling', async () => {
    expect((await (await post('/__tb-encode', {})).json()).hash).toBe('')
    expect((await (await post('/__tb-encode', { data: [noise(100_000)] })).json()).hash).toBe('')
  })
})

describe('/__infer-save', () => {
  it('hands the posted payload straight to the save callback', async () => {
    const r = await post('/__infer-save', { data: ['chunk'], insight: { a: 1 } })
    expect(r.status).toBe(200)
    expect(saved).toEqual({ data: ['chunk'], insightJson: '{\n  "a": 1\n}' })
  })

  it('saves a run far past the encoding ceiling — filing has no URL limit', async () => {
    const huge = noise(100_000)
    expect(encodeToHash({ data: [huge] })).toBe('')   // unshareable...
    const r = await post('/__infer-save', { data: [huge] })
    expect(r.status).toBe(200)                        // ...but still savable
    expect(saved?.data).toEqual([huge])
  })

  it('leaves the insight block alone when only data was set', async () => {
    const r = await post('/__infer-save', { data: ['only-data'] })
    expect(r.status).toBe(200)
    expect(saved).toEqual({ data: ['only-data'], insightJson: undefined })
  })

  it('400s on an empty payload without calling save', async () => {
    const r = await post('/__infer-save', {})
    expect(r.status).toBe(400)
    expect(saved).toBeNull()
  })
})
