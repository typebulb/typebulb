/**
 * A generic OpenAI-compatible Chat Completions client (`/v1/chat/completions`, choices[]) — wire
 * types and parsing shared via ChatCompletionsProvider. Backs two CLI-only protocols (see
 * runtime/cli/src/serve/server.ts `resolveLocalProvider`):
 *   - `ollama`        — zero-config preset: keyless, base URL OLLAMA_HOST / http://localhost:11434.
 *   - `openai-compat` — generic: base URL TB_AI_BASE_URL, optional key TB_AI_API_KEY (LM Studio,
 *                       vLLM, a self-hosted endpoint, a keyed proxy, a cloud OpenAI-compat vendor).
 * Auth is optional — `buildHeaders` sends `Bearer <key>` only when a key is present.
 *
 * It's its own class (not OpenAIProvider) because the `openai` protocol targets the Responses API
 * (`/v1/responses`), which these endpoints don't implement. Ollama's native `/api/chat` (NDJSON,
 * first-class `message.thinking`, `num_ctx`/`think` options) is out of scope for tb.ai — reach it
 * via a server.ts export. See runtime-specs/TB-Custom-Providers.md.
 */
import type { ChatMessageDto } from '../protocol.js'
import type { ChatRequestOpts } from '../aiProvider.js'
import { ChatCompletionsProvider } from './chatCompletions.js'

/** Ollama OpenAI-compatible request payload */
export type OllamaRequestPayload = {
  model: string
  messages: ChatMessageDto[]
  stream: boolean
}

export class OllamaProvider extends ChatCompletionsProvider {
  protected readonly providerName = 'Ollama'
  // Bring-your-own-endpoint convention: the base is the OpenAI-style root ending in `/v1` and the
  // operation path is just `/chat/completions` — paste-compatible with every OpenAI-compat vendor
  // (OpenAI `…/v1`, Groq `…/openai/v1`, vLLM/LM Studio `…/v1`). The `/v1` is supplied by the base,
  // not the path: the CLI resolver hands `openai-compat` the user's TB_AI_BASE_URL (a `/v1` base)
  // and `ollama` a `${OLLAMA_HOST}/v1` base (resolveLocalProvider in runtime/cli/src/serve/localProvider.ts).
  // `defaultBaseUrl` stays the bare origin because it's only the fallback for OLLAMA_HOST (Ollama's
  // own env var, an origin); the resolver appends `/v1` to it.
  readonly defaultBaseUrl = 'http://localhost:11434'
  readonly path = '/chat/completions'

  // ── Request building ─────────────────────────────────────────────

  // Auth-optional: keyless for local Ollama (empty key from the resolver), or `Bearer <key>` when
  // the OpenAI-compatible endpoint requires one (vLLM --api-key, a self-hosted/proxy, etc.).
  buildHeaders(apiKey: string): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    }
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
    return headers
  }

  // Web search and the reasoning-effort knob have no equivalent on the OpenAI-compat endpoint,
  // so the payload stays minimal. Ollama-specific options (num_ctx, think, …) are intentionally
  // out of scope for tb.ai — use a server.ts export for those (runtime-specs/TB-Server-Streaming.md).
  buildPayload(
    messages: ChatMessageDto[],
    model: string,
    _opts: ChatRequestOpts,
    stream: boolean
  ): OllamaRequestPayload {
    return { model, messages, stream }
  }
}
