// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { defineConfig } from 'vitest/config'
import { thirdPartyList } from '../../../scripts/third-party.mjs'

/**
 * Research 2026-10-28: built into packages/plugins/dist/date-presets, the folder the server finds
 * bundled plugins in. Relative paths (served under its ticket), no inline script (the frame's policy
 * allows its own files only), assets as files.
 */
export default defineConfig({
  base: './',
  // The packages this build is made of, for the release's notices (review 2026-10-13).
  plugins: [thirdPartyList()],
  // CI 2026-11-05: a test of the default 5 s ran out of time on a runner busy with every package's
  // tests at once; the web app's time.
  test: { testTimeout: 15_000 },
  build: {
    outDir: '../dist/date-presets',
    emptyOutDir: true,
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
    sourcemap: false,
  },
})
