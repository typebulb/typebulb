/**
 * The scroll-restoration engine a rendered bulb document ships (specs/Scroll-Restoration.md).
 * ONE copy, beside pageShell.ts and on its argument: both hosts must emit the same behavior or a
 * bulb restores differently local vs published. A script string for the page <head>; the host's
 * own snippet then calls `window.__tbScroll.init({ initialY, save })` to say where the offset
 * comes from and where reports go (the CLI: the page's sessionStorage; the sandbox: a postMessage
 * to the parent).
 *
 *   init({ initialY, save }) -> arm the re-apply loop at initialY (0: nothing to do); save(y) is
 *                                the throttled reporter's sink
 *   restore(y)               -> re-arm at y (a traversal landed); undefined or 0 scrolls to top
 *   top()                    -> a page-shaped move landed: disarm, scroll to 0, report 0
 *   flush()                  -> report the pending offset now (before a route change goes out)
 *
 * While armed, every frame writes `y` once the document is tall enough, and the loop stands down
 * on the first scroll it did not author (input, the browser's scroll anchoring, a bulb scrolling
 * itself) or TAIL_MS after `load`. A clamp (the document shrank under us) is exempt. Native
 * restoration gives up at `load`; this covers the tail a bulb that renders after load needs.
 */
export const scrollRestoreEngine = `(function () {
  var W = window, D = document;
  var TAIL_MS = 1500, TOL = 2, THROTTLE_MS = 200;
  var SCROLL_KEYS = { ' ': 1, ArrowUp: 1, ArrowDown: 1, PageUp: 1, PageDown: 1, Home: 1, End: 1 };
  var save = null;
  var target = 0, armed = false, applied = false, lastWritten = -1, raf = 0, deadline = 0;
  var pending, timer = 0;

  var maxY = function () { var d = D.documentElement; return Math.max(0, d.scrollHeight - d.clientHeight); };
  var write = function (y) {
    lastWritten = y;
    try { W.scrollTo({ top: y, left: 0, behavior: 'instant' }); } catch (e) { W.scrollTo(0, y); }
  };
  var disarm = function () {
    armed = false;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (deadline) { clearTimeout(deadline); deadline = 0; }
  };
  var tick = function () {
    if (!armed) return;
    if (target <= maxY()) { applied = true; if (Math.abs(W.scrollY - target) > TOL) write(target); }
    raf = requestAnimationFrame(tick);
  };
  var expire = function () {
    if (!armed) return;
    if (!applied) { var y = Math.min(target, maxY()); if (y > 0) write(y); }
    disarm();
  };
  var arm = function (y) {
    disarm();
    target = y; applied = false;
    if (!(y > 0)) return;
    armed = true;
    raf = requestAnimationFrame(tick);
    var start = function () { if (armed && !deadline) deadline = setTimeout(expire, TAIL_MS); };
    if (D.readyState === 'complete') start(); else W.addEventListener('load', start, { once: true });
  };

  var report = function (y) { if (save) { try { save(y); } catch (e) {} } };
  var flush = function () {
    if (timer) { clearTimeout(timer); timer = 0; }
    if (pending !== undefined) { var y = pending; pending = undefined; report(y); }
  };

  W.addEventListener('scroll', function () {
    var y = W.scrollY;
    pending = y;
    if (!timer) timer = setTimeout(flush, THROTTLE_MS);
    if (!armed || Math.abs(y - lastWritten) <= TOL) return;
    if (y < target && Math.abs(y - maxY()) <= TOL) return;
    disarm();
  }, { passive: true });
  W.addEventListener('wheel', disarm, { capture: true, passive: true });
  W.addEventListener('touchstart', disarm, { capture: true, passive: true });
  W.addEventListener('keydown', function (e) { if (SCROLL_KEYS[e.key]) disarm(); }, { capture: true });

  W.__tbScroll = {
    init: function (o) {
      save = o && typeof o.save === 'function' ? o.save : null;
      arm(o ? Number(o.initialY) : 0);
    },
    restore: function (y) {
      y = Number(y);
      if (y > 0 && isFinite(y)) arm(y); else { disarm(); write(0); }
    },
    top: function () { disarm(); write(0); report(0); },
    flush: flush
  };
})();`
