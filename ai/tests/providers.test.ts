import { describe, it, expect } from 'vitest'
import { joinUrl, getProvider } from '../src/aiProviders.js'
import { asEffort, clampEffort, type EffortLevel, type ProviderProtocol } from '../src/protocol.js'
import { streamAiChunks } from '../src/sseParser.js'

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
  const thinkingConfig = (model: string, effort?: 0 | 1 | 2 | 3 | 4) => {
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

  it('xhigh clamps to high — gemini has no rung above it, and a missing rung never errors', () => {
    expect(thinkingConfig('gemini-3.5-flash', 4)).toEqual({ includeThoughts: true, thinkingLevel: 'high' })
    expect(thinkingConfig('gemini-2.5-flash', 4)).toEqual({ includeThoughts: true, thinkingBudget: -1 })
  })

  it('unversioned aliases fall back to budgets (Google back-compat remaps them)', () => {
    expect(thinkingConfig('gemini-flash-latest', 2)).toEqual({ includeThoughts: true, thinkingBudget: 8192 })
  })

  it('omitted effort sends no thinking config at all', () => {
    expect(thinkingConfig('gemini-3.5-flash', undefined)).toBeUndefined()
  })
})

/**
 * Guards the Anthropic minimal rung: `effort: 0` must send the explicit `thinking.disabled` switch,
 * not merely omit `thinking`. Omission reads as off on 4.6/4.7/4.8, but the 5 family thinks by
 * default, so a silent minimal bought thinking (invisibly, since `display` defaults to 'omitted').
 */
describe('anthropic minimal effort → thinking off', () => {
  const think = (model: string, effort?: 0 | 1 | 2 | 3 | 4) => {
    const p: any = getProvider('anthropic').buildPayload(
      [{ role: 'user', content: 'hi' }], model, { effort, webSearch: false }, false)
    return { thinking: p.thinking, effort: p.output_config?.effort }
  }

  it('minimal disables thinking on the 5 family, where omitting it would not', () => {
    expect(think('claude-opus-5', 0)).toEqual({ thinking: { type: 'disabled' }, effort: 'low' })
    expect(think('claude-sonnet-5', 0)).toEqual({ thinking: { type: 'disabled' }, effort: 'low' })
  })

  it('fable / mythos always think — `disabled` is a 400, so minimal floors to low effort', () => {
    expect(think('claude-fable-5', 0)).toEqual({ thinking: undefined, effort: 'low' })
    expect(think('claude-mythos-5', 0)).toEqual({ thinking: undefined, effort: 'low' })
  })

  it('1–3 keep adaptive thinking with the trace requested', () => {
    expect(think('claude-opus-5', 1))
      .toEqual({ thinking: { type: 'adaptive', display: 'summarized' }, effort: 'low' })
    expect(think('claude-opus-5', 3))
      .toEqual({ thinking: { type: 'adaptive', display: 'summarized' }, effort: 'high' })
  })

  it('pre-4.6 models keep the legacy budget path (0 omits thinking, the off default there)', () => {
    expect(think('claude-3-5-sonnet', 0)).toEqual({ thinking: undefined, effort: undefined })
    expect(think('claude-3-5-sonnet', 2))
      .toEqual({ thinking: { type: 'enabled', budget_tokens: 4096 }, effort: undefined })
  })

  it('xhigh reaches `max`, anthropic\'s own top rung', () => {
    expect(think('claude-opus-5', 4))
      .toEqual({ thinking: { type: 'adaptive', display: 'summarized' }, effort: 'max' })
    expect(think('claude-3-5-sonnet', 4))
      .toEqual({ thinking: { type: 'enabled', budget_tokens: 16384 }, effort: undefined })
  })
})

/**
 * Guards the dial's top rung on the two providers that have one natively. `xhigh` is one word (the
 * spelling OpenAI's own 400 lists), and `none` must stay unsummarized while every thinking level
 * requests its trace.
 */
