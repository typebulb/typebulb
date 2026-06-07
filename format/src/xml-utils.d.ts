// xml-utils ships types (index.d.ts) but its package.json "exports" has no "types" condition, so
// TS "bundler" module resolution can't see them. Declare the one helper detection.ts uses, matching
// the upstream signature.
declare module 'xml-utils' {
  export type Tag = { inner: null | string; outer: string }
  export function findTagByName(
    xml: string,
    tagName: string,
    options?: { debug?: boolean; nested?: boolean; startIndex?: number }
  ): Tag | undefined
}
