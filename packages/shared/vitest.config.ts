// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The schema analyser's memory bound is checked after a real garbage collection.
    execArgv: ['--expose-gc'],
    coverage: {
      // Spec §9 targets; measured on the package's own source only.
      provider: 'v8',
      include: ['src/**'],
      thresholds: { lines: 90, statements: 90, branches: 85, functions: 90 },
    },
  },
})
