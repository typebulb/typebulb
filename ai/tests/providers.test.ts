import { describe, it, expect } from 'vitest'
import { joinUrl, getProvider } from '../src/aiProviders.js'
import type { ProviderProtocol } from '../src/protocol.js'

/**
 * Guards the providers' production wire behavior (web chat, inference, tb.ai, CLI): URL
 * construction, and the Gemini effort-dial translation.
 *
 * The non-negotiable from the URL-cleanup work order: switching off the `new URL(absolutePath,
 * base)` clobber to a prefix-preserving `joinUrl` must NOT change any provider's URL for its
 * default base, AND a base that carries a path prefix must now keep it.
 *
 * `joinUrl(base, getPath(...))` is exactly what `sendAIRequest` does, so asserting it here pins the
 * real request URL without a network round-trip.
 */

/** Resolve the request URL the way sendAIRequest does. `base` defaults to the provider's own
 *  default; pass an override to model a custom/gateway base. */
function urlFor(protocol: ProviderProtocol, base?: string, model = 'm', stream = false): string {
  const spec = getProvider(protocol)
  return joinUrl(base ?? spec.defaultBaseUrl, spec.getPath(model, stream))
}

describe('joinUrl', () => {
  it('appends an absolute path while preserving the base path prefix', () => {
    expect(joinUrl('https://gw.example.com/llm/v1', '/chat/completions'))
      .toBe('https://gw.example.com/llm/v1/chat/completions')
  })

  it('accepts a path without a leading slash', () => {
    expect(joinUrl('https://gw.example.com/llm/v1', 'chat/completions'))
      .toBe('https://gw.example.com/llm/v1/chat/completions')
  })

  it('collapses trailing slashes on the base (one or many)', () => {
    expect(joinUrl('https://x/v1/', '/chat/completions')).toBe('https://x/v1/chat/completions')
    expect(joinUrl('https://x/v1///', '/chat/completions')).toBe('https://x/v1/chat/completions')
  })

  it('preserves a query string carried on the path (gemini SSE)', () => {
    expect(joinUrl('https://x', '/v1beta/models/m:streamGenerateContent?alt=sse'))
      .toBe('https://x/v1beta/models/m:streamGenerateContent?alt=sse')
  })
})

describe('default-base URLs are byte-identical to the production endpoints', () => {
  it('anthropic → /v1/messages', () => {
    expect(urlFor('anthropic')).toBe('https://api.anthropic.com/v1/messages')
  })

  it('openai → /v1/responses (Responses API)', () => {
    expect(urlFor('openai')).toBe('https://api.openai.com/v1/responses')
  })

  it('openrouter → /api/v1/chat/completions (vendor mounts under /api/v1)', () => {
    // Base is the bare origin (matching the web-side stored apiUrl); the join must NOT double /api.
    expect(urlFor('openrouter')).toBe('https://openrouter.ai/api/v1/chat/completions')
  })

  it('gemini → model-in-URL, generate vs streamGenerate', () => {
    expect(urlFor('gemini', undefined, 'gemini-2.0-flash', false))
      .toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent')
    expect(urlFor('gemini', undefined, 'gemini-2.0-flash', true))
      .toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse')
  })

  it('ollama / openai-compat → /chat/completions appended onto a /v1 base', () => {
    // The provider path is the bare operation; the resolver supplies the `/v1` base. Modelling that
    // base here yields the same URL these endpoints answered on before the cleanup.
    expect(urlFor('ollama', 'http://localhost:11434/v1')).toBe('http://localhost:11434/v1/chat/completions')
    expect(urlFor('openai-compat', 'http://localhost:1234/v1')).toBe('http://localhost:1234/v1/chat/completions')
  })
})

describe('a prefixed / gateway base keeps its prefix', () => {
  it('openrouter through a proxy prefix', () => {
    expect(urlFor('openrouter', 'https://gw.example.com/proxy'))
      .toBe('https://gw.example.com/proxy/api/v1/chat/completions')
  })

  it('anthropic through an Azure-style deployment prefix', () => {
    expect(urlFor('anthropic', 'https://x.example.com/openai/deployments/foo'))
      .toBe('https://x.example.com/openai/deployments/foo/v1/messages')
  })
})

/**
 * Guards the Gemini effort-dial translation: 3.x+ models must get the semantic `thinkingLevel`
 * enum (clamped to each family's supported values), 2.5-era models and unversioned aliases the
 * numeric budget. Sending the wrong one (or both) is a 400 upstream.
 */
describe('gemini effort → thinking config translation', () => {
  const thinkingConfig = (model: string, effort?: 0 | 1 | 2 | 3) => {
    const p: any = getProvider('gemini').buildPayload(
      [{ role: 'user', content: 'hi' }], model, { effort, webSearch: false }, false)
    return p.generationConfig?.thinkingConfig
  }

  it('3.5 flash gets the full four-level dial', () => {
    expect(thinkingConfig('gemini-3.5-flash', 0)).toEqual({ thinkingLevel: 'minimal' })
    expect(thinkingConfig('gemini-3.5-flash', 1)).toEqual({ includeThoughts: true, thinkingLevel: 'low' })
    expect(thinkingConfig('gemini-3.5-flash', 2)).toEqual({ includeThoughts: true, thinkingLevel: 'medium' })
    expect(thinkingConfig('gemini-3.5-flash', 3)).toEqual({ includeThoughts: true, thinkingLevel: 'high' })
  })

  it('pre-3.5 3.x floors minimal at low (`minimal` is 3.5+)', () => {
    expect(thinkingConfig('gemini-3-flash-preview', 0)).toEqual({ thinkingLevel: 'low' })
    expect(thinkingConfig('gemini-3.1-pro-preview', 0)).toEqual({ thinkingLevel: 'low' })
  })

  it('2.5-era keeps numeric budgets (0 drops includeThoughts)', () => {
    expect(thinkingConfig('gemini-2.5-flash', 0)).toEqual({ thinkingBudget: 0 })
    expect(thinkingConfig('gemini-2.5-flash', 1)).toEqual({ includeThoughts: true, thinkingBudget: 1024 })
    expect(thinkingConfig('gemini-2.5-flash', 3)).toEqual({ includeThoughts: true, thinkingBudget: -1 })
  })

  it('unversioned aliases fall back to budgets (Google back-compat remaps them)', () => {
    expect(thinkingConfig('gemini-flash-latest', 2)).toEqual({ includeThoughts: true, thinkingBudget: 8192 })
  })

  it('omitted effort sends no thinking config at all', () => {
    expect(thinkingConfig('gemini-3.5-flash', undefined)).toBeUndefined()
  })
})
