import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    include: ['test/**/*.test.ts'],
    // Coverage runs every package at once: the 5 s default was exceeded under that load.
    testTimeout: 15_000,
    setupFiles: ['test/support/setup.ts'],
    coverage: {
      // Spec §9 targets; measured on the package's own source only.
      provider: 'v8',
      include: ['src/**'],
      thresholds: { lines: 85, statements: 85, branches: 75, functions: 80 },
    },
    environment: 'happy-dom',
    // happy-dom's own requests never leave the process: test/support/setup.ts.
    environmentOptions: {
      happyDOM: {
        url: 'http://localhost:4321/',
        // happy-dom 21 (2026-11-01 audit) loads no frame page or style sheet unless asked: the plugin
        // tests need a frame's window, and test/no-network.test.ts proves both stay intercepted.
        settings: { enableIframePageLoading: true, enableCSSFileLoading: true },
      },
    },
  },
})
