// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // CI 2026-11-05: a test of the default 5 s ran out of time on a runner busy with every package's
  // tests at once; the web app's time.
  test: { testTimeout: 15_000 },
})
