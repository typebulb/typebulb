/**
 * OpenRouter API (Chat Completions style with choices[]) — request building; wire types and
 * parsing shared via ChatCompletionsProvider.
 */
import type { ChatMessageDto, EffortLevel } from '../protocol.js'
import type { ChatRequestOpts } from '../aiProvider.js'
import { ChatCompletionsProvider } from './chatCompletions.js'

/** OpenRouter web search plugin */
interface OpenRouterWebPlugin {
  id: 'web'
  max_results?: number
}

/** OpenRouter request payload */
export type OpenRouterRequestPayload = {
  model: string
  messages: ChatMessageDto[]
  stream: boolean
  reasoning?: { effort: 'none' | 'low' | 'medium' | 'high' }
  plugins?: OpenRouterWebPlugin[]
}

export class OpenRouterProvider extends ChatCompletionsProvider {
  protected readonly providerName = 'OpenRouter'
  // First-party convention (like anthropic/openai/gemini): the base is the bare origin and the
  // full versioned mount lives in `path`. OpenRouter mounts its OpenAI-compatible API at `/api/v1`
  // (not `/v1`), so the path carries `/api/v1/…` — the vendor's real mount, the way gemini's path
  // carries `/v1beta`. Keeping `/api` in the path (not the base) also matches the web-side stored
  // `apiUrl` of `https://openrouter.ai`, so the prefix-preserving join yields the identical URL on
  // both web and CLI. (Do NOT put `/api` in the base too — the join would then double it to `/api/api`.)
  readonly defaultBaseUrl = 'https://openrouter.ai'
  readonly path: string = '/api/v1/chat/completions'

  // 0 → `none` (reasoning off): OpenRouter normalizes this across providers, and it's the robust floor
  // (its `minimal` isn't supported by every underlying model, e.g. gpt-5.4-mini).
  private readonly effortMap: Record<EffortLevel, 'none' | 'low' | 'medium' | 'high'> = {
    0: 'none',
    1: 'low',
    2: 'medium',
    3: 'high'
  }

  // ── Request building ─────────────────────────────────────────────

  buildHeaders(apiKey: string, origin?: string): Record<string, string> {
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${apiKey}`,
      'x-api-key': apiKey,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-Title': 'Typebulb'
    }

    if (origin) {
      headers['HTTP-Referer'] = origin
      headers['Referer'] = origin
      headers['Origin'] = origin
    }

    return headers
  }

  buildPayload(
    messages: ChatMessageDto[],
    model: string,
    opts: ChatRequestOpts,
    stream: boolean
  ): OpenRouterRequestPayload {
    const payload: OpenRouterRequestPayload = {
      model,
      messages,
      stream
    }

    // Web search disabled for OpenRouter - $0.02/request via Exa.ai is expensive
    if (opts?.webSearch === true) {
      payload.plugins = [{ id: 'web' }]
    }

    const effort = opts?.effort
    if (effort !== undefined) {
      payload.reasoning = {
        effort: this.effortMap[effort]
      }
    }

    return payload
  }
}