describe('xhigh (effort 4) → the rung above high', () => {
  const reasoning = (protocol: 'openai' | 'openrouter', effort?: EffortLevel) => {
    const p: any = getProvider(protocol).buildPayload(
      [{ role: 'user', content: 'hi' }], 'gpt-5.6-sol', { effort, webSearch: false }, false)
    return p.reasoning
  }

  it('openai sends xhigh with the summary still requested', () => {
    expect(reasoning('openai', 3)).toEqual({ effort: 'high', summary: 'auto' })
    expect(reasoning('openai', 4)).toEqual({ effort: 'xhigh', summary: 'auto' })
    expect(reasoning('openai', 0)).toEqual({ effort: 'none' })
  })

  it('openrouter sends xhigh — its enum is protocol-wide, per-model support is curated', () => {
    expect(reasoning('openrouter', 4)).toEqual({ effort: 'xhigh' })
  })

  it('the dial accepts 4 and clamps a stored value to it', () => {
    expect(asEffort(4)).toBe(4)
    expect(asEffort(5)).toBeUndefined()
    expect(clampEffort(9)).toBe(4)
    expect(clampEffort(0)).toBe(0)
  })
})

/**
 * Guards the courtesy output cap, which is the only limit on what Typebulb's own key can spend.
 * It used to be poked in as a chat-completions `max_tokens` by the caller, so it silently failed to
 * bind on the two providers that name the field differently. Each provider now writes its own.
 */
describe('maxOutputTokens → each provider\'s own field', () => {
  const payload = (protocol: ProviderProtocol, model: string) =>
    getProvider(protocol).buildPayload(
      [{ role: 'user', content: 'hi' }], model, { maxOutputTokens: 4000, webSearch: false }, false) as any

  it('openai uses max_output_tokens, not max_tokens', () => {
    const p = payload('openai', 'gpt-5.6-sol')
    expect(p.max_output_tokens).toBe(4000)
    expect(p.max_tokens).toBeUndefined()
  })

  it('gemini nests it in generationConfig, surviving alongside thinkingConfig', () => {
    const p: any = getProvider('gemini').buildPayload(
      [{ role: 'user', content: 'hi' }], 'gemini-3.5-flash',
      { maxOutputTokens: 4000, effort: 2, webSearch: false }, false)
    expect(p.generationConfig.maxOutputTokens).toBe(4000)
    expect(p.generationConfig.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: 'medium' })
    expect(p.max_tokens).toBeUndefined()
  })

  it('chat-completions shapes keep max_tokens', () => {
    expect(payload('openrouter', 'openai/gpt-5.6-sol').max_tokens).toBe(4000)
  })

  it('anthropic takes the smaller of the cap and the model ceiling', () => {
    expect(payload('anthropic', 'claude-opus-5').max_tokens).toBe(4000)
    const uncapped: any = getProvider('anthropic').buildPayload(
      [{ role: 'user', content: 'hi' }], 'claude-opus-5', { webSearch: false }, false)
    expect(uncapped.max_tokens).toBe(64000)
  })
})

/**
 * Guards the web-search default: a bare call must not attach a search tool — the spend decision is
 * the caller's (TB-AI.md invariant 16), matching every provider API's own default of off.
 */
describe('webSearch → opt-in, never a default tool', () => {
  const searchPayload = (protocol: ProviderProtocol, model: string, webSearch?: boolean) =>
    getProvider(protocol).buildPayload(
      [{ role: 'user', content: 'hi' }], model, { webSearch }, false) as any

  it('omitted webSearch attaches no tool on any provider', () => {
    expect(searchPayload('anthropic', 'claude-opus-5').tools).toBeUndefined()
    expect(searchPayload('openai', 'gpt-5.6-sol').tools).toBeUndefined()
    expect(searchPayload('gemini', 'gemini-3.5-flash').tools).toBeUndefined()
    expect(searchPayload('openrouter', 'openai/gpt-5.6-sol').plugins).toBeUndefined()
  })

  it('webSearch: true attaches each provider\'s native tool', () => {
    expect(searchPayload('anthropic', 'claude-opus-5', true).tools)
      .toEqual([{ type: 'web_search_20250305', name: 'web_search' }])
    expect(searchPayload('openai', 'gpt-5.6-sol', true).tools).toEqual([{ type: 'web_search' }])
    expect(searchPayload('gemini', 'gemini-3.5-flash', true).tools).toEqual([{ google_search: {} }])
    expect(searchPayload('openrouter', 'openai/gpt-5.6-sol', true).plugins).toEqual([{ id: 'web' }])
  })
})

