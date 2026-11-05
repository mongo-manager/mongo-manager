// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/bundle/**', 'test/sea/**'],
    testTimeout: 30_000,
    coverage: {
      // Spec §9 targets; measured on the package's own source only.
      provider: 'v8',
      include: ['src/**'],
      thresholds: { lines: 85, statements: 80, branches: 75, functions: 75 },
    },
  },
})
