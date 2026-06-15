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

    // AI - calls local server which proxies to LLM provider
    ai: async ({ messages, system, reasoning, provider, model, webSearch }) => {
      if (isEmbedded) throw embedErr('tb.ai()');
      const resp = await fetch('/__ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages, system, reasoning, provider, model, webSearch })
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
    },

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

    // Proxy: rewrite CDN URLs to the local server's /proxy/. Relative on purpose —
    // it resolves against the served page on the CLI, and against the host page
    // inside a srcdoc embed, where location.origin is the string "null".
    proxy: (url) => {
      if (!url) return url;
      const i = url.lastIndexOf('https://');
      const clean = i !== -1 ? url.slice(i) : url;
      if (!clean.startsWith('https://')) return url;
      return '/proxy/' + clean;
    },

    // Server API - call functions from **server.ts**
    api: async (name, ...args) => {
      if (isEmbedded) throw embedErr('tb.server.' + name + '()');
      const resp = await fetch('/__api/' + name, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ args })
      });
      if (resp.status === 403) throw new Error((await resp.text().catch(() => '')) || ('tb.server.' + name + '() is blocked — re-run with --trust'));
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'API call failed');
      return data.result;
    },

    // Server proxy - tb.server.fn(...) delegates to tb.api('fn', ...). 'log' is special: it's the
    // ungated diagnostic (serverLog -> /__log, built-in only), so it prints untrusted; everything
    // else is a gated /__api call into the bulb's own server.ts.
    server: new Proxy({}, {
      get: (_, name) => name === 'log'
        ? (...args) => serverLog(...args)
        : (...args) => globalThis.tb.api(name, ...args)
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
