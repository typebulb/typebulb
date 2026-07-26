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

// One options shape, reused by tb.ai() and tb.ai.stream().
const aiOptions = `options: {
    messages: Array<{ role: "user" | "assistant"; content: string }>;
    system?: string;
    /** Reasoning effort hint: 0=minimal, 1=low, 2=med, 3=high. Mapped to each provider's native mechanism (OpenAI/OpenRouter reasoning effort, Gemini thinking budget, Anthropic adaptive thinking). 0 minimizes reasoning — a floor, not a guaranteed "off": some models still think a little at 0, and adaptive models already self-skip at 1 (low). Level 1 (low) is the sensible default for most work; reach for 0 only when you truly want minimal deliberation. Omit for the model's own default. */
    effort?: 0 | 1 | 2 | 3;
    provider?: string;
    model?: string;
    /** Enable/disable web search. Default: on for BYOK, always off for free model. */
    webSearch?: boolean;
    /** Abort the request. On abort the promise rejects / the stream ends. */
    signal?: AbortSignal;
  }`

/** A streamed delta from \`tb.ai.stream()\` — a discriminated union, exactly one kind per chunk. */
const aiChunkType = `
/** A single streamed delta from \`tb.ai.stream()\`. Discriminated by \`kind\`. */
type AiChunk =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string };
`

const ai = `
  /**
   * General-purpose AI call. \`tb.ai(opts)\` resolves with the full text; \`tb.ai.stream(opts)\`
   * returns an async iterable of {@link AiChunk} deltas you consume with \`for await\`.
   *
   * @returns Promise resolving to { text: string }
   * @throws On rate limit, network error, or provider error
   */
  ai: {
    (${aiOptions}): Promise<{ text: string }>;
    /**
     * Streaming counterpart of \`tb.ai()\`. Yields \`{ kind: "text" | "reasoning", text }\` deltas
     * as they arrive; break the loop (or abort \`signal\`) to cancel and stop the upstream.
     *
     * \`kind: "reasoning"\` deltas only arrive when you pass \`effort: 1-3\` AND use a
     * thinking-capable model; otherwise the stream is \`text\`-only.
     *
     * @example
     * let answer = "";
     * for await (const c of tb.ai.stream({ messages })) {
     *   if (c.kind === "text") answer += c.text;
     * }
     */
    stream(${aiOptions}): AsyncIterable<AiChunk>;
  };`

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
    /** True on the .env-configured default model (TB_AI_PROVIDER + TB_AI_MODEL); absent otherwise */
    default?: boolean;
  }>>;
  /**
   * Whether the user's own AI keys back \`tb.ai\`. False means only the
   * quota-limited courtesy model is available (or no AI at all) — a bulb
   * making many AI calls should check this and show a "use your own keys"
   * notice instead of running.
   */
  hasOwnKeys(): Promise<boolean>;`

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
   * Relative paths resolve against the bulb's folder (\`tb.dir\` —
   * \`<bulb-dir>/<filename-stem>/\`, created on demand), so
   * \`tb.fs.write('results.json')\` lands beside the bulb. \`../\` reaches sibling
   * bulbs' folders; everything stays confined to the project (the launch cwd).
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

const dir = `
  /**
   * The bulb's folder — absolute path to \`<bulb-dir>/<filename-stem>/\`
   * (or its \`batches/<name>/\` folder when the run is scoped with \`--batch\`).
   *
   * For interop only (handing a path to \`server.ts\` or a spawned tool):
   * \`tb.fs\` already resolves relative paths against it, so bulb code writing
   * its own files never needs it. CLI only — throws in editor/published/embedded mode.
   */
  readonly dir: string;`

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

const onMessage = `
  /**
   * Subscribe to a value pushed from the terminal via \`typebulb send <file> [message]\`.
   *
   * The dual of \`tb.log\` (data out): a value sent *in* from the CLI, no \`--trust\` required.
   * Use it to start expensive work on demand instead of on load — e.g. \`tb.onMessage(() => start())\`
   * — so hot reloads don't re-trigger it while you edit, and an agent kicks off one run when ready.
   *
   * The message is the JSON-parsed value of what \`send\` was given (or the raw string if it isn't
   * JSON; \`undefined\` for a bare \`typebulb send <file>\`). A non-\`undefined\` return value (awaited)
   * becomes the reply \`send --wait\` prints on stdout — JSON-serializable, at most one handler
   * replying — the structured read-back for self-tests. Returns an unsubscribe function. Inert in
   * an embedded bulb (no sender) — the handler is registered but never fires.
   *
   * @param handler - Called with each pushed message; may return a JSON-serializable reply.
   * @returns An unsubscribe function.
   */
  onMessage(handler: (message: any) => unknown): () => void;`

const log = `
  /**
   * Print to the CLI's stdout — the bulb's log channel, read back with \`typebulb logs <file>\`.
   *
   * Ungated: needs no \`server.ts\` block and no \`--trust\`, so a Restricted client-only bulb can
   * instrument itself. Args cross to the CLI as JSON; where no CLI serves the page (web, embedded,
   * or a transport failure) it falls back to the browser console. Works in \`server.ts\` too (same
   * as \`console.log\` there).
   */
  log(...args: any[]): void;`

const clientServerProxy = `
  /**
   * Server-side function proxy.
   *
   * In the CLI, calls exported functions from the \`**server.ts**\` section.
   *
   * A normal export is awaited for its result (\`await tb.server.fn()\`). An \`async function*\`
   * export streams: \`for await (const chunk of tb.server.gen())\`. The call object supports both;
   * break the \`for await\` to cancel and tear down the server generator.
   */
  server: Record<string, (...args: any[]) => Promise<any> & AsyncIterable<any>>;`

/** Typebulb globals available in browser-side code (code.tsx). */
export const clientTbTypings = `${aiChunkType}
/**
 * Typebulb utilities namespace.
 * Type \`tb.\` to discover available helpers.
 */
declare const tb: {${dataAndJson}${clientOnlyMembers}${insight}${log}${clientServerProxy}${onMessage}${ai}${fs}${dir}${models}${theme}${mode}
};
`

const serverLog = `
  /**
   * Print to the CLI's stdout — the same channel as \`console.log\` here (the server's console IS
   * the bulb's log). One log verb across blocks: page-side \`tb.log\` reaches this same stdout.
   */
  log(...args: any[]): void;`

/** Typebulb globals available in Node-side code (server.ts).
 *  Only what carries a bulb-specific rule Node can't know — tb.ai, tb.fs, tb.dir (TB-FS.md);
 *  plus the tb.log uniformity exception (serverTb.ts). The browser-only helpers are intentionally
 *  absent. Must match serverTb.ts's runtime surface. */
export const serverTbTypings = `${aiChunkType}
/**
 * Typebulb utilities namespace (server-side).
 * Type \`tb.\` to discover available helpers.
 */
declare const tb: {${serverLog}${ai}${fs}${dir}${models}${mode}
};
`
