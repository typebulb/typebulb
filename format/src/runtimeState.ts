/**
 * The runtime-state writers a rendered bulb document ships (runtime-specs/TB-State.md).
 * ONE copy, beside scrollRestore.ts and for the same reason: `tb.setData` / `tb.setInsight` are a
 * contract both hosts owe a bulb, so a second implementation is a second set of semantics waiting
 * to drift. What differs between hosts is only where the page globals live and how the pair
 * reaches an address bar, and both arrive through `init`.
 *
 *   init({ applyData, applyInsight, send })
 *     applyData(chunks)   -> put the chunks in this host's data global
 *     applyInsight(json)  -> put the serialized insight in this host's insight global
 *     send(pair)          -> hand { data?, insight? } to this host's transport; resolve the
 *                            shareable URL, or undefined when there is none. Must never reject:
 *                            every failure reads to a bulb as "no link".
 *
 *   setData(chunks) / setInsight(value) -> the two tb.* writers, resolving send's URL
 *   seed(pair)  -> apply and record what a decoded `#tb=` fragment carried, without sending it back
 *   pair()      -> the wire pair, for a host that files it (the CLI modal's Save). Empty when
 *                  nothing has been set, which is also how a host asks whether anything has.
 *
 * The recorded pair is deliberately NOT the page globals, which boot holding the file's own
 * blocks: only a slot someone set travels, so an untouched one falls through to source (Invariant
 * 3) instead of spending the URL ceiling on a copy of the file. It is built key by key, so an
 * unset slot is ABSENT rather than present-and-undefined: both receivers test `'insight' in pair`,
 * which stays exact for a null insight and needs no companion flag.
 *
 * Coalescing keys on whether the in-flight write has read the pair yet, not on whether one is
 * outstanding. Writes landing before that ride it and share its URL, one round trip for the pair;
 * a write landing after it queues one re-send, because the write on the wire carries a state the
 * page has moved past. Answering it with that URL would address a run the page no longer shows,
 * and skipping the re-send would leave the address bar doing so (Invariant 6).
 */
export const runtimeStateEngine = `(function () {
  var W = window;
  var rtData, rtInsight, rtHasInsight = false;
  var applyData, applyInsight, send;
  var pending = null, sent = false, queued = null;

  var pair = function () {
    var p = {};
    if (rtData !== undefined) p.data = rtData;
    if (rtHasInsight) p.insight = rtInsight;
    return p;
  };

  var start = function () {
    sent = false;
    return Promise.resolve()
      .then(function () { sent = true; return send(pair()); })
      .catch(function () { return undefined; })
      .finally(function () { pending = null; });
  };
  var publish = function () {
    if (!pending) { pending = start(); return pending; }
    if (!sent) return pending;
    if (!queued) queued = pending.then(function () { queued = null; return publish(); });
    return queued;
  };

  W.__tbState = {
    init: function (o) { applyData = o.applyData; applyInsight = o.applyInsight; send = o.send; },
    pair: pair,
    // Applied but not sent: the fragment already holds this, so sending it back would re-encode
    // the state the page just booted from.
    seed: function (p) {
      if (p.data !== undefined) { rtData = p.data; applyData(p.data); }
      if ('insight' in p) { rtInsight = p.insight; rtHasInsight = true; applyInsight(JSON.stringify(p.insight, null, 2)); }
    },
    // The globals move before the round trip, so a synchronous tb.data() right after the await is
    // never stale.
    setData: function (chunks) {
      var arr = Array.isArray(chunks) ? chunks : [chunks];
      rtData = arr;
      applyData(arr);
      return publish();
    },
    setInsight: function (value) {
      // Serialize before recording: a value JSON.stringify rejects (a cycle, a BigInt) must leave
      // the slot untouched, or every later setter carries a pair that can never be encoded or sent.
      var json = JSON.stringify(value, null, 2);
      rtInsight = value;
      rtHasInsight = true;
      applyInsight(json);
      return publish();
    }
  };
})();`
