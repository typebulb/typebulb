import { loadEnv } from '../env.js'
import { getFilteredModels, hasAnyProviderKey, formatModelsList, PROVIDER_ENV_KEYS } from '../serve/modelCatalog.js'

/**
 * `typebulb models` — list the AI models reachable from `tb.ai`, filtered by the API keys in the
 * cwd `.env` cascade: the same catalog + filter `tb.models()` uses in a running bulb, exposed at
 * authoring time so an agent lists known model ids instead of guessing one from memory, which only
 * errors as an upstream provider failure at runtime (Specs/Typebulb-CLI.md, Specs/TB-AI.md).
 * Needs no running bulb. Discovery, not restriction — `tb.ai` accepts any id your keys cover.
 */
export async function runModels(mode: string | undefined): Promise<void> {
  loadEnv(mode)
  // Probe first: the list covers both cloud (key-filtered catalog) and locally-discovered Ollama
  // models, so an Ollama-only setup with no cloud keys still lists.
  const models = await getFilteredModels()
  if (models.length > 0) {
    console.log(formatModelsList(models, process.env.TB_AI_PROVIDER, process.env.TB_AI_MODEL))
    return
  }
  // Empty list. Distinguish "no keys and no local server" (tell the user what to set) from "keys
  // present but catalog unreachable" (offline).
  if (!hasAnyProviderKey()) {
    console.log("No AI provider keys found in this directory's .env, and no local Ollama server detected.")
    console.log('Set one of these to use a cloud model with tb.ai:')
    for (const [protocol, envKey] of Object.entries(PROVIDER_ENV_KEYS)) {
      console.log(`  ${envKey.padEnd(20)} (${protocol})`)
    }
    console.log('…or start Ollama (http://localhost:11434, or set OLLAMA_HOST) for local models. Then re-run `typebulb models`.')
    return
  }
  console.log("Couldn't fetch the model catalog (offline?). tb.ai still works with any valid provider/model id for your keys.")
}
