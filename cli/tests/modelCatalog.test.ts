import { describe, it, expect } from 'vitest'
import { formatModelsList, markDefault } from '../src/serve/modelCatalog.js'
import type { TbModelDto } from 'typebulb/ai'

/**
 * `typebulb models`' pure renderer (Specs/Typebulb-CLI.md, runtime-specs/TB-AI.md). The command's network
 * fetch + key filter is the same `getFilteredModels` the `/__models` route uses (covered live);
 * here we pin the terminal formatting: ids are present and first on the line (greppable), and the
 * configured default is shown only when both halves of the coupled pair are set.
 */
const models: TbModelDto[] = [
  { provider: 'gemini', name: 'gemini-3.1-flash-lite', friendlyName: 'Gemini 3.1 Flash Lt', providerName: 'Gemini' },
  { provider: 'anthropic', name: 'claude-haiku-4-5-20251001', friendlyName: 'Claude Haiku 4.5', providerName: 'Anthropic' },
] as TbModelDto[]

describe('formatModelsList', () => {
  it('lists each model id-first with friendly name and provider', () => {
    const out = formatModelsList(models)
    const flashLine = out.split('\n').find(l => l.includes('gemini-3.1-flash-lite'))!
    expect(flashLine.trimStart().startsWith('gemini-3.1-flash-lite')).toBe(true)
    expect(flashLine).toContain('Gemini 3.1 Flash Lt')
    expect(flashLine).toContain('(gemini)')
    expect(out).toContain('claude-haiku-4-5-20251001')
  })

  it('shows the configured default only when both provider and model are set', () => {
    expect(formatModelsList(models, 'gemini', 'gemini-3.1-flash-lite'))
      .toContain('Default (from .env): gemini / gemini-3.1-flash-lite')
    expect(formatModelsList(models, 'gemini', undefined)).not.toContain('Default (from .env)')
    expect(formatModelsList(models)).not.toContain('Default (from .env)')
  })
})

describe('markDefault', () => {
  it('flags only the row matching both provider and model, without mutating the input', () => {
    const out = markDefault(models, 'anthropic', 'claude-haiku-4-5-20251001')
    expect(out.find(m => m.name === 'claude-haiku-4-5-20251001')!.default).toBe(true)
    expect(out.find(m => m.name === 'gemini-3.1-flash-lite')!.default).toBeUndefined()
    expect(models.some(m => m.default)).toBe(false)
  })

  it('flags nothing when either half of the pair is unset', () => {
    expect(markDefault(models, 'anthropic', undefined).some(m => m.default)).toBe(false)
    expect(markDefault(models, undefined, 'claude-haiku-4-5-20251001').some(m => m.default)).toBe(false)
  })
})
