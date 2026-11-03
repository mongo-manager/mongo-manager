import { defineConfig } from 'vite'
import { thirdPartyList } from '../../../scripts/third-party.mjs'
import { bsonWithoutWasm } from '../kit/tooling/bsonWithoutWasm'

/**
 * Plugins wave 1: built into packages/plugins/dist/sql-to-mongodb, the folder the server finds bundled
 * plugins in. Relative paths (served under its ticket), no inline script (the frame's policy
 * allows its own files only), assets as files.
 */
export default defineConfig({
  base: './',
  // User report 2026-10-11: bson's WebAssembly helper never runs in the frame; the scan saw it.
  plugins: [thirdPartyList(), bsonWithoutWasm()],
  build: {
    outDir: '../dist/sql-to-mongodb',
    emptyOutDir: true,
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
    sourcemap: false,
  },
})