/**
 * Guards token-usage reporting (TB-AI.md: the un-deferred usage decision). Every provider reports
 * real counts and the parsers must keep them: normalized `{ input, output, reasoning?, cacheRead? }`
 * with `input` inclusive of cache reads, `output` inclusive of reasoning, subsets itemized where
 * the provider splits them. The chat-completions stream only reports usage under the
 * `stream_options.include_usage` opt-in, as a final chunk whose `choices` is empty.
 */
describe('usage → kept, normalized, never estimated', () => {
  it('anthropic splits usage across message_start (input side) and message_delta (output)', () => {
    const p = getProvider('anthropic')
    expect(p.parseStreamChunk({
      type: 'message_start',
      message: { usage: { input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 5, output_tokens: 1 } }
    })).toEqual({ usage: { input: 105, output: 1, cacheRead: 90 } })
    expect(p.parseStreamChunk({ type: 'message_delta', delta: {}, usage: { output_tokens: 250 } }))
      .toEqual({ usage: { input: undefined, output: 250, cacheRead: undefined } })
  })

  it('openai reports complete usage on response.completed, subsets itemized', () => {
    const piece = getProvider('openai').parseStreamChunk({
      type: 'response.completed',
      response: {
        object: 'response',
        usage: {
          input_tokens: 70, output_tokens: 1500,
          input_tokens_details: { cached_tokens: 64 },
          output_tokens_details: { reasoning_tokens: 1400 }
        }
      }
    })
    expect(piece).toEqual({ usage: { input: 70, output: 1500, reasoning: 1400, cacheRead: 64 } })
  })

  it('gemini normalizes output to answer + thoughts (its counts are disjoint)', () => {
    const piece = getProvider('gemini').parseStreamChunk({
      candidates: [{ content: { role: 'model', parts: [{ text: 'hi' }] } }],
      usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 30, thoughtsTokenCount: 270 }
    })
    expect(piece).toEqual({ text: 'hi', reasoning: undefined, usage: { input: 40, output: 300, reasoning: 270, cacheRead: undefined } })
  })

  it('chat-completions reads the usage-only final chunk despite its empty choices', () => {
    const piece = getProvider('openrouter').parseStreamChunk({
      choices: [],
      usage: { prompt_tokens: 26, completion_tokens: 900, completion_tokens_details: { reasoning_tokens: 700 } }
    })
    expect(piece).toEqual({ text: undefined, reasoning: undefined, usage: { input: 26, output: 900, reasoning: 700, cacheRead: undefined } })
  })

  it('chat-completions builders opt in to stream usage — and only on streams', () => {
    const payload = (protocol: ProviderProtocol, stream: boolean) =>
      getProvider(protocol).buildPayload([{ role: 'user', content: 'hi' }], 'm', undefined, stream) as any
    expect(payload('openrouter', true).stream_options).toEqual({ include_usage: true })
    expect(payload('openrouter', false).stream_options).toBeUndefined()
    expect(payload('ollama', true).stream_options).toEqual({ include_usage: true })
    expect(payload('ollama', false).stream_options).toBeUndefined()
    // The other providers volunteer usage; their payloads carry no such flag.
    expect(payload('openai', true).stream_options).toBeUndefined()
    expect(payload('anthropic', true).stream_options).toBeUndefined()
  })

  const sse = (events: unknown[]) =>
    new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''))

  it('streamAiChunks merges the fragments into ONE final usage chunk after the deltas', async () => {
    const response = sse([
      { type: 'message_start', message: { usage: { input_tokens: 12, cache_read_input_tokens: 88, output_tokens: 1 } } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hel' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } },
      { type: 'message_delta', delta: {}, usage: { output_tokens: 42 } },
      { type: 'message_stop' }
    ])
    const chunks = []
    for await (const c of streamAiChunks(response, 'anthropic')) chunks.push(c)
    expect(chunks).toEqual([
      { kind: 'text', text: 'hel' },
      { kind: 'text', text: 'lo' },
      { kind: 'usage', usage: { input: 100, output: 42, reasoning: undefined, cacheRead: 88 } }
    ])
  })

  it('a stream with no usage events emits no usage chunk (absence, not zeros)', async () => {
    const response = sse([
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }
    ])
    const chunks = []
    for await (const c of streamAiChunks(response, 'anthropic')) chunks.push(c)
    expect(chunks).toEqual([{ kind: 'text', text: 'hi' }])
  })
})
