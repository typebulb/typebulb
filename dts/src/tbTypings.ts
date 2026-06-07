/**
 * `tb` global typings for Typebulb bulbs.
 *
 * Two flavors:
 * - `clientTbTypings` — full surface available in browser-side code (code.tsx)
 * - `serverTbTypings` — Node-flavored subset available in server-side code (server.ts)
 *
 * Single source of truth for Monaco IntelliSense (web client), the standalone
 * TypeChecker, and the CLI's emitted typecheck dirs.
 */

const dataAndJson = `
  /**
   * Get raw data chunk from the Data tab.
   * @param index - Chunk index (0-based). Separate chunks with 2 blank lines.
   */
  data(index: number): string;
  /**
   * Get data chunk parsed as JSON (handles JSON-ish with unquoted keys).
   * @param index - Chunk index (0-based)
   * @throws If chunk is not valid JSON/JSON-ish
   */
  json<T = unknown>(index: number): T;`

const insight = `
  /**
   * Get the insight data produced by the inference layer.
   *
   * Returns the parsed JSON from insight.json, populated by the inference LLM.
   * Use a type parameter to get typed access to the insight data.
   *
   * @returns The parsed insight JSON, or undefined if no insight is available
   */
  insight<T = unknown>(): T | undefined;`

const ai = `
  /**
   * General-purpose AI call.
   *
   * @param options - Messages, system prompt, optional provider/model override
   * @returns Promise resolving to { text: string }
   * @throws On rate limit, network error, or provider error
   */
  ai(options: {
    messages: Array<{ role: "user" | "assistant"; content: string }>;
    system?: string;
    /** Reasoning depth hint (0=min, 1=low, 2=med, 3=max). Mapped to provider-specific parameters (e.g. Anthropic adaptive thinking, OpenAI reasoning effort). Default: 0. */
    reasoning?: 0 | 1 | 2 | 3;
    provider?: string;
    model?: string;
    /** Enable/disable web search. Default: on for BYOK, always off for free model. */
    webSearch?: boolean;
  }): Promise<{ text: string }>;`

const models = `
  /**
   * Returns AI models available to the current user.
   * Models are filtered by the user's configured API keys.
   * If no keys are configured, returns only the courtesy model.
   */
  models(): Promise<Array<{
    /** Provider protocol: "anthropic", "openai", "gemini", "openrouter" */
    provider: string;
    /** Model identifier, e.g. "claude-sonnet-4-6" */
    name: string;
    /** Human-readable display name, e.g. "Sonnet 4.6" */
    friendlyName: string;
    /** Provider display name, e.g. "Anthropic" */
    providerName: string;
  }>>;`

const theme = `
  /**
   * The bulb's theme override (\`<html data-theme>\`).
   *
   * - Get: the current override — \`'dark'\` | \`'light'\`, or \`undefined\` when
   *   following the OS preference.
   * - Set \`'dark'\`/\`'light'\` to force and persist it (per-bulb); set
   *   \`undefined\` to clear the override and follow the OS again.
   *
   * Drives \`<html data-theme>\`, so render off \`html[data-theme="…"]\` selectors
   * (or observe the attribute) rather than reading \`tb.theme\`.
   */
  theme: 'light' | 'dark' | undefined;`

const mode = `
  /**
   * The mode this bulb is running in.
   *
   * - \`'local'\` — Running via the typebulb CLI
   * - \`'editor'\` — Running in the typebulb.com editor
   * - \`'published'\` — Running as a published/standalone bulb on typebulb.com
   * - \`'embedded'\` — Running as a bulb embedded inside another bulb (sandboxed,
   *   client-only: AI, filesystem, and server RPC are unavailable)
   */
  mode: 'local' | 'editor' | 'published' | 'embedded';`

const fs = `
  /**
   * Local filesystem access (CLI only).
   *
   * Paths are resolved relative to the directory containing the bulb file.
   * Throws in editor/published mode.
   */
  fs: {
    /** Read a file as UTF-8 text. Throws if the file is not valid UTF-8 — use readBytes for binary. */
    read(path: string): Promise<string>;
    /** Read a file as raw bytes. */
    readBytes(path: string): Promise<Uint8Array>;
    /** Write text or raw bytes to a file. Creates parent directories if needed. */
    write(path: string, content: string | Uint8Array): Promise<boolean>;
  };`

