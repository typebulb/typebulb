/**
 * The `tb` global for `server.ts` code. Unlike the browser (where `tb.ai` postMessages the parent
 * frame, which HTTP-hops to `/__ai`), server.ts runs in this same Node process — so `tb.ai` is a
 * direct in-process call to the very functions `/__ai` uses (resolve from .env → stream → project to
 * text/chunks). No bridge, no round trip. Injected onto `globalThis` before the bulb's server module
 * is imported (pipeline.ts `importServerModule`), so the module's free `tb` reference resolves to it —
 * the same mechanism the browser shim uses. Only reached under trust (server.ts imports only when
 * trusted), so it inherits the same key access as the HTTP route.
 *
 * Surface rule (TB-FS.md): mirror what carries a bulb-specific rule Node can't know — `tb.ai`
 * (.env provider resolution), `tb.fs` (relative→bulb's-folder resolution, creation on write),
 * `tb.dir` — never what plain Node or the browser already owns (theme, proxy, copy). One uniformity
 * exception: `tb.log` is `console.log` here, so the bulb's one log verb works in every block —
 * page-side `tb.log` reaches this same stdout over `/__log`, and erroring instead would punish the
 * agent that logs the same way in both.
 */

import type { AiChunk, ProviderProtocol, TbModelDto } from 'typebulb/ai'
import { consumeStreamText, streamAiChunks, normalizeUpstreamError } from 'typebulb/ai'
import { resolveLocalProvider, sendTbAi } from './localProvider.js'
import { getFilteredModels, hasOwnKeys } from './modelCatalog.js'
import { readFsBytes, writeFsFile } from './tbFs.js'

interface TbAiOptions {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  system?: string
  effort?: 0 | 1 | 2 | 3
  provider?: string
  model?: string
  webSearch?: boolean
  signal?: AbortSignal
}

/** Resolve + send, throwing a plain Error (the resolution message, or the normalized upstream error)
 *  so bulb `try/catch` sees one Error type — the in-process analog of the HTTP route's error JSON. */
async function open(opts: TbAiOptions): Promise<{ response: Response; protocol: ProviderProtocol }> {
  const resolved = resolveLocalProvider(opts.provider, opts.model)
  if (typeof resolved === 'string') throw new Error(resolved)
  const response = await sendTbAi(resolved, opts)
  if (!response.ok) {
    const err = await normalizeUpstreamError(response, resolved.protocol)
    throw new Error(err.message)
  }
  return { response, protocol: resolved.protocol }
}

async function tbAi(opts: TbAiOptions): Promise<{ text: string }> {
  const { response, protocol } = await open(opts)
  return { text: await consumeStreamText(response, protocol) }
}

async function* tbAiStream(opts: TbAiOptions): AsyncGenerator<AiChunk> {
  const { response, protocol } = await open(opts)
  yield* streamAiChunks(response, protocol)
}

/** Install the server-side `tb` global. Idempotent — safe to call on every (re)import under watch.
 *  `containRoot` is tb.fs's project envelope, mirroring the web server's `basePath`. */
export function installServerTb(dir: string, containRoot = process.cwd()): void {
  const ai = Object.assign(tbAi, { stream: tbAiStream })
  // Same contract as the browser tb.fs, backed by the same core (tbFs.ts) — relative paths
  // resolve against the bulb's folder, contained to the project, parents created on write.
  // The non-UTF-8 read error matches the shim's wording, so bulb code sees one behavior.
  const tbFs = {
    read: async (p: string): Promise<string> => {
      const buf = await readFsBytes(p, dir, containRoot)
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(buf)
      } catch {
        throw new Error(`File is not valid UTF-8 text: ${p} — use tb.fs.readBytes() for binary files.`)
      }
    },
    readBytes: async (p: string): Promise<Uint8Array> => new Uint8Array(await readFsBytes(p, dir, containRoot)),
    write: async (p: string, content: string | Uint8Array): Promise<boolean> => {
      await writeFsFile(p, content, dir, containRoot)
      return true
    },
  }
  ;(globalThis as { tb?: unknown }).tb = Object.freeze({
    // The uniformity exception (see header): the server's console IS the bulb's log channel.
    log: (...args: unknown[]) => { console.log(...args) },
    ai,
    fs: tbFs,
    // The bulb's folder, absolute (TB-FS.md) — for interop (paths handed to spawned tools);
    // tb.fs already resolves relative paths against it. --batch scopes both (TB-Batch.md).
    dir,
    models: (): Promise<TbModelDto[]> => getFilteredModels(),
    hasOwnKeys,
    mode: 'local' as const,
  })
}
