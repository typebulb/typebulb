/**
 * Browser-side shim for tb.* namespace with filesystem extensions.
 * This JavaScript is injected into the HTML and runs in the browser.
 */

export const typebulbShim = `
(() => {
  // Embedded (bulb-in-a-bulb): runs inside a sandboxed iframe with no parent
  // bridge, so privileged tb.* (AI, fs, server RPC) can't reach a host and would
  // otherwise fail with cryptic CORS/CSP errors. Detect it and fail clearly.
  //
  // The same sandboxed-iframe path also backs the CLI's default (untrusted) launch
  // (TB-Security.md), where the right message names \`--trust\` rather
  // than "no host bridge". The host injects window.__TB_EMBED_ERR__ to override the
  // text; absent it, the nested-bulb wording applies.
  const isEmbedded = window.parent !== window;
  const embedErr = (name) => new Error(
    typeof window.__TB_EMBED_ERR__ === 'function'
      ? window.__TB_EMBED_ERR__(name)
      : name + ' is not available in an embedded bulb (no host bridge).'
  );

  // JSON parser (handles jsonish - unquoted keys)
  const parseJson = (str) => {
    try {
      return JSON.parse(str);
    } catch {
      const fixed = str.replace(/(?<!")(\\b[a-zA-Z_][a-zA-Z0-9_]*\\b)\\s*:/g, '"$1":');
      return JSON.parse(fixed);
    }
  };

  // Read from window each time so updates are visible
  const getData = () => window.__TB_DATA__ || [];

  // tb.onMessage subscribers, fed by the events-SSE 'message' channel (typebulb send). A message is
  // JSON-or-string: parse as JSON, else hand back the raw string; '' (a bare \`send\`) ⇒ undefined.
  const messageHandlers = new Set();
  const parseMsg = (s) => { if (s === '' || s == null) return undefined; try { return JSON.parse(s); } catch { return s; } };

  // Filesystem API - calls back to the local server.
  // The server returns raw bytes (no JSON envelope); read() decodes as UTF-8.
  const failIfNotOk = async (resp, action, path) => {
    if (resp.ok) return;
    // The trust gate denies privileged routes with a plain-text 403 naming --trust;
    // surface that as-is rather than a JSON-parse miss on a non-JSON body.
    if (resp.status === 403) throw new Error((await resp.text().catch(() => '')) || 'tb.fs is blocked — re-run with --trust');
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to ' + action + ' file: ' + path);
  };
  const fetchFileBytes = async (path) => {
    if (isEmbedded) throw embedErr('tb.fs');
    const resp = await fetch('/__fs/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path })
    });
    await failIfNotOk(resp, 'read', path);
    return resp.arrayBuffer();
  };
  const fs = {
    read: async (path) => {
      const buf = await fetchFileBytes(path);
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(buf);
      } catch {
        throw new Error('File is not valid UTF-8 text: ' + path + ' — use tb.fs.readBytes() for binary files.');
      }
    },
    readBytes: async (path) => new Uint8Array(await fetchFileBytes(path)),
    write: async (path, content) => {
      if (isEmbedded) throw embedErr('tb.fs');
      const resp = await fetch('/__fs/write?path=' + encodeURIComponent(path), {
        method: 'POST',
        body: content
      });
      await failIfNotOk(resp, 'write', path);
      return true;
    }
  };

  // Clipboard helper
  const copy = async (text) => {
    try {
      await navigator.clipboard.writeText(String(text));
      return true;
    } catch {
      return false;
    }
  };

  // Diagnostic logging (tb.server.log). Routes to the UNGATED /__log endpoint, which only ever
  // runs the server's built-in console.log — never a user server.ts export — so it crosses no
  // capability boundary and works even on a Restricted (untrusted) bulb (the FAQ's recommended
  // debugging path). Embedded bulbs have no host, and any transport failure degrades to the page's
  // own console: a diagnostic log must never throw or block.
  const serverLog = async (...args) => {
    if (isEmbedded) { console.log(...args); return; }
    try {
      const resp = await fetch('/__log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ args })
      });
      if (!resp.ok) console.log(...args);
    } catch { console.log(...args); }
  };

  // Streaming. The server tunnels an async iterable as enveloped NDJSON over
  // the bridge POST; isStreamResp flags it via a response header so a normal single-return call is
  // untouched. readStream yields each {type:'chunk'} value; a {type:'error'} line rejects the
  // iterator (so try/catch around for-await fires); breaking the loop cancels the body (finally),
  // which disconnects the server and tears down the source generator — that's how Stop/unmount
  // actually aborts the upstream rather than just hiding it.
  const isStreamResp = (resp) => resp.headers.get('X-TB-Stream') === '1';
  async function* readStream(resp) {
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const decodeLine = (line) => {
      if (!line.trim()) return undefined;
      const env = JSON.parse(line);
      if (env.type === 'error') {
        const e = new Error((env.error && env.error.message) || 'stream error');
        e.code = env.error && env.error.code;
        e.retryable = !!(env.error && env.error.retryable);
        throw e;
      }
      return env.type === 'chunk' ? { value: env.value } : undefined;
    };
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\\n')) !== -1) {
          const r = decodeLine(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
          if (r) yield r.value;
        }
      }
      const r = decodeLine(buf);
      if (r) yield r.value;
    } finally {
      try { await reader.cancel(); } catch {}
    }
  }

  // tb.ai(): non-streaming, resolves with the full { text } (unchanged 90% path).
  const aiCall = async ({ messages, system, effort, reasoning, provider, model, webSearch, signal } = {}) => {
    if (isEmbedded) throw embedErr('tb.ai()');
    const resp = await fetch('/__ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // 'reasoning' is the deprecated alias for 'effort'
      body: JSON.stringify({ messages, system, effort: effort ?? reasoning, provider, model, webSearch }),
      signal
    });
    if (resp.status === 403) throw new Error((await resp.text().catch(() => '')) || 'tb.ai() is blocked — re-run with --trust');
    const data = await resp.json();
    if (!resp.ok) {
      const err = new Error(data.message || 'tb.ai() call failed');
      err.code = data.code || 'unknown';
      err.retryable = !!data.retryable;
      throw err;
    }
    return data;
  };
  // tb.ai.stream(): async iterable of AiChunk ({ kind:'text'|'reasoning', text }). Same idiom as a
  // streaming tb.server.<gen>(). Break the loop (or abort the signal) to cancel.
  const aiStream = (opts = {}) => (async function* () {
    if (isEmbedded) throw embedErr('tb.ai.stream()');
    const { messages, system, effort, reasoning, provider, model, webSearch, signal } = opts;
    const resp = await fetch('/__ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // 'reasoning' is the deprecated alias for 'effort'
      body: JSON.stringify({ messages, system, effort: effort ?? reasoning, provider, model, webSearch, stream: true }),
      signal
    });
    if (resp.status === 403) throw new Error((await resp.text().catch(() => '')) || 'tb.ai() is blocked — re-run with --trust');
    if (!resp.ok && !isStreamResp(resp)) {
      const data = await resp.json().catch(() => ({}));
      const err = new Error(data.message || 'tb.ai() call failed');
      err.code = data.code || 'unknown';
      err.retryable = !!data.retryable;
      throw err;
    }
    yield* readStream(resp);
  })();
  const ai = Object.assign(aiCall, { stream: aiStream });

  // tb.server.<fn>(...) — one call object that is both awaitable (single result) and async-iterable
  // (a streamed async-generator export). The server picks by export kind; this stays graceful if
  // they're mismatched (await a stream → array of chunks; for-await a normal result → one value).
  const serverCall = (name, args) => {
    const ensureOk403 = async (resp) => {
      if (resp.status === 403) throw new Error((await resp.text().catch(() => '')) || ('tb.server.' + name + '() is blocked — re-run with --trust'));
    };
    let respP = null;
    const start = () => respP || (respP = fetch('/__api/' + name, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args })
    }));
    const single = async () => {
      if (isEmbedded) throw embedErr('tb.server.' + name + '()');
      const resp = await start();
      await ensureOk403(resp);
      if (isStreamResp(resp)) { const out = []; for await (const v of readStream(resp)) out.push(v); return out; }
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'API call failed');
      return data.result;
    };
    const iterate = async function* () {
      if (isEmbedded) throw embedErr('tb.server.' + name + '()');
      const resp = await start();
      await ensureOk403(resp);
      if (isStreamResp(resp)) { yield* readStream(resp); return; }
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'API call failed');
      yield data.result;
    };
    return {
      then: (f, r) => single().then(f, r),
      catch: (r) => single().catch(r),
      finally: (f) => single().finally(f),
      [Symbol.asyncIterator]: iterate
    };
  };

  // tb namespace
  globalThis.tb = Object.freeze({
    data: (index) => getData()[index],
    json: (index) => parseJson(getData()[index]),
    insight: () => window.__TB_INSIGHT__ ? parseJson(window.__TB_INSIGHT__) : undefined,

    // Inference not available locally
    infer: () => {
      if (isEmbedded) return Promise.reject(embedErr('tb.infer()'));
      alert('This bulb uses AI inference.\\n\\nFor local bulbs, simply ask your AI assistant (e.g. Claude Code) to read your .bulb.md file and edit the data.txt and insight.json blocks directly.');
      return Promise.reject(new Error('tb.infer() is not available in the local CLI.'));
    },
    inferenceState: () => 'idle',
    setData: () => {},
    resetInferenceState: () => {},

    // AI - tb.ai() proxies to the provider via the local server; tb.ai.stream() streams AiChunks.
    ai,

    // Model discovery - fetches catalog from typebulb.com, filtered by local API keys
    models: async () => {
      if (isEmbedded) return [];
      const resp = await fetch('/__models');
      if (!resp.ok) return [];
      return resp.json();
    },

    // Dump just logs to console in local mode
    dump: async (...args) => console.log('[tb.dump]', ...args),

    // Clipboard
    copy,

    // URL
    url: () => Promise.resolve(location.href),

    // Proxy: rewrite CDN URLs to the local server's /proxy/. Absolute when we have a
    // real origin (the CLI page, or a broken-out bulb) so the URL also works from a
    // worker's importScripts, which rejects a root-relative path. Relative in a
    // null-origin srcdoc embed, where prefixing the "null" origin would yield the
    // broken string null/proxy/... ; there the relative path resolves against the
    // host page. Absolute and root-relative are equivalent for every other consumer
    // (fetch, new Worker, script src) when there is one real origin, so this only
    // adds the importScripts case and changes nothing else.
    proxy: (url) => {
      if (!url) return url;
      const i = url.lastIndexOf('https://');
      const clean = i !== -1 ? url.slice(i) : url;
      if (!clean.startsWith('https://')) return url;
      const rel = '/proxy/' + clean;
      return location.origin && location.origin !== 'null' ? location.origin + rel : rel;
    },

    // Server API - call functions from **server.ts**. Returns the hybrid call object: await it for
    // a normal export's result, or for-await it for an async-generator export's stream.
    api: (name, ...args) => serverCall(name, args),

    // Server proxy - tb.server.fn(...) delegates to serverCall. 'log' is special: it's the ungated
    // diagnostic (serverLog -> /__log, built-in only), so it prints untrusted; everything else is a
    // gated /__api call into the bulb's own server.ts.
    server: new Proxy({}, {
      get: (_, name) => name === 'log'
        ? (...args) => serverLog(...args)
        : (...args) => serverCall(name, args)
    }),

    // Filesystem - local CLI extension
    fs,

    // Receive a value pushed from the terminal via \`typebulb send\` (data-in, the dual of the
    // ungated tb.server.log). Returns an unsubscribe fn. Inert when embedded — no server, so no
    // sender; the handler is registered but never fires (cf. tb.models returning []).
    onMessage: (handler) => {
      if (typeof handler === 'function') messageHandlers.add(handler);
      return () => messageHandlers.delete(handler);
    },

    // Environment ('embedded' when running as a bulb-in-a-bulb)
    mode: isEmbedded ? 'embedded' : 'local',

    // Theme accessor - delegates to the head-script engine (window.__tbTheme).
    // Get: override slot ('dark'|'light'|undefined). Set applies + persists
    // per-bulb; undefined clears the override. See Specs/Theme.md.
    get theme() { return window.__tbTheme ? window.__tbTheme.get() : undefined; },
    set theme(v) { if (window.__tbTheme) window.__tbTheme.set(v); }
  });

  // Events channel (dev server only): 'reload' drives hot reload (only emitted when watching),
  // 'message' delivers \`typebulb send\` pushes to tb.onMessage. Connect for a CLI-served page (http
  // origin, not an embed); a srcdoc embed or a file:// static export has no server, so onMessage just
  // stays inert there. Opening it independent of watch is what lets send reach a --no-watch page.
  if (!isEmbedded && location.protocol.indexOf('http') === 0) {
    const es = new EventSource('/__reload');
    es.addEventListener('reload', () => {
      console.log('[typebulb] Reloading...');
      window.location.reload();
    });
    es.addEventListener('message', (e) => {
      // Wire payload is JSON-encoded (SSE-line-safe); decode it, then interpret JSON-or-string.
      let value;
      try { value = parseMsg(JSON.parse(e.data)); } catch { value = undefined; }
      messageHandlers.forEach((h) => { try { h(value); } catch (err) { console.error(err); } });
    });
    es.onerror = () => {
      // Server closed, stop trying
      es.close();
    };
  }
})();
`
