/**
 * The tb.infer() modal (TB-Inference.md), served at /__infer-ui.js and lazy-imported by the shim
 * on the first tb.infer() call — the bulb page carries none of this until then. Runs in a closed
 * shadow root so bulb CSS can't reach in and modal styles can't leak out. Deliberately NOT shared
 * with typebulb.com's modal (domeleon/client-entangled): same state machine
 * (confirm → streaming → complete/error+retry), independent code.
 *
 * Kept as a plain-string ES module (the shim precedent) rather than an esbuild entry: no build
 * wiring, identical behavior under vitest/src. Constraint: no backticks and no "${" inside.
 * The string is the cheapest faithful form of the real invariant (a lazily-served asset, zero
 * bytes in the page until first use) — if this file grows materially (tabs, more states, a
 * dependency), it graduates to an esbuild browser entry served from dist, the mirror-client
 * pattern. inferRoute.test.ts imports the string as a module, so a syntax error fails CI.
 */

export const inferModalJs = `
const CSS = '\\n' +
/* The agent mirror's token set, verbatim (agents/core/client/styles.css) — one system across CLI
   chrome: app chrome sits on --panel, content wells paint --veil, grays ride one neutral tint.
   The lone extension is --accent-contrast (text on a filled accent; the mirror never fills a
   button, and the dark theme's lighter accent needs dark text). */
'.overlay { --fg: rgb(28, 28, 30); --muted: rgb(96, 96, 100); --panel: rgb(242, 242, 242);\\n' +
'  --border: rgb(221, 221, 221); --accent: rgb(58, 125, 232); --accent-contrast: #fff;\\n' +
'  --veil: rgba(0, 0, 0, 0.05); --err: rgb(206, 60, 60); }\\n' +
'.dark .overlay { --fg: rgb(190, 190, 190); --muted: rgb(150, 150, 150); --panel: rgb(32, 32, 32);\\n' +
'  --border: rgb(52, 52, 52); --accent: rgb(122, 162, 250); --accent-contrast: #1c1e21;\\n' +
'  --veil: rgba(255, 255, 255, 0.06); --err: rgb(230, 60, 60); }\\n' +
'.overlay { position: fixed; inset: 0; background: rgba(0,0,0,.45); z-index: 2147483000;\\n' +
'  display: flex; align-items: center; justify-content: center; padding: 16px;\\n' +
'  font: 14px/1.45 system-ui, sans-serif; color: var(--fg); }\\n' +
'.card { background: var(--panel); border-radius: 10px; box-shadow: 0 12px 40px rgba(0,0,0,.35);\\n' +
'  width: min(560px, 100%); max-height: min(80vh, 640px); display: flex; flex-direction: column; }\\n' +
'.head { display: flex; align-items: center; gap: 8px; padding: 14px 16px 10px; }\\n' +
'.head h1 { font-size: 18px; font-weight: 600; margin: 0; flex: 1; color: var(--accent); }\\n' +
'.x { border: 0; background: none; color: inherit; font-size: 18px; cursor: pointer; opacity: .6; padding: 2px 6px; }\\n' +
'.x:hover { opacity: 1; }\\n' +
'.body { padding: 0 16px; overflow-y: auto; flex: 1; display: flex; flex-direction: column; gap: 10px; }\\n' +
'.model { color: var(--muted); }\\n' +
'.model.err { color: var(--err); }\\n' +
'.note { color: var(--muted); }\\n' +
'label { font-weight: 600; }\\n' +
'.tabs { display: flex; gap: 4px; }\\n' +
'.tab { font: inherit; padding: 4px 10px; border: 0; border-bottom: 2px solid transparent; border-radius: 0; background: none; color: inherit; cursor: pointer; opacity: .6; }\\n' +
'.tab.on { opacity: 1; border-bottom-color: var(--accent); }\\n' +
'.tab .cnt { opacity: .6; font-size: 12px; margin-left: 4px; }\\n' +
'textarea { width: 100%; box-sizing: border-box; min-height: 160px; max-height: 320px; resize: vertical;\\n' +
'  font: 13px/1.4 ui-monospace, monospace; padding: 8px; border-radius: 6px;\\n' +
'  border: 1px solid var(--border); background: var(--veil); color: inherit; }\\n' +
'pre.stream { font: 13px/1.4 ui-monospace, monospace; white-space: pre-wrap; word-break: break-word;\\n' +
'  background: var(--veil); border-radius: 6px; padding: 10px; margin: 0; min-height: 120px; }\\n' +
'.error { color: var(--err); white-space: pre-wrap; }\\n' +
'.foot { display: flex; gap: 8px; padding: 12px 16px 14px; justify-content: flex-end; align-items: center; }\\n' +
'.leftgrp { margin-right: auto; display: flex; gap: 8px; }\\n' +
'button { font: inherit; padding: 6px 14px; border-radius: 6px; cursor: pointer;\\n' +
'  border: 1px solid var(--border); background: transparent; color: inherit; }\\n' +
'button.iconbtn { padding: 6px 9px; display: inline-flex; align-items: center; }\\n' +
'button.iconbtn svg { display: block; }\\n' +
'button.run { background: var(--accent); border-color: var(--accent); color: var(--accent-contrast); }\\n' +
'button.run:disabled { opacity: .5; cursor: default; }\\n' +
'@keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }\\n' +
'.shimmer { display: inline-block; background-image: linear-gradient(90deg, var(--muted), var(--fg), var(--muted));\\n' +
'  background-size: 200% 100%; -webkit-background-clip: text; background-clip: text;\\n' +
'  -webkit-text-fill-color: transparent; color: transparent; animation: shimmer 2s linear infinite; }\\n';

function isDark() {
  var t = document.documentElement.getAttribute('data-theme');
  if (t) return t === 'dark';
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function el(tag, cls, text) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// Per-chunk label: config dataTitle (comma-delimited) > a #/// comment-header first line > Data N.
// The same fallback chain as .com's DataChunkEditor.
function chunkLabel(chunk, i, titles) {
  if (titles[i]) return titles[i];
  var first = (chunk.split('\\n')[0] || '').trim();
  if (first.charAt(0) === '#' && first.length > 1 && first.length < 40) return first.replace(/^#+\\s*/, '');
  if (first.indexOf('//') === 0 && first.length > 2 && first.length < 40) return first.replace(/^\\/\\/\\s*/, '');
  return 'Data ' + (i + 1);
}

/**
 * Open the inference modal. ctx: { data: string[], readStream(resp), onComplete(final),
 * onError(err), onCancel(), runtimeState() }. readStream is the SHIM's NDJSON reader (an async iterable of chunk
 * values that throws error envelopes as Error with code/retryable) — passed in so the page has
 * exactly one copy of the transport decoder. onComplete fires on every successful run (a retry
 * after an error included); onError on each displayed terminal error; onCancel when the user
 * closes before any completion. runtimeState() returns the wire pair for what a prior run actually
 * set — a slot nobody set is absent from it, so an empty pair means nothing was — which is what
 * Save files and what gates these controls. With no infer.md block the same call opens the Bulb
 * state panel instead: the run half dropped, the state half kept (TB-Inference.md).
 */
export function runInference(ctx) {
  var host = document.createElement('div');
  var root = host.attachShadow({ mode: 'closed' });
  var style = document.createElement('style');
  style.textContent = CSS;
  root.appendChild(style);

  var wrap = el('div', isDark() ? 'dark' : '');
  root.appendChild(wrap);
  var overlay = el('div', 'overlay');
  wrap.appendChild(overlay);
  var card = el('div', 'card');
  overlay.appendChild(card);

  var completed = false;
  var canceled = false;
  var aborter = null;
  var inferCfg = {};
  var dataTitles = function () {
    return String(inferCfg.dataTitle || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  };

  function close(kind) {
    if (kind === 'cancel') canceled = true;
    if (aborter) { aborter.abort(); aborter = null; }
    host.remove();
    if (kind === 'cancel' && !completed) ctx.onCancel();
  }
  overlay.addEventListener('click', function (e) { if (e.target === overlay) close('cancel'); });

  var head = el('div', 'head');
  var title = el('h1', '', 'Run AI inference');
  head.appendChild(title);
  var x = el('button', 'x', '\\u00d7');
  x.addEventListener('click', function () { close('cancel'); });
  head.appendChild(x);
  card.appendChild(head);

  var body = el('div', 'body');
  card.appendChild(body);
  var foot = el('div', 'foot');
  card.appendChild(foot);

  // ── Confirmation state ──────────────────────────────────────────────────
  var areas = [];
  function showConfirm() {
    body.textContent = ''; foot.textContent = ''; areas = [];

    var model = el('div', 'model');
    model.appendChild(el('span', 'shimmer', 'Resolving model\\u2026'));
    body.appendChild(model);
    var cancel = el('button', '', 'Cancel');
    cancel.addEventListener('click', function () { close('cancel'); });
    foot.appendChild(cancel);

    // Build the whole view once the seed arrives (a localhost roundtrip; the shimmer covers it).
    // The same reply decides which view it is: no infer.md block, no run half (buildConfirm).
    fetch('/__infer-info').then(function (r) { return r.json(); })
      .catch(function () { return {}; })
      .then(function (info) { buildConfirm(info || {}); });
  }

  function formatCount(n) { return n < 10000 ? String(n) : Math.round(n / 1000) + 'K'; }

  // One line naming what Save would file, in the blocks it writes. Only what it writes: a slot
  // nobody set is left out rather than reported as untouched, which draws the eye to a non-event.
  function stateSummary(rt) {
    var chunks = rt.data || [];
    var hasInsight = 'insight' in rt;
    if (!chunks.length && !hasInsight) {
      return 'Nothing set: this page is showing the bulb\\u2019s own data.txt and insight.json';
    }
    if (!chunks.length) return 'Save writes insight.json';
    var chars = 0;
    for (var i = 0; i < chunks.length; i++) chars += chunks[i].length;
    var d = 'data.txt (' + (chunks.length > 1 ? chunks.length + ' chunks, ' : '')
      + formatCount(chars) + ' chars)';
    return 'Save writes ' + d + (hasInsight ? ' and insight.json' : '');
  }

  // The data view: an editor for a run, a read-only readout in the Bulb state panel, where edits
  // would go nowhere (Save posts the pair, never a textarea) and the tab strip is the best display
  // of a multi-chunk slot there is.
  // Seeding is explicit ctx.data (an argument, or a retry's edits) > what the
  // page currently holds > the bulb's SOURCE chunks from the server. Runtime ahead of source so a
  // reopen shows the chunks the page is actually on, matching .com; the explicit argument ahead of
  // both, where .com puts the slot first and so loses tb.infer({ data }) after a prior run. An
  // emptied chunk does not come back this way (run() drops it) — Discard run is what does.
  function buildEditor(info, rt, readOnly) {
    var chunks = ctx.data && ctx.data.length ? ctx.data
      : (rt.data && rt.data.length ? rt.data
      : (info.data && info.data.length ? info.data : ['']));
    var titles = dataTitles();
    // Multi-chunk: .com's shape — a tab per chunk (label + live char count), one textarea visible.
    var multi = chunks.length > 1;
    var tabBtns = [];
    var counts = [];
    var strip = multi ? el('div', 'tabs') : null;
    if (strip) body.appendChild(strip);
    function selectTab(i) {
      tabBtns.forEach(function (b, j) { b.className = j === i ? 'tab on' : 'tab'; });
      areas.forEach(function (a, j) { a.style.display = j === i ? '' : 'none'; });
    }
    chunks.forEach(function (chunk, i) {
      if (multi) {
        var tab = el('button', 'tab');
        tab.appendChild(el('span', '', chunkLabel(chunk, i, titles)));
        var cnt = el('span', 'cnt', '(' + formatCount(chunk.length) + ')');
        counts.push(cnt);
        tab.appendChild(cnt);
        tab.addEventListener('click', function () { selectTab(i); });
        tabBtns.push(tab);
        strip.appendChild(tab);
      } else {
        body.appendChild(el('label', '', titles[0] || (readOnly ? 'data.txt' : 'Data to process')));
      }
      var ta = document.createElement('textarea');
      ta.value = chunk;
      ta.readOnly = !!readOnly;
      if (!chunk) ta.placeholder = 'Paste data to process (optional)\\u2026';
      ta.addEventListener('input', function () {
        // 2 blank lines IS the chunk separator — collapse pasted 3+ so text can't silently split (.com parity)
        var v = ta.value.replace(/\\n{3,}/g, '\\n\\n');
        if (v !== ta.value) ta.value = v;
        if (multi) counts[i].textContent = '(' + formatCount(ta.value.length) + ')';
      });
      areas.push(ta);
      body.appendChild(ta);
    });
    if (multi) selectTab(0);
  }

  function buildConfirm(info) {
    body.textContent = ''; foot.textContent = ''; areas = [];
    var rt = ctx.runtimeState();
    // No infer.md: nothing here can run, so the modal is the page's state surface and nothing else
    // (TB-Inference.md). Same actions, minus the run — and the config.inference title stays out of
    // it, because it names a run that cannot happen.
    var stateOnly = info.hasInfer === false;
    inferCfg = stateOnly ? {} : (info.inference || {});
    if (stateOnly) title.textContent = 'Bulb state';
    else if (inferCfg.title) title.textContent = inferCfg.title;

    var runBtn = null;
    if (!stateOnly) {
      var model = el('div', 'model');
      runBtn = el('button', 'run', inferCfg.submitTitle || 'Run');
      if (info.error) { model.textContent = info.error; model.className = 'model err'; runBtn.disabled = true; }
      else if (info.model) model.textContent = info.model + ' \\u00b7 ' + info.provider;
      else model.textContent = 'Model info unavailable';
      buildEditor(info, rt, false);
      // The model line reads as a footnote to the action, not a header to the data — under the
      // textareas, above the buttons.
      body.appendChild(model);
    }
    // The panel reads out what tb.data() answers: the slot when a setter filled it, the file's
    // chunks when none did. Skipped only when there is neither, where the caption says so instead.
    else if ((rt.data && rt.data.length) || (info.data && info.data.length)) buildEditor(info, rt, true);
    // What Save would file, beside the button that files it: Save posts the runtime pair and never
    // the textareas above it. In the state panel this line is the whole of the body.
    if (stateOnly || Object.keys(rt).length) body.appendChild(el('div', 'note', stateSummary(rt)));

    // Actions over a prior run. Save and Discard follow the RUN (runtime state), share follows the
    // FRAGMENT: filing has no size ceiling, only the URL does, so an over-ceiling run that minted no
    // link is still savable (TB-State.md, "The ceiling bounds sharing, not saving").
    // Any key means a slot was set: the pair carries only what someone wrote, so counting keys
    // asks that without restating which slots exist or how an unset one is spelled.
    if (Object.keys(rt).length) {
      var grp = el('div', 'leftgrp');
      // Drop the run from the address bar. Both actions below leave the page holding the run it is
      // showing and only stop addressing it: Save because the file now has it, Discard because the
      // reload that follows is what puts the page back on the file's blocks.
      var unaddress = function () { history.replaceState(null, '', location.pathname + location.search); };
      if (location.hash.indexOf('tb=') !== -1) {
        // Icon-only: the glyph reads as "copy link", the title carries the words, and the footer
        // keeps room for three actions without wrapping.
        var LINK_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';
        var share = el('button', 'iconbtn');
        share.innerHTML = LINK_SVG;
        share.setAttribute('aria-label', 'Copy share URL');
        share.title = 'Copies this page URL with the #tb= result fragment \\u2014 paste the fragment onto the published bulb\\u2019s URL to share the last run';
        share.addEventListener('click', function () {
          navigator.clipboard.writeText(location.href).then(function () {
            share.textContent = '\\u2713';
            setTimeout(function () { share.innerHTML = LINK_SVG; }, 1500);
          });
        });
        grp.appendChild(share);
      }
      var save = el('button', '', 'Save to bulb');
      save.title = 'Write this run\\u2019s data + insight into the .bulb.md as its new defaults';
      save.addEventListener('click', function () {
        save.disabled = true;
        fetch('/__infer-save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(ctx.runtimeState())
        }).then(async function (r) {
          if (!r.ok) { var t = await r.text(); var err; try { err = JSON.parse(t).message; } catch (e) { err = t; } throw new Error(err || 'Save failed'); }
        }).then(function () {
          // The run is source now, so the link that carried it is redundant. Under watch, the file
          // write is about to hot-reload the page onto its new defaults anyway.
          unaddress();
          save.textContent = 'Saved \\u2713';
        }).catch(function (e) {
          save.textContent = 'Save failed'; save.title = e.message; save.disabled = false;
        });
      });
      grp.appendChild(save);
      var discard = el('button', '', 'Discard run');
      discard.title = 'Drop this run\\u2019s result \\u2014 back to the bulb\\u2019s own data and example insight';
      discard.addEventListener('click', function () {
        // The fragment IS the runtime state (TB-Inference.md Invariant 2): strip it and reload,
        // and the page boots from the file's blocks. The file is never touched.
        unaddress();
        location.reload();
      });
      grp.appendChild(discard);
      foot.appendChild(grp);
    }

    if (stateOnly) {
      var closeBtn = el('button', '', 'Close');
      closeBtn.addEventListener('click', function () { close('cancel'); });
      foot.appendChild(closeBtn);
      return;
    }
    var cancel = el('button', '', 'Cancel');
    cancel.addEventListener('click', function () { close('cancel'); });
    foot.appendChild(cancel);
    runBtn.addEventListener('click', run);
    foot.appendChild(runBtn);
  }

  // ── Streaming / error states ────────────────────────────────────────────
  function run() {
    var data = areas.map(function (a) { return a.value.trim(); }).filter(function (v) { return v !== ''; });
    ctx.data = data;  // a retry's confirm re-seeds from the edited chunks, not the originals
    body.textContent = ''; foot.textContent = '';

    var pre = el('pre', 'stream', '');
    var waiting = el('span', 'shimmer', 'Waiting for response\\u2026');
    pre.appendChild(waiting);
    var textNode = null;
    body.appendChild(pre);
    var cancel = el('button', '', 'Cancel');
    cancel.addEventListener('click', function () { close('cancel'); });
    foot.appendChild(cancel);

    aborter = new AbortController();
    (async function () {
      var resp = await fetch('/__infer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: data }),
        signal: aborter.signal
      });
      if (resp.headers.get('X-TB-Stream') !== '1') {
        // Non-stream response: a 403 trust denial (plain text) or a 400/500 JSON error.
        var text = await resp.text();
        var err; try { err = JSON.parse(text); } catch (e) { err = { message: text, code: 'unknown', retryable: false }; }
        var e2 = new Error(err.message || 'Inference failed'); e2.code = err.code; e2.retryable = !!err.retryable;
        throw e2;
      }
      var final = null;
      for await (var v of ctx.readStream(resp)) {
        if (v.kind === 'delta') {
          if (waiting) { waiting.remove(); waiting = null; textNode = document.createTextNode(''); pre.appendChild(textNode); }
          textNode.appendData(v.text); pre.scrollTop = pre.scrollHeight;
        }
        else if (v.kind === 'complete') final = v;
      }
      if (!final) { var e3 = new Error('Stream ended without a result'); e3.code = 'network'; e3.retryable = true; throw e3; }
      completed = true;
      ctx.onComplete(final);
      close('complete');
    })().catch(function (err) {
      if (canceled) return; // user canceled; close() already ran and the abort rejection is expected
      showError(err);
    });
  }

  function showError(err) {
    body.textContent = ''; foot.textContent = '';
    body.appendChild(el('div', 'error', err.message || 'Inference failed'));
    ctx.onError({ message: err.message, code: err.code || 'unknown', retryable: !!err.retryable });

    var closeBtn = el('button', '', 'Close');
    closeBtn.addEventListener('click', function () { close('cancel'); });
    foot.appendChild(closeBtn);
    if (err.retryable) {
      var retry = el('button', 'run', 'Retry');
      retry.addEventListener('click', showConfirm);
      foot.appendChild(retry);
    }
  }

  showConfirm();
  document.body.appendChild(host);
}
`
