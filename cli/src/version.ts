// Replaced at build time by esbuild's `define` (dist/index.js only). The guard keeps every other
// consumer safe — the `./servers` bundle and the unbundled test run fall back to the dev sentinel.
declare const __TYPEBULB_VERSION__: string
export const VERSION: string = typeof __TYPEBULB_VERSION__ !== 'undefined' ? __TYPEBULB_VERSION__ : '0.0.0-dev'
