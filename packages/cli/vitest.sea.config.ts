// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['test/sea/**/*.test.ts'], testTimeout: 120_000, hookTimeout: 120_000 },
})
