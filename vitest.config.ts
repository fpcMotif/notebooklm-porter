import { defineConfig } from 'vitest/config'
import { WxtVitest } from 'wxt/testing/vitest-plugin'

export default defineConfig({
  plugins: [WxtVitest()],
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      // Gate the pure pipeline — adapters, formatters, model helpers under
      // src/core/**. Entrypoint glue (service worker, content scripts,
      // Preact views) is exercised by the real extension, not unit tests.
      include: ['src/core/**/*.{ts,tsx}'],
      exclude: ['**/*.{test,spec}.{ts,tsx}', '**/*.d.ts'],
    },
  },
})
