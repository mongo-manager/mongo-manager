import { defineConfig } from 'vite'
import { thirdPartyList } from '../../../scripts/third-party.mjs'

/**
 * Plugins wave 1: built into packages/plugins/dist/time-hints, the folder the server finds bundled
 * plugins in. Relative paths (served under its ticket), no inline script (the frame's policy
 * allows its own files only), assets as files.
 */
export default defineConfig({
  base: './',
  // The packages this build is made of, for the release's notices (review 2026-10-13).
  plugins: [thirdPartyList()],
  build: {
    outDir: '../dist/time-hints',
    emptyOutDir: true,
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
    sourcemap: false,
  },
})
