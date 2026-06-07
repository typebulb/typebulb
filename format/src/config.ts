/** The `config.json` block shape — dependencies, description, and inference-modal settings. */

export interface InferenceConfig {
  title?: string
  dataTitle?: string  // Comma-delimited for multiple chunks
  submitTitle?: string
}

export interface BulbConfig {
  dependencies?: Record<string, string>
  description?: string
  inference?: InferenceConfig
  ts?: { jsxImportSource?: string }
}

/** Parse the `config.json` block, returning {} for empty or malformed JSON. */
export function parseConfig(config: string): BulbConfig {
  if (!config.trim()) return {}
  try {
    return JSON.parse(config)
  } catch {
    return {}
  }
}
