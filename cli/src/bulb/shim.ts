/**
 * Browser-side shim for tb.* namespace with filesystem extensions.
 * This JavaScript is injected into the HTML and runs in the browser.
 */

import { reloadClientScript } from './pageChrome.js'
import { MODE } from 'typebulb/format'

export const typebulbShim = `
(() => {
  // Inline (bulb-in-a-bulb): runs inside a sandboxed iframe with no parent
  // bridge, so privileged tb.* (AI, fs, server RPC) can't reach a host and would
  // otherwise fail with cryptic CORS/CSP errors. Detect it and fail clearly.
  //
  // The host injects window.__TB_INLINE_ERR__ to override the text; absent it, the
  // nested-bulb wording applies. (The CLI's untrusted launch is NOT this path — it's
  // a top-level page, and its \`--trust\` message comes from the server 403.)
  const isFramed = window.parent !== window;
  const inlineErr = (name) => new Error(
    typeof window.__TB_INLINE_ERR__ === 'function'
      ? window.__TB_INLINE_ERR__(name)
      : name + ' is not available in an inline bulb (no host bridge).'
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
  if (!isFramed && location.protocol.indexOf('http') === 0 && location.hash.indexOf('#tb=') === 0) {
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
    if (isFramed) throw inlineErr('tb.fs');
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
      if (isFramed) throw inlineErr('tb.fs');
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

  // Diagnostic logging (tb.log). Routes to the UNGATED /__log endpoint, which only ever
  // runs the server's built-in console.log — never a user server.ts export — so it crosses no
  // capability boundary and works even on a Restricted (untrusted) bulb (the FAQ's recommended
  // debugging path). Inline bulbs have no host, and any transport failure degrades to the page's
  // own console: a diagnostic log must never throw or block.
  const tbLog = async (...args) => {
    if (isFramed) { console.log(...args); return; }
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

  // Shared /__ai transport: inline bulb guard, POST (stream:true flags the NDJSON path — JSON.stringify
  // drops the key when undefined, so the non-streaming body is unchanged), 403 → trust hint.
  const aiFetch = async (what, { messages, system, effort, provider, model, webSearch, signal } = {}, stream) => {
    if (isFramed) throw inlineErr(what);
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
  // tb.ai(): non-streaming, resolves with the full { text, usage? } (unchanged 90% path).
  const aiCall = async (opts) => {
    const resp = await aiFetch('tb.ai()', opts, undefined);
    const data = await resp.json();
    if (!resp.ok) throw aiError(data);
    return data;
  };
  // tb.ai.stream(): async iterable of AiChunk ({ kind:'text'|'reasoning', text } deltas, then one
  // final { kind:'usage', usage } when the provider reported counts). Same idiom as a streaming
  // tb.server.<gen>(). Break the loop (or abort the signal) to cancel.
  const aiStream = (opts = {}) => (async function* () {
    const resp = await aiFetch('tb.ai.stream()', opts, true);
    if (!resp.ok && !isStreamResp(resp)) throw aiError(await resp.json().catch(() => ({})));
    yield* readStream(resp);
  })();
  const ai = Object.assign(aiCall, { stream: aiStream });

  // tb.infer() — the local inference layer (TB-Inference.md). The UI and network live in the
  // lazy-imported modal module (/__infer-ui.js — zero bytes here until the first call); the shim
  // stays the concurrency guard and globals writer. The promise settles once: a modal retry after a
  // rejected promise still updates runtime state on success, for tb.insight() readers.
  let inferRunning = false;
  const infer = (opts = {}) => {
    if (isFramed) return Promise.reject(inlineErr('tb.infer()'));
    if (inferRunning) return Promise.reject(new Error('Inference already in progress'));
    inferRunning = true;
    // Data to preview: the explicit arg, else undefined — the modal then seeds from the SOURCE
    // chunks (/__infer-info), the local Data tab, exactly as .com's IDE modal reseeds from the
    // Data tab rather than post-run runtime state.
    let data = opts.data;
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
            inferRunning = false;
            settle(resolve, final.insight);
          },
          onError: (err) => {
            inferRunning = false;
            const e = new Error(err.message); e.code = err.code; e.retryable = !!err.retryable;
            settle(reject, e);
          },
          onCancel: () => {
            if (!settled) { inferRunning = false; settle(resolve, undefined); }
          }
        });
      }).catch((e) => { inferRunning = false; settle(reject, e); });
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
      if (isFramed) throw inlineErr(what);
      const resp = await start();
      await deny403(resp, what);
      if (isStreamResp(resp)) { const out = []; for await (const v of readStream(resp)) out.push(v); return out; }
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'API call failed');
      return data.result;
    };
    const iterate = async function* () {
      if (isFramed) throw inlineErr(what);
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

    // AI - tb.ai() proxies to the provider via the local server; tb.ai.stream() streams AiChunks.
    ai,

    // Model discovery - fetches catalog from typebulb.com, filtered by local API keys
    models: async () => {
      if (isFramed) return [];
      const resp = await fetch('/__models');
      if (!resp.ok) return [];
      return resp.json();
    },

    // AI-access check - 'own' when the user's own AI backs tb.ai (env keys, compat endpoint, or
    // Ollama), else 'none': an inline bulb has no host AI, and the CLI has no courtesy model
    aiAccess: async () => {
      if (isFramed) return 'none';
      const resp = await fetch('/__ai-access');
      if (!resp.ok) return 'none';
      return await resp.json();
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
    // null-origin srcdoc inline bulb, where prefixing the "null" origin would yield the
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

    // The bulb's log channel: prints on the CLI's stdout (\`typebulb logs\` reads it back). Ungated —
    // no server.ts, no trust — see tbLog above.
    log: (...args) => { void tbLog(...args); },

    // Server API - call functions from **server.ts**. Returns the hybrid call object: await it for
    // a normal export's result, or for-await it for an async-generator export's stream.
    api: (name, ...args) => serverCall(name, args),

    // Server proxy - tb.server.fn(...) delegates to serverCall: purely the bulb's own server.ts
    // exports, every one a gated /__api call. (The ungated diagnostic lives at tb.log, so no
    // built-in shadows a user export.)
    server: new Proxy({}, {
      get: (_, name) => (...args) => serverCall(name, args)
    }),

    // Filesystem - local CLI extension
    fs,

    // The bulb's folder, absolute (TB-FS.md) — for interop (paths handed to server.ts or
    // spawned tools); tb.fs itself already resolves relative paths against it. Absent in an
    // inline bulb (no filesystem to name), where access throws like tb.fs.
    get dir() {
      if (isFramed || !window.__TB_DIR__) throw inlineErr('tb.dir');
      return window.__TB_DIR__;
    },

    // Receive a value pushed from the terminal via \`typebulb send\` (data-in, the dual of the
    // ungated tb.log). Returns an unsubscribe fn. Inert when inline — no server, so no
    // sender; the handler is registered but never fires (cf. tb.models returning []). A handler's
    // non-undefined return (awaited) becomes the reply \`send --wait\` prints (TB-Interrogation.md).
    onMessage: (handler) => {
      if (typeof handler === 'function') messageHandlers.add(handler);
      return () => messageHandlers.delete(handler);
    },

    // Environment ('inline' when running as a bulb-in-a-bulb)
    mode: isFramed ? '${MODE.inline}' : '${MODE.local}',

    // Theme accessor - delegates to the head-script engine (window.__tbTheme).
    // Get: override slot ('dark'|'light'|undefined). Set applies + persists
    // per-bulb; undefined clears the override.
    get theme() { return window.__tbTheme ? window.__tbTheme.get() : undefined; },
    set theme(v) { if (window.__tbTheme) window.__tbTheme.set(v); }
  });

  // tb:snapshot / tb:click / tb:set — the reserved interrogation-and-actuation namespace
  // (TB-Interrogation.md, TB-Interrogation-Actuation.md). One walk is both the outline and the
  // selector vocabulary: snapshot renders its lines, the verbs resolve targets from its entries,
  // so nothing is targetable the outline doesn't name. Heuristic by design: explicit role attr, a
  // small implicit-role map; names come from aria-label, label association, placeholder, then
  // visible text — a form control's value is a stated facet ([value=…]), never its name, because a
  // value-derived name is a self-invalidating selector.
  // CANVAS's 'img' is an invention, not an ARIA reading (canvas has no implicit role): it puts a
  // canvas in the outline so tb:png's multi-canvas form resolves by the ordinary vocabulary
  // (TB-Interrogation-Pixels.md). It collides with real <img> by design — ambiguity is reported.
  const IMPLICIT_ROLES = { BUTTON: 'button', SELECT: 'combobox', TEXTAREA: 'textbox', OPTION: 'option', IMG: 'img', CANVAS: 'img', NAV: 'navigation', MAIN: 'main', HEADER: 'banner', FOOTER: 'contentinfo', ASIDE: 'complementary', FORM: 'form', DIALOG: 'dialog', TABLE: 'table', TR: 'row', TH: 'columnheader', TD: 'cell', UL: 'list', OL: 'list', LI: 'listitem', LABEL: 'label', P: 'paragraph', PROGRESS: 'progressbar', SUMMARY: 'button', FIGURE: 'figure', BLOCKQUOTE: 'blockquote', HR: 'separator' };
  const INPUT_ROLES = { checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton', search: 'searchbox', button: 'button', submit: 'button', reset: 'button', hidden: '' };
  const FORM_TAGS = { INPUT: 1, TEXTAREA: 1, SELECT: 1 };
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
  // The associated label's text minus the control's own subtree (accname's core rule) — the
  // stable identity a wrapping label's raw textContent would drown in the control's own text.
  const labelName = (el) => {
    const label = el.labels && el.labels[0];
    if (!label) return '';
    let t = '';
    const gather = (n) => {
      if (n === el) return;
      if (n.nodeType === 3) { t += ' ' + n.nodeValue; return; }
      if (n.nodeType !== 1) return;
      for (let c = n.firstChild; c; c = c.nextSibling) gather(c);
    };
    gather(label);
    return squash(t);
  };
  const collectOutline = () => {
    const MAX_LINES = 400;
    const lines = [];
    const targets = [];   // { el, role, name } per role line, in outline order
    const walk = (node, depth, inLabel) => {
      // No early stop at MAX_LINES: the cap bounds what's PRINTED, below — a truncated outline
      // must not make a below-the-cap target unresolvable (the walk is a plain DOM read anyway).
      for (let ch = node.firstChild; ch; ch = ch.nextSibling) {
        if (ch.nodeType === 3) {
          const t = squash(ch.nodeValue);
          if (t && !inLabel) lines.push('  '.repeat(depth) + '- text: ' + clip(t));
          continue;
        }
        if (ch.nodeType !== 1) continue;
        const tag = ch.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEMPLATE' || tag === 'NOSCRIPT' || tag === 'LINK' || tag === 'META') continue;
        if (hiddenEl(ch)) continue;
        // An associated label is naming material, not a node: its text is the control's name, so
        // both its own line and its raw text would be duplicates. An orphan label keeps its line.
        if (tag === 'LABEL' && ch.control) { walk(ch, depth, true); continue; }
        const role = roleOf(ch);
        if (!role) { walk(ch, depth, inLabel); continue; }   // structural (div/span/…): descend transparently
        const attr = (n) => squash(ch.getAttribute(n) || '');
        const text = squash(ch.textContent);
        const formControl = FORM_TAGS[tag] && role !== 'button';
        let name, fromContent = false;
        const aria = attr('aria-label');
        if (aria) name = aria;
        else if (tag === 'IMG') name = attr('alt') || text;
        else if (formControl) name = labelName(ch) || attr('placeholder') || attr('title');
        else if (tag === 'INPUT') name = squash(ch.value) || text;   // a button-role input: value is its caption
        else { name = text; fromContent = true; }
        const facets = [];
        if (role === 'heading') {
          const lv = attr('aria-level') || (/^H[1-6]$/.test(tag) ? tag.charAt(1) : '');
          if (lv) facets.push('level=' + lv);
        }
        if (formControl && role !== 'checkbox' && role !== 'radio') {
          const v = tag === 'SELECT'
            ? squash(ch.selectedOptions && ch.selectedOptions[0] ? ch.selectedOptions[0].textContent : ch.value)
            : squash(ch.value);
          if (v) facets.push('value=' + clip(v));
        }
        if ((role === 'checkbox' || role === 'radio') && ch.checked) facets.push('checked');
        if (ch.disabled === true || attr('aria-disabled') === 'true') facets.push('disabled');
        const facetStr = facets.map((f) => ' [' + f + ']').join('');
        lines.push('  '.repeat(depth) + '- ' + role + (name ? ' "' + clip(name) + '"' : '') + facetStr);
        targets.push({ el: ch, role, name: name || '' });
        if (fromContent && name) {
          // A content-derived name IS the subtree's text, so the form is decided AFTER descending
          // (TB-Interrogation-Actuation.md, container fix): a subtree with no lines of its own
          // collapses into the named line ('listitem "Apple"'); one with lines keeps them all, and
          // the name — their duplicate — goes bare. An aria-label is never content-derived.
          const lineMark = lines.length, targetMark = targets.length;
          walk(ch, depth + 1, false);
          if (targets.length === targetMark) lines.length = lineMark;
          else {
            lines[lineMark - 1] = '  '.repeat(depth) + '- ' + role + facetStr;
            targets[targetMark - 1].name = '';
          }
        } else walk(ch, depth + 1, false);
      }
    };
    walk(document.body, 0, false);
    if (lines.length > MAX_LINES) { lines.length = MAX_LINES; lines.push('- … (truncated)'); }
    return { lines, targets };
  };
  // The scrolling element's client box is the usable area minus scrollbars — the only basis on
  // which "content ≤ viewport" is the same verdict the scrollbar's presence gives the user.
  const pageGeometry = () => {
    const de = document.scrollingElement || document.documentElement;
    const over = [];
    if (de.scrollHeight > de.clientHeight) over.push('vertically by ' + (de.scrollHeight - de.clientHeight) + 'px');
    if (de.scrollWidth > de.clientWidth) over.push('horizontally by ' + (de.scrollWidth - de.clientWidth) + 'px');
    return '- page: viewport ' + de.clientWidth + '×' + de.clientHeight
      + ', content ' + de.scrollWidth + '×' + de.scrollHeight
      + ' — ' + (over.length ? 'overflows ' + over.join(', ') : 'fits');
  };
  const snapshot = () => {
    const { lines } = collectOutline();
    return pageGeometry() + '\\n' + (lines.length ? lines.join('\\n') : '(empty page)');
  };

  // tb:click / tb:set (TB-Interrogation-Actuation.md). A target is role + name exactly as the
  // outline prints them: exact name first, else a unique case-insensitive substring; zero or
  // several is a reported error, never a guess. Errors throw — the reply leg carries them to
  // stderr and a non-zero exit.
  const describeEl = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className ? '.' + el.className.split(/\\s+/)[0] : '');
  // Why a name the author DID write isn't in the outline. Both causes are silent by construction:
  // an element with no role is descended through transparently, and an unrendered one is skipped —
  // so the label is on the page while the target is not, with nothing said. Same posture as the
  // dead-control finding: name the cause rather than report an absence. Advisory only; it never
  // decides resolution, so a wrong guess costs a clause, never a target.
  // The recourse differs by family: naming a container for a READ is a role away, but telling an
  // author to put role="button" on a <div> would coach the very onClick-div the actuation invariant
  // keeps untargetable (TB-Interrogation-Actuation.md) — so an actuable role asks for a real control.
  const ACTUABLE_ROLES = { button: 1, checkbox: 1, radio: 1, combobox: 1, textbox: 1, slider: 1, spinbutton: 1, searchbox: 1, option: 1 };
  const labelledButUntargetable = (name, role) => {
    const q = String(name).toLowerCase();
    for (const el of document.querySelectorAll('[aria-label]')) {
      const label = squash(el.getAttribute('aria-label'));
      if (!label || label.toLowerCase().indexOf(q) === -1) continue;
      const shown = '<' + el.tagName.toLowerCase() + ' aria-label="' + label + '">';
      const actual = roleOf(el);
      if (!actual) return ' — ' + shown + ' has no role, so the walk descends through it without a line; '
        + (ACTUABLE_ROLES[role]
          ? 'a ' + role + ' has to be a real control (<button>, <input>, <select>), never a labelled <div>'
          : 'add role="' + role + '" to name it');
      if (hiddenEl(el) || !el.getClientRects().length) return ' — ' + shown + ' is not rendered, so the walk skips it';
      if (actual !== role) return ' — ' + shown + ' is a ' + actual + ', not a ' + role;
    }
    return '';
  };
  const resolveTarget = (role, name) => {
    const ofRole = collectOutline().targets.filter((t) => t.role === role);
    if (!ofRole.length) throw new Error('no ' + role + ' in the outline'
      + (labelledButUntargetable(name, role) || ' — run tb:snapshot for the vocabulary'));
    const named = ofRole.filter((t) => t.name);
    const exact = named.filter((t) => t.name === name);
    const q = name.toLowerCase();
    const hits = exact.length ? exact : named.filter((t) => t.name.toLowerCase().indexOf(q) !== -1);
    if (hits.length === 1) return hits[0].el;
    if (!hits.length) {
      const unnamed = ofRole.length - named.length;
      throw new Error('no ' + role + ' named "' + name + '"'
        + (named.length ? ' — ' + role + ' names here: ' + named.slice(0, 8).map((t) => '"' + t.name + '"').join(', ') : '')
        + (unnamed ? ' (' + unnamed + ' unnamed — an aria-label would make them targetable)' : '')
        + labelledButUntargetable(name, role));
    }
    throw new Error(hits.length + ' ' + role + 's match "' + name + '" (' + hits.map((t) => '"' + t.name + '"').join(', ') + ') — name one exactly');
  };
  // A dead control is a finding, not a no-op — one sentence, whatever deadened it.
  const deadControl = (role, name, state) => new Error(role + ' "' + name + '" is ' + state + ' — a dead control is a finding, not a no-op');
  const requireEnabled = (el, role, name) => {
    if (el.disabled === true || el.getAttribute('aria-disabled') === 'true') throw deadControl(role, name, 'disabled');
  };
  // The gesture's own preamble: a user scrolls to a control before clicking it (this is not a
  // scroll verb — and instant, because a page's \`scroll-behavior: smooth\` would animate while the
  // geometry reads below saw pre-scroll layout, silently disarming the hit-test). A center the
  // viewport can't reach, or whose click another element would receive, is a finding.
  const requireClickable = (el, role, name) => {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    const p = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    const top = document.elementFromPoint(p.x, p.y);
    if (!top) throw new Error(role + ' "' + name + '" is not clickable: its center is outside the viewport even after scrolling it into view (clipped by overflow?)');
    if (top !== el && !el.contains(top)) throw new Error(role + ' "' + name + '" is not clickable: a click at its center lands on ' + describeEl(top));
    return p;
  };
  // Reply after a double rAF registered post-dispatch (so a rAF-rendering framework's scheduled
  // frame lands first; the second survives one scheduled from a microtask), RACED against a short
  // timer: a hidden or occluded document runs no frames at all, and a page the browser isn't
  // rendering must still answer with its current DOM rather than hang the sender into a false
  // "stale tab" diagnosis. (The Playwright tier can't cover the hidden case — Playwright keeps
  // backgrounded pages rendered.) Either way: the immediate rendered consequence, never the
  // settled outcome — settled truth is the caller's follow-up tb:snapshot.
  const postFrameSnapshot = () => new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(snapshot()); } };
    requestAnimationFrame(() => requestAnimationFrame(finish));
    setTimeout(finish, 150);
  });
  const parseActuation = (usage, rest) => {
    const m = /^\\s*([\\w-]+)\\s+(?:"([^"]*)"|(\\S+))\\s*([\\s\\S]*)$/.exec(rest);
    if (!m) throw new Error('usage: ' + usage);
    return { role: m[1], name: m[2] !== undefined ? m[2] : m[3], rest: m[4] };
  };
  const actClick = (rest) => {
    const t = parseActuation('tb:click <role> "<name>"', rest);
    if (t.rest) throw new Error('usage: tb:click <role> "<name>"');
    const el = resolveTarget(t.role, t.name);
    requireEnabled(el, t.role, t.name);
    const p = requireClickable(el, t.role, t.name);
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      const Ctor = type.indexOf('pointer') === 0 && window.PointerEvent ? PointerEvent : MouseEvent;
      el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, view: window, clientX: p.x, clientY: p.y }));
    }
    return postFrameSnapshot();
  };
  // tb:rect — a read in the actuation grammar: the named control's viewport-relative rect plus the
  // viewport itself, so the reply is self-interpreting. No scrollIntoView — a read disturbs nothing.
  const readRect = (rest) => {
    const t = parseActuation('tb:rect <role> "<name>"', rest);
    if (t.rest) throw new Error('usage: tb:rect <role> "<name>"');
    const el = resolveTarget(t.role, t.name);
    const r = el.getBoundingClientRect();
    const de = document.scrollingElement || document.documentElement;
    // Edges round, dimensions derive: x + width IS the rounded true right edge (same vertically),
    // so controls truly sharing an edge always read equal — per-field rounding could put them 1px apart.
    const x = Math.round(r.left), y = Math.round(r.top);
    return {
      x, y,
      width: Math.round(r.right) - x, height: Math.round(r.bottom) - y,
      viewport: { width: de.clientWidth, height: de.clientHeight }
    };
  };
  const actSet = (rest) => {
    const t = parseActuation('tb:set <role> "<name>" = <value>', rest);
    const vm = /^=\\s*([\\s\\S]*)$/.exec(t.rest.trim());
    if (!vm) throw new Error('usage: tb:set <role> "<name>" = <value>');
    let value = vm[1].trim();
    if (value.length >= 2 && value.charAt(0) === '"' && value.charAt(value.length - 1) === '"') value = value.slice(1, -1);
    const el = resolveTarget(t.role, t.name);
    const tag = el.tagName;
    if (!FORM_TAGS[tag]) throw new Error('tb:set targets form controls (input, textarea, select) — for app state beyond a control, author a poke handler (README, "Poking state")');
    const type = tag === 'INPUT' ? (el.getAttribute('type') || 'text').toLowerCase() : '';
    if (type === 'checkbox' || type === 'radio') throw new Error('a ' + t.role + ' takes tb:click, not a value');
    requireEnabled(el, t.role, t.name);
    if (el.readOnly === true) throw deadControl(t.role, t.name, 'readonly');
    if (tag === 'SELECT') {
      const opts = Array.from(el.options);
      const hit = opts.find((o) => o.value === value) || opts.find((o) => squash(o.textContent).toLowerCase() === value.toLowerCase());
      if (!hit) throw new Error('no option "' + value + '" in ' + t.role + ' "' + t.name + '" — options: ' + opts.map((o) => '"' + squash(o.textContent) + '"').join(', '));
      value = hit.value;
    }
    // The NATIVE prototype setter, not the instance property: a framework's value tracker
    // (React) shadows the instance to dedupe events, and a plain assignment goes unseen.
    const proto = tag === 'SELECT' ? HTMLSelectElement.prototype : tag === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return postFrameSnapshot();
  };
  // getComputedStyle serializes an ordinary color as rgb()/rgba(), so the 4th comma-part is the
  // alpha. Anything else — oklch(… / .5), color(srgb …) — is VISIBLE BUT NOT KNOWN OPAQUE (-1), the
  // safe direction: the walk keeps going and an opaque base still lands underneath, because the one
  // thing the composite must guarantee is a PNG with no alpha left in it to composite on white.
  const colorAlpha = (c) => {
    if (!c || c.indexOf('(') === -1) return 0;
    const parts = c.slice(c.indexOf('(') + 1, c.lastIndexOf(')')).split(',');
    if (parts.length === 3) return 1;
    if (parts.length !== 4) return -1;
    const a = parseFloat(parts[3]);
    return a === a ? a : -1;
  };
  // The UA's own page color, read from a Canvas system-color probe rather than hardcoded per
  // theme: html/body compute to rgba(0,0,0,0) in exactly the dark case that matters, so only the
  // system color knows what the user is actually looking at.
  const uaPageColor = () => {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;background-color:Canvas';
    document.body.appendChild(probe);
    try { return getComputedStyle(probe).backgroundColor; }
    finally { probe.parentNode.removeChild(probe); }
  };
  // The fills behind a canvas, bottom-up. Starts at the canvas ITSELF — a canvas's own background
  // paints behind its bitmap and is the nearest layer under the pixels — and stops at the first
  // opaque one, since nothing behind that shows. Translucent layers in between are collected rather
  // than treated as the bottom: stopping at a half-transparent panel would paint a half-transparent
  // backdrop and hand back a PNG that still composites on white, which is the bug this exists to
  // close. Only when no layer is known-opaque does the UA page color go underneath — so a page that
  // styles its own background never pays for the probe.
  const backdropOf = (el) => {
    const stack = [];
    for (let n = el; n; n = n.parentElement) {
      const c = getComputedStyle(n).backgroundColor;
      const a = colorAlpha(c);
      if (a === 0) continue;            // fully transparent: not a layer at all
      stack.unshift(c);                 // farther layers paint first
      if (a >= 1) return stack;
    }
    const page = uaPageColor();
    if (colorAlpha(page) >= 1) stack.unshift(page);
    return stack;
  };
  // The canvas as the user sees it: its backdrop painted first, then its own pixels. A chart
  // library's canvas is transparent, and a bare backing store opens as a WHITE frame in any
  // viewer — so the dark-theme render that most needs checking is the one that reads as blank
  // (TB-Interrogation-Pixels.md). A 0-size source would throw from drawImage, so callers guard it.
  // The fills are returned, never only applied: they APPROXIMATE the page (flat colors, no gradient
  // or image), so the reply has to be able to state what it assumed.
  const compositeOnBackdrop = (el) => {
    const shot = document.createElement('canvas');
    shot.width = el.width; shot.height = el.height;
    const g = shot.getContext('2d');
    const fills = backdropOf(el);
    for (const fill of fills) { g.fillStyle = fill; g.fillRect(0, 0, shot.width, shot.height); }
    g.drawImage(el, 0, 0);
    return { shot: shot, backdrop: fills.join(' + ') };
  };
  // tb:png (TB-Interrogation-Pixels.md): the page's canvas as PNG — bytes base64 in the reply
  // envelope. The shim knows nothing about files; the CLI decodes, writes one under its own home,
  // and prints the path. Resolution is a SUBSET of the outline's vocabulary: the sole visible
  // canvas needs no name (an edit is the state loss the verb avoids); several resolve as the
  // ordinary img role by name, descending from a named container to the one canvas it holds.
  const readPng = (rest) => {
    const m = /^\\s*(?:"([^"]*)"|(\\S+))?\\s*$/.exec(rest);
    if (!m) throw new Error('usage: tb:png ["<name>"]');
    const name = m[1] !== undefined ? m[1] : m[2];
    let el;
    let via = '';
    if (name === undefined) {
      const canvases = collectOutline().targets.filter((t) => t.el.tagName === 'CANVAS');
      if (!canvases.length) throw new Error('no canvas in the page (tb:png reads a canvas element back as PNG)');
      if (canvases.length > 1) {
        const named = canvases.filter((t) => t.name);
        throw new Error(canvases.length + ' canvases here — name one: tb:png "<name>"'
          + (named.length ? '; canvas names: ' + named.map((t) => '"' + t.name + '"').join(', ') : '')
          + (named.length < canvases.length ? ' (' + (canvases.length - named.length) + ' unnamed — an aria-label would make them targetable)' : ''));
      }
      el = canvases[0].el;
    } else {
      el = resolveTarget('img', name);
      if (el.tagName !== 'CANVAS') {
        // A charting library creates its own canvas, so the wrapper is the only element an author
        // can name at authoring time: descend from a named container to its single canvas. Counted
        // over the WALK, never querySelectorAll — a hidden scratch canvas must not force an
        // ambiguity the sole-canvas form wouldn't (TB-Interrogation-Pixels.md: the counting rule
        // and the outline must agree, or the verb contradicts itself).
        const inner = collectOutline().targets.filter((t) => t.el.tagName === 'CANVAS' && el.contains(t.el));
        if (inner.length !== 1) throw new Error(inner.length
          ? '"' + name + '" holds ' + inner.length + ' visible canvases — name one of them directly'
          : 'img "' + name + '" is <' + el.tagName.toLowerCase() + '>, not a canvas');
        via = name;
        el = inner[0].el;
      }
    }
    // toBlob throws from outside for a canvas that can't be read; name the cause — a tainted or
    // transferred canvas must exit non-zero, never read as an empty success. (A tainted source
    // taints the composite instead of throwing at drawImage, so the same throw still lands here.)
    return new Promise((resolve, reject) => {
      try {
        if (!el.width || !el.height) return reject(new Error('the canvas produced no pixels — is it 0×0?'));
        const composite = compositeOnBackdrop(el);
        composite.shot.toBlob((blob) => {
          if (!blob) return reject(new Error('the canvas did not encode to a PNG'));
          const fr = new FileReader();
          fr.onerror = () => reject(new Error('failed to read the encoded PNG'));
          fr.onload = () => {
            const s = String(fr.result);
            // backdrop/via ride the reply so the CLI's delivery line can state what the read
            // assumed and what it resolved through — an assumption the frame itself can't show.
            resolve({ png: s.slice(s.indexOf(',') + 1), width: el.width, height: el.height, backdrop: composite.backdrop, via: via });
          };
          fr.readAsDataURL(blob);
        }, 'image/png');
      } catch (err) {
        const why = err && err.name === 'SecurityError' ? 'it is tainted by a cross-origin draw'
          : err && err.name === 'InvalidStateError' ? 'its control was transferred to an OffscreenCanvas'
          : String((err && err.message) || err);
        reject(new Error('the canvas cannot be read: ' + why));
      }
    });
  };

  // tb:theme (Specs/Theme.md) — flip the page's theme so an agent can read the other render back
  // with tb:png / tb:snapshot. TRANSIENT by design, and the one place the durable rule is wrong:
  // it calls apply(), never set(), so it never writes the per-bulb localStorage key and a reload
  // restores whatever the user was looking at. The reply says so, because a probe with a visible
  // after-effect has to state it.
  const actTheme = (rest) => {
    const m = /^\\s*(dark|light)?\\s*$/.exec(rest);
    if (!m) throw new Error('usage: tb:theme [dark|light]  (bare clears the probe)');
    const engine = window.__tbTheme;
    if (!engine || !engine.apply) throw new Error('this page has no theme engine');
    const resting = engine.effective();
    const want = m[1] || resting;
    engine.apply(want);
    return postFrameSnapshot().then((s) =>
      'theme: ' + want + ' — transient, not saved (a reload restores ' + resting + ')\\n' + s);
  };

  // Events channel (dev server only): 'reload' drives hot reload (only emitted when watching),
  // 'message' delivers \`typebulb send\` pushes to tb.onMessage. Connect for a CLI-served page (http
  // origin, not an inline bulb); a srcdoc inline bulb or a file:// static export has no server, so onMessage just
  // stays inert there. Opening it independent of watch is what lets send reach a --no-watch page.
  if (!isFramed && location.protocol.indexOf('http') === 0) {
    // A page the CLI opened arrives as #tb-relay (TB-VSCode-Browser.md, one CLI-opened page): it
    // announces itself on its stream under a per-document id, and strips the hash so a reload is an
    // ordinary page. Told to yield, it closes itself; a tab the browser won't let a script close
    // parks instead, which still stops the bulb running twice.
    const relayed = location.hash === '#tb-relay';
    if (relayed) history.replaceState(null, '', location.pathname + location.search);
${reloadClientScript("relayed ? '/__reload?relay=' + Math.random().toString(36).slice(2) : '/__reload'")}
    es.addEventListener('yield', () => {
      es.close();
      window.close();
      setTimeout(() => location.replace('/__parked'), 250);
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
        const p = env.payload;
        // A failed compile still serves a page — with broken code, so it renders nothing. Every
        // read below would then describe an empty room ('(empty page)', 'no canvas in the page'):
        // true, useless, and indistinguishable from a bulb that simply draws nothing. The server
        // knew the cause at compile time, so the page carries it and every reserved read states it.
        if (window.__TB_COMPILE_ERROR__) throw new Error('the bulb did not compile, so the page is empty: ' + window.__TB_COMPILE_ERROR__);
        if (p === 'tb:snapshot') return snapshot();
        if (p === 'tb:click' || p.indexOf('tb:click ') === 0) return actClick(p.slice(9));
        if (p === 'tb:set' || p.indexOf('tb:set ') === 0) return actSet(p.slice(7));
        if (p === 'tb:rect' || p.indexOf('tb:rect ') === 0) return readRect(p.slice(8));
        if (p === 'tb:png' || p.indexOf('tb:png ') === 0) return readPng(p.slice(7));
        if (p === 'tb:theme' || p.indexOf('tb:theme ') === 0) return actTheme(p.slice(9));
        throw new Error('unknown reserved message: ' + p + ' (known: tb:snapshot, tb:rect, tb:png, tb:click, tb:set, tb:theme)');
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
  }
})();
`
