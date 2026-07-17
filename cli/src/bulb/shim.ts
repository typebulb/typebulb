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
  // The host injects window.__TB_EMBED_ERR__ to override the text; absent it, the
  // nested-bulb wording applies. (The CLI's untrusted launch is NOT this path — it's
  // a top-level page, and its \`--trust\` message comes from the server 403.)
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

  // #tb= fragment restore (TB-Inference.md "Sharing a local run"): a refreshed or pasted share
  // URL re-injects its run before the bulb code reads tb.insight()/tb.data() — the template's
  // module script awaits __tbBoot, so the async decode still lands ahead of synchronous startup
  // reads. Decode failure falls through to the file's own blocks with a console note.
  if (!isEmbedded && location.protocol.indexOf('http') === 0 && location.hash.indexOf('#tb=') === 0) {
    globalThis.__tbBoot = fetch('/__infer-decode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hash: location.hash })
    })
      .then((r) => r.json())
      .then((res) => {
        if (res && Array.isArray(res.data)) {
          window.__TB_INSIGHT__ = res.insightJson;
          window.__TB_DATA__ = res.data;
        } else {
          console.warn('[typebulb] The #tb= fragment could not be decoded (incomplete or corrupted link) — using the bulb file state.');
        }
      })
      .catch(() => {});
  }

  // tb.onMessage subscribers, fed by the events-SSE 'message' channel (typebulb send). A message is
  // JSON-or-string: parse as JSON, else hand back the raw string; '' (a bare \`send\`) ⇒ undefined.
  const messageHandlers = new Set();
  const parseMsg = (s) => { if (s === '' || s == null) return undefined; try { return JSON.parse(s); } catch { return s; } };

  // The trust gate denies privileged routes with a plain-text 403 naming --trust;
  // surface that as-is rather than a JSON-parse miss on a non-JSON body.
  const deny403 = async (resp, what) => {
    if (resp.status === 403) throw new Error((await resp.text().catch(() => '')) || (what + ' is blocked — re-run with --trust'));
  };

  // Filesystem API - calls back to the local server.
  // The server returns raw bytes (no JSON envelope); read() decodes as UTF-8.
  const failIfNotOk = async (resp, action, path) => {
    if (resp.ok) return;
    await deny403(resp, 'tb.fs');
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

  // Shared /__ai transport: embed guard, POST (stream:true flags the NDJSON path — JSON.stringify
  // drops the key when undefined, so the non-streaming body is unchanged), 403 → trust hint.
  const aiFetch = async (what, { messages, system, effort, provider, model, webSearch, signal } = {}, stream) => {
    if (isEmbedded) throw embedErr(what);
    const resp = await fetch('/__ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, system, effort, provider, model, webSearch, stream }),
      signal
    });
    await deny403(resp, what);
    return resp;
  };
  const aiError = (data) => {
    const err = new Error(data.message || 'tb.ai() call failed');
    err.code = data.code || 'unknown';
    err.retryable = !!data.retryable;
    return err;
  };
  // tb.ai(): non-streaming, resolves with the full { text } (unchanged 90% path).
  const aiCall = async (opts) => {
    const resp = await aiFetch('tb.ai()', opts, undefined);
    const data = await resp.json();
    if (!resp.ok) throw aiError(data);
    return data;
  };
  // tb.ai.stream(): async iterable of AiChunk ({ kind:'text'|'reasoning', text }). Same idiom as a
  // streaming tb.server.<gen>(). Break the loop (or abort the signal) to cancel.
  const aiStream = (opts = {}) => (async function* () {
    const resp = await aiFetch('tb.ai.stream()', opts, true);
    if (!resp.ok && !isStreamResp(resp)) throw aiError(await resp.json().catch(() => ({})));
    yield* readStream(resp);
  })();
  const ai = Object.assign(aiCall, { stream: aiStream });

  // tb.infer() — the local inference layer (TB-Inference.md). The UI and network live in the
  // lazy-imported modal module (/__infer-ui.js — zero bytes here until the first call); the shim
  // stays the state machine and globals writer. The promise settles once: a modal retry after a
  // rejected promise still updates runtime state on success, for tb.insight() readers.
  let inferState = 'idle';
  let dataOverrides = null;
  const infer = (opts = {}) => {
    if (isEmbedded) return Promise.reject(embedErr('tb.infer()'));
    if (inferState === 'running') return Promise.reject(new Error('Inference already in progress'));
    inferState = 'running';
    // Data priority (matching the .com sandbox): explicit arg > setData overrides > undefined —
    // the modal then seeds from the SOURCE chunks (/__infer-info), the local Data tab, exactly as
    // .com's IDE modal reseeds from the Data tab rather than post-run runtime state.
    let data = opts.data;
    if (data === undefined && dataOverrides) data = Object.values(dataOverrides);
    if (data !== undefined && !Array.isArray(data)) data = [data];
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn, v) => { if (!settled) { settled = true; fn(v); } };
      import('/__infer-ui.js').then((ui) => {
        ui.runInference({
          data,
          // The transport reader is the shim's — one NDJSON decoder per page, never two
          // drifting copies (TB-Streaming.md envelope: payload-side, so drift is not tolerable).
          readStream,
          onComplete: (final) => {
            // Runtime state only, never the file (TB-Inference.md Invariant 2).
            window.__TB_INSIGHT__ = final.insightJson;
            if (final.data && final.data.length) window.__TB_DATA__ = final.data;
            if (final.hash) history.replaceState(null, '', location.pathname + location.search + final.hash);
            inferState = 'complete';
            settle(resolve, final.insight);
          },
          onError: (err) => {
            inferState = 'error';
            const e = new Error(err.message); e.code = err.code; e.retryable = !!err.retryable;
            settle(reject, e);
          },
          onCancel: () => {
            if (!settled) { inferState = 'idle'; settle(resolve, undefined); }
          }
        });
      }).catch((e) => { inferState = 'error'; settle(reject, e); });
    });
  };

  // tb.server.<fn>(...) — one call object that is both awaitable (single result) and async-iterable
  // (a streamed async-generator export). The server picks by export kind; this stays graceful if
  // they're mismatched (await a stream → array of chunks; for-await a normal result → one value).
  const serverCall = (name, args) => {
    const what = 'tb.server.' + name + '()';
    let respP = null;
    const start = () => respP || (respP = fetch('/__api/' + name, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args })
    }));
    const single = async () => {
      if (isEmbedded) throw embedErr(what);
      const resp = await start();
      await deny403(resp, what);
      if (isStreamResp(resp)) { const out = []; for await (const v of readStream(resp)) out.push(v); return out; }
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'API call failed');
      return data.result;
    };
    const iterate = async function* () {
      if (isEmbedded) throw embedErr(what);
      const resp = await start();
      await deny403(resp, what);
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

    // Inference (TB-Inference.md) — modal-hosted one-shot LLM call over the bulb's own blocks
    infer,
    inferenceState: () => inferState,
    setData: (index, content) => { if (!dataOverrides) dataOverrides = {}; dataOverrides[index] = content; },
    resetInferenceState: () => { inferState = 'idle'; dataOverrides = null; },

    // AI - tb.ai() proxies to the provider via the local server; tb.ai.stream() streams AiChunks.
    ai,

    // Model discovery - fetches catalog from typebulb.com, filtered by local API keys
    models: async () => {
      if (isEmbedded) return [];
      const resp = await fetch('/__models');
      if (!resp.ok) return [];
      return resp.json();
    },

    // Own-keys check - true when the user's own AI backs tb.ai (env keys, compat endpoint, or Ollama)
    hasOwnKeys: async () => {
      if (isEmbedded) return false;
      const resp = await fetch('/__has-own-keys');
      if (!resp.ok) return false;
      return (await resp.json()) === true;
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

    // The bulb's folder, absolute (TB-FS.md) — for interop (paths handed to server.ts or
    // spawned tools); tb.fs itself already resolves relative paths against it. Absent in an
    // embed (no filesystem to name), where access throws like tb.fs.
    get dir() {
      if (isEmbedded || !window.__TB_DIR__) throw embedErr('tb.dir');
      return window.__TB_DIR__;
    },

    // Receive a value pushed from the terminal via \`typebulb send\` (data-in, the dual of the
    // ungated tb.server.log). Returns an unsubscribe fn. Inert when embedded — no server, so no
    // sender; the handler is registered but never fires (cf. tb.models returning []). A handler's
    // non-undefined return (awaited) becomes the reply \`send --wait\` prints (TB-Interrogation.md).
    onMessage: (handler) => {
      if (typeof handler === 'function') messageHandlers.add(handler);
      return () => messageHandlers.delete(handler);
    },

    // Environment ('embedded' when running as a bulb-in-a-bulb)
    mode: isEmbedded ? 'embedded' : 'local',

    // Theme accessor - delegates to the head-script engine (window.__tbTheme).
    // Get: override slot ('dark'|'light'|undefined). Set applies + persists
    // per-bulb; undefined clears the override.
    get theme() { return window.__tbTheme ? window.__tbTheme.get() : undefined; },
    set theme(v) { if (window.__tbTheme) window.__tbTheme.set(v); }
  });

  // tb:snapshot — the page serializes its own accessibility outline (roles, names, visible text;
  // the YAML-not-pixels shape) as the reply to \`typebulb send <file> tb:snapshot\`
  // (TB-Interrogation.md). Heuristic by design: explicit role attr, a small
  // implicit-role map, aria-label/alt/value then visible text for names — enough to catch
  // text/structure divergence, which is what an agent can judge without pixels.
  const IMPLICIT_ROLES = { BUTTON: 'button', SELECT: 'combobox', TEXTAREA: 'textbox', OPTION: 'option', IMG: 'img', NAV: 'navigation', MAIN: 'main', HEADER: 'banner', FOOTER: 'contentinfo', ASIDE: 'complementary', FORM: 'form', DIALOG: 'dialog', TABLE: 'table', TR: 'row', TH: 'columnheader', TD: 'cell', UL: 'list', OL: 'list', LI: 'listitem', LABEL: 'label', P: 'paragraph', PROGRESS: 'progressbar', SUMMARY: 'button', FIGURE: 'figure', BLOCKQUOTE: 'blockquote', HR: 'separator' };
  const INPUT_ROLES = { checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton', search: 'searchbox', button: 'button', submit: 'button', reset: 'button', hidden: '' };
  const snapshot = () => {
    const MAX_LINES = 400;
    const squash = (s) => (s || '').replace(/\\s+/g, ' ').trim();
    const clip = (s) => (s.length > 200 ? s.slice(0, 200) + '…' : s);
    const roleOf = (el) => {
      const explicit = el.getAttribute('role');
      if (explicit) return explicit;
      const t = el.tagName;
      if (t === 'A') return el.hasAttribute('href') ? 'link' : '';
      if (t === 'INPUT') { const r = INPUT_ROLES[(el.getAttribute('type') || 'text').toLowerCase()]; return r === undefined ? 'textbox' : r; }
      if (/^H[1-6]$/.test(t)) return 'heading';
      return IMPLICIT_ROLES[t] || '';
    };
    const hiddenEl = (el) => {
      if (el.hidden || el.getAttribute('aria-hidden') === 'true') return true;
      const cs = getComputedStyle(el);
      return cs.display === 'none' || cs.visibility === 'hidden';
    };
    const lines = [];
    const walk = (node, depth) => {
      for (let ch = node.firstChild; ch && lines.length <= MAX_LINES; ch = ch.nextSibling) {
        if (ch.nodeType === 3) {
          const t = squash(ch.nodeValue);
          if (t) lines.push('  '.repeat(depth) + '- text: ' + clip(t));
          continue;
        }
        if (ch.nodeType !== 1) continue;
        const tag = ch.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEMPLATE' || tag === 'NOSCRIPT' || tag === 'LINK' || tag === 'META') continue;
        if (hiddenEl(ch)) continue;
        const role = roleOf(ch);
        if (!role) { walk(ch, depth); continue; }   // structural (div/span/…): descend transparently
        const attr = (n) => squash(ch.getAttribute(n) || '');
        const text = squash(ch.textContent);
        const name = attr('aria-label') || (tag === 'IMG' ? attr('alt') : '') || (typeof ch.value === 'string' ? squash(ch.value) || attr('placeholder') : '') || text;
        let line = role + (name ? ' "' + clip(name) + '"' : '');
        const lv = role === 'heading' ? (attr('aria-level') || (/^H[1-6]$/.test(tag) ? tag.charAt(1) : '')) : '';
        if (lv) line += ' [level=' + lv + ']';
        lines.push('  '.repeat(depth) + '- ' + line);
        if (!(name && name === text)) walk(ch, depth + 1);   // subtree ≡ name ⇒ the one line says it all
      }
    };
    walk(document.body, 0);
    if (lines.length > MAX_LINES) { lines.length = MAX_LINES; lines.push('- … (truncated)'); }
    return lines.length ? lines.join('\\n') : '(empty page)';
  };

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
    es.addEventListener('message', async (e) => {
      // Wire envelope { id?, payload } (JSON — SSE-line-safe). tb:* payloads are the shim's reserved
      // namespace (TB-Interrogation.md): answered by a built-in handler, never delivered to
      // tb.onMessage. Each settled non-undefined return is a reply candidate — the CLI enforces the
      // one-reply rule, the shim just reports what it collected.
      let env;
      try { env = JSON.parse(e.data) || {}; } catch { return; }
      const errText = (err) => String((err && err.message) || err);
      const results = []; const errors = [];
      const keep = (v) => {
        try {
          const enc = JSON.stringify(v);
          if (enc === undefined) throw new Error('unsupported value');
          results.push(enc);
        } catch (err) { errors.push('reply is not JSON-serializable: ' + errText(err)); }
      };
      const reservedCall = async () => {
        if (env.payload === 'tb:snapshot') return snapshot();
        throw new Error('unknown reserved message: ' + env.payload);
      };
      const value = parseMsg(env.payload);
      const calls = typeof env.payload === 'string' && env.payload.indexOf('tb:') === 0
        ? [reservedCall]
        : Array.from(messageHandlers, (h) => async () => h(value));
      for (const s of await Promise.allSettled(calls.map((f) => f()))) {
        if (s.status === 'rejected') { console.error(s.reason); errors.push(errText(s.reason)); }
        else if (s.value !== undefined) keep(s.value);
      }
      if (env.id !== undefined) {
        try { fetch('/__send-reply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: env.id, results, errors }) }); } catch {}
      }
    });
    es.onerror = () => {
      // Server closed, stop trying
      es.close();
    };
  }
})();
`
