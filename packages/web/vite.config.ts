// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { xtermCsp } from './vite/xterm-csp'
import { thirdPartyList } from '../../scripts/third-party.mjs'

/**
 * W2 (2026-10-16): the Schema map's world outline, Natural Earth 1:110m land (v5.1.2), bundled as
 * data. It is in the public domain; the notices name it all the same, with its terms of use.
 */
const NATURAL_EARTH = {
  file: 'src/schema/geo/land-110m.json',
  entry: {
    name: 'Natural Earth 1:110m land',
    version: '5.1.2',
    license: 'Public Domain',
    texts: [
      'Made with Natural Earth. Free vector and raster map data @ naturalearthdata.com.\n\n' +
        'All versions of Natural Earth raster and vector map data found on naturalearthdata.com are in ' +
        'the public domain. You may use the maps in any manner, including modifying the content and ' +
        'design, electronic dissemination, and offset printing. (Natural Earth, Terms of Use.)\n\n' +
        'Mongo Manager ships the outer rings of ne_110m_land rounded to a tenth of a degree.',
    ],
  },
}

export default defineConfig({
  // Relative asset URLs + <base href> from the server make any basePath work (spec §3.2).
  base: './',
  // thirdPartyList: the packages this build is made of, for the release's notices (review 2026-10-13).
  plugins: [vue(), tailwindcss(), xtermCsp(), thirdPartyList(['tailwindcss'], [NATURAL_EARTH])],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  // A local-mode server's launch link works here too: open it with this port in place of its own.
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:4321' },
      '/launch/': { target: 'http://127.0.0.1:4321' },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    // No data: URIs: fonts and images stay same-origin files for a strict CSP (spec §5 S6).
    assetsInlineLimit: 0,
  },
})
