// AI wire protocol types (chat/stream DTOs, ProviderProtocol/EffortLevel/TbModelDto)
export * from './protocol.js'

export { AIProvider, ProviderStreamError, type ChatRequestOpts } from './aiProvider.js'
export {
  getProvider,
  sendAIRequest,
  normalizeUpstreamError,
  type ResolvedAIProvider,
  type SendAIRequestOpts
} from './aiProviders.js'
export { parseSseBlock, consumeSseStream, consumeSseStreamGen, consumeStreamText, consumeStreamResult, streamAiChunks } from './sseParser.js'

// Inference layer shared with typebulb.com: prompt template, JSON sanitizer, #tb= result encoding.
export {
  buildInferencePrompt,
  sanitizeJsonOutput,
  encodeToHash,
  decodeFromHash,
  hashContainsTb,
  type InferenceScriptContent,
  type SanitizeResult,
  type RuntimeState,
  type RuntimeStatePair
} from './inference.js'

// Per-provider wire DTOs + provider implementations.
export * from './providers/chatCompletions.js'
export * from './providers/anthropic.js'
export * from './providers/gemini.js'
export * from './providers/openAI.js'
export * from './providers/openRouter.js'
export * from './providers/ollama.js'
