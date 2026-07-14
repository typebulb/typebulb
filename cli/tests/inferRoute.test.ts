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
let saved: { data: string[]; insightJson: string } | null = null
const url = (p: string) => `http://127.0.0.1:${server.port}${p}`
const post = (p: string, body: unknown) => fetch(url(p), {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})

const ENV_KEYS = ['TB_AI_PROVIDER', 'TB_AI_MODEL', 'ANTHROPIC_API_KEY']
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
    expect(info).toEqual({ provider: 'anthropic', model: 'claude-haiku-4-5-20251001', data: [] })
  })

  it('serves the SOURCE data chunks as the modal seed', async () => {
    blocks = { infer: 'x', insight: '', code: '', config: '', data: 'chunk one\n\n\nchunk two' }
    const info = await (await fetch(url('/__infer-info'))).json()
    expect(info.data).toEqual(['chunk one', 'chunk two'])
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

describe('/__infer-decode', () => {
  it('round-trips a fragment the encoder produced', async () => {
    const hash = encodeToHash({ insight: { words: 4 }, insightJson: '{"words": 4}', data: ['alpha beta'] })
    const res = await (await post('/__infer-decode', { hash })).json()
    expect(res.insight).toEqual({ words: 4 })
    expect(res.data).toEqual(['alpha beta'])
  })

  it('answers { error } for garbage and missing fragments', async () => {
    expect((await (await post('/__infer-decode', { hash: '#tb=1:corrupt!!' })).json()).error).toBeTruthy()
    expect((await (await post('/__infer-decode', {})).json()).error).toBeTruthy()
  })
})

describe('/__infer-save', () => {
  it('decodes the fragment and hands data + insightJson to the save callback', async () => {
    const hash = encodeToHash({ insight: { a: 1 }, insightJson: '{"a": 1}', data: ['chunk'] })
    const r = await post('/__infer-save', { hash })
    expect(r.status).toBe(200)
    expect(saved).toEqual({ data: ['chunk'], insightJson: '{\n  "a": 1\n}' })
  })

  it('400s on an undecodable fragment without calling save', async () => {
    const r = await post('/__infer-save', { hash: '#tb=1:junk' })
    expect(r.status).toBe(400)
    expect(saved).toBeNull()
  })
})
