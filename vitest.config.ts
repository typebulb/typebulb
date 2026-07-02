import { defineConfig, configDefaults } from 'vitest/config'
import * as path from 'path'

// Resolve `typebulb/*` subpaths to source, not dist. Package exports point at
// dist/, so without this a test run silently exercises stale build output after
// a src edit (a fix "doesn't work" until you remember to `pnpm run build`).
const subpathAliases = Object.fromEntries(
  ['ai', 'dts', 'format', 'lint', 'resolver', 'transpile'].map(sub =>
    [`typebulb/${sub}`, path.resolve(__dirname, sub, 'src/index.ts')]),
)

export default defineConfig({
  resolve: { alias: subpathAliases },
  test: {
    globals: true,
    // Override logic is pure Node (fs / path / es-module-lexer); no DOM needed.
    environment: 'node',
    include: [
      'ai/tests/**/*.test.ts',
      'cli/tests/**/*.test.ts',
      'format/tests/**/*.test.ts',
      'dts/tests/**/*.test.ts',
      'resolver/tests/**/*.test.ts',
    ],
    // The live-browser suite (cli/tests/browser) launches Chromium via Playwright and runs
    // under vitest.browser.config.ts (`pnpm test:browser`); keep it out of the fast default suite.
    exclude: [...configDefaults.exclude, 'cli/tests/browser/**'],
  },
})
