import { defineConfig } from 'vitest/config'

// Tier B — the live-browser exploit suite (TB-Security-Tests.md). Separate config,
// not the default `pnpm test`: these launch a real Chromium via Playwright (driven as
// a library), so they're slow and kept out of the fast node suite. Run with
// `pnpm test:browser`. Disjoint from the default include by directory, so neither
// suite ever discovers the other's files (Invariant 4).
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['cli/tests/browser/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Playwright is a native node module — keep Vite from trying to transform it.
    server: { deps: { external: ['playwright', 'playwright-core'] } },
  },
})
