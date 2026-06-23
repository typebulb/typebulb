import { defineConfig, configDefaults } from 'vitest/config'

export default defineConfig({
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
