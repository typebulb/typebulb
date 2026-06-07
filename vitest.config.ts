import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    // Override logic is pure Node (fs / path / es-module-lexer); no DOM needed.
    environment: 'node',
    include: ['cli/tests/**/*.test.ts', 'format/tests/**/*.test.ts'],
  },
})
