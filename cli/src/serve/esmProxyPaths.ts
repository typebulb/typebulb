// Which request paths are absolute imports an esm.sh module body emits — the ones the CLI must
// re-proxy to esm.sh rather than 404 (runtime-specs/TB-Proxy.md Invariant 3). Because the CLI serves module
// BYTES from localhost, an absolute import inside one resolves against localhost, not the CDN, so
// the catch-all (serve/server.ts) re-routes anything matching here. Single source of truth so the
// server route and its tests agree.
//
// Matched by path shape (esm.sh's versioned/build-prefixed forms):
//   /v<n>/...           — versioned build prefix
//   /stable/...         — stable build prefix
//   /node/...           — Node built-in polyfills (buffer, stream, ...)
//   /gh/...             — GitHub release builds
//   /@<scope>/<pkg>@... — scoped package with version
//   /<pkg>@...          — bare package with version
// Plain word paths (`/favicon.ico`, `/about`, `/main.css.map`, SPA routes) intentionally do NOT
// match — they get a real 404 instead of being silently relayed upstream.
//
// esm.sh also emits UNVERSIONED subpaths — e.g. `/d3-array/src/ascending?target=es2022` (from
// globe.gl's d3 deps when esm.sh doesn't inline them under `bundle=`). Those carry no version to
// match on, but esm.sh tags every module URL it emits with a build-`target=` query and preserves
// it on the internal sub-imports, so the marker is what tells an esm import apart from a 404-worthy
// app route. Without this branch the subpaths resolve to localhost and 404 the whole module graph.
export const ESM_PATH_RE = /^\/(v\d+\/|stable\/|node\/|gh\/|@[^/]+\/[^@/]+@|[^@/]+@)/

// esm.sh's build-target marker — present on every module URL it serves, never on an app route.
const ESM_TARGET_MARKER = /[?&]target=/
// A package-style subpath: optional @scope, a name segment, then ≥1 more segment.
const PACKAGE_SUBPATH_RE = /^\/(?:@[^/]+\/)?[^/@]+\/[^/]+/

/** Is `pathname` (with optional `search`) an absolute esm.sh import the CLI must re-proxy? */
export function isEsmAbsoluteImportPath(pathname: string, search = ''): boolean {
  if (ESM_PATH_RE.test(pathname)) return true
  // Unversioned subpath: an esm.sh import only if it carries the build-target marker; otherwise
  // it's an app route and must get a real 404, never a silent upstream relay.
  return PACKAGE_SUBPATH_RE.test(pathname) && ESM_TARGET_MARKER.test(search)
}