const serverLogOnly = `
  /**
   * Server-side function proxy. The built-in \`log\` prints to CLI stdout
   * (falls back to console.log on web). On the server side, this object only
   * exposes \`log\` — server-to-server calls are not supported.
   */
  server: {
    log(...args: any[]): Promise<void>;
  };`

const clientOnlyMembers = `
  /**
   * Async value inspector for tensor-like objects.
   *
   * Materializes lazy values (like GPU tensors) and logs them with metadata.
   * Handles objects with \`.js()\`, \`.data()\`, \`.array()\`, \`.arraySync()\`, etc.
   *
   * @remarks
   * - Always use \`await\` - materialization may be async (GPU→CPU readback)
   * - Large values are truncated (max 1000 elements)
   * - Promises are logged as \`[Promise]\` (not awaited - could hang)
   */
  dump(...args: any[]): Promise<void>;
  /**
   * Trigger inference to generate new insight data.
   *
   * Opens a confirmation modal showing the data to be analyzed, then streams
   * the inference result. On success, updates the insight so subsequent
   * \`tb.insight()\` calls return the new value.
   *
   * @param opts - Options for inference
   * @param opts.data - Data to pre-populate in the modal (string or array of strings). If omitted, modal opens with empty textarea for user to paste.
   * @returns Promise that resolves with the parsed insight JSON
   * @throws If inference is already in progress, or on network/parse/rate limit errors
   */
  infer<T = unknown>(opts?: { data?: string | string[] }): Promise<T>;
  /**
   * Get the current inference state.
   *
   * @returns 'idle' | 'running' | 'complete' | 'error'
   */
  inferenceState(): 'idle' | 'running' | 'complete' | 'error';
  /**
   * Set a data chunk for the next inference call.
   *
   * Use this to programmatically set data that will be sent when \`tb.infer()\` is called
   * without the \`data\` option.
   *
   * @param index - The chunk index (0-based)
   * @param content - The content for this chunk
   */
  setData(index: number, content: string): void;
  /**
   * Proxy a CDN URL through the sandbox origin for Web Worker/WASM same-origin loading.
   *
   * In the sandbox, prepends \`/proxy/\` so the URL is served from the same origin.
   * Outside the sandbox (exported HTML, CLI), returns the URL unchanged.
   *
   * @param url - Full HTTPS URL to an allowlisted CDN (esm.sh, unpkg.com, cdn.jsdelivr.net, cdnjs.cloudflare.com)
   * @returns The proxied URL (sandbox) or the original URL (standalone/CLI)
   */
  proxy(url: string): string;
  /**
   * Copy text to clipboard.
   * Must be called synchronously within a user gesture (click/keydown).
   * @returns true if successful, false otherwise
   */
  copy(text: string): Promise<boolean>;
  /**
   * Get the canonical URL of this bulb.
   *
   * Returns the parent typebulb.com URL (including path, query, and \`#tb=\` fragment),
   * resolving correctly from inside the cross-origin sandbox iframe.
   * Use this instead of \`location.href\` or \`document.referrer\`.
   *
   * @returns The full canonical URL
   */
  url(): Promise<string>;`

const clientServerProxy = `
  /**
   * Server-side function proxy.
   *
   * In the CLI, calls exported functions from the \`**server.ts**\` section.
   * \`tb.server.log(...)\` is a built-in that prints to CLI stdout (falls back to console.log on web).
   * User exports override built-ins of the same name.
   */
  server: Record<string, (...args: any[]) => Promise<any>>;`

/** Typebulb globals available in browser-side code (code.tsx). */
export const clientTbTypings = `
/**
 * Typebulb utilities namespace.
 * Type \`tb.\` to discover available helpers.
 */
declare const tb: {${dataAndJson}${clientOnlyMembers}${insight}${clientServerProxy}${ai}${fs}${models}${theme}${mode}
};
`

/** Typebulb globals available in Node-side code (server.ts). */
export const serverTbTypings = `
/**
 * Typebulb utilities namespace (server-side).
 * Type \`tb.\` to discover available helpers.
 */
declare const tb: {${dataAndJson}${insight}${ai}${fs}${serverLogOnly}${models}${mode}
};
`
