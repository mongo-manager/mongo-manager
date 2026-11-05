// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { defineConfig } from 'vitest/config'
import { slowness } from './test/support/slowness'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/support/global-setup.ts'],
    // CI 2026-10-18: every test server runs wiredTiger, whatever its version; CI 2026-10-21: and
    // starts again on another port when its own was taken (test-servers.ts).
    // CI 2026-10-21: every test's job waits fit in its limit (wait-budget.ts).
    setupFiles: ['test/support/test-servers.ts', 'test/support/wait-limits.ts'],
    // Each test file in a process of its own (vitest's defaults, named): a server a failed start left
    // running ends with it (mongodb-memory-server's killer), so no file has to stop what its
    // beforeAll started before failing (review of the port retry, minor 6).
    pool: 'forks',
    isolate: true,
    // CI 2026-10-22: longer on a slow runner (Windows in CI; test/support/slowness.ts).
    testTimeout: 20_000 * slowness(),
    hookTimeout: 120_000 * slowness(),
    coverage: {
      // Spec §9 targets; measured on the package's own source only.
      provider: 'v8',
      include: ['src/**'],
      // The shell worker runs in a spawned child process, so the parent's v8 coverage cannot
      // instrument it. It is exercised end to end instead — a real worker in shell-manager-e2e
      // (open, query, read-only refusal) and the SEA self-check in the CLI's sea test — and its
      // one generated file (the contextless mongosh eval) is build output. Measuring it here would
      // report 0% for code that is in fact run, not skipped.
      exclude: ['src/shell/worker/**'],
      thresholds: { lines: 90, statements: 90, branches: 85, functions: 90 },
    },
  },
})
