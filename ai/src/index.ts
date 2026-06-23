// AI wire protocol types (chat/stream DTOs, ProviderProtocol/ReasoningDepth/TbModelDto)
export * from './protocol.js'

export { AIProvider, ProviderStreamError, type ChatRequestOpts } from './aiProvider.js'
export {
  getProvider,
  sendAIRequest,
  normalizeUpstreamError,
  type ResolvedAIProvider,
  type SendAIRequestOpts
} from './aiProviders.js'
export { parseSseBlock, consumeSseStream, consumeSseStreamGen, consumeStreamText, streamAiChunks } from './sseParser.js'

// Per-provider wire DTOs + provider implementations.
export * from './providers/anthropic.js'
export * from './providers/gemini.js'
export * from './providers/openAI.js'
export * from './providers/openRouter.js'
export * from './providers/ollama.js'
