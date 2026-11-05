// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { defineConfig, devices } from '@playwright/test'

export const PORT = Number(process.env.MM_E2E_PORT ?? 43219)
/** A second server in local mode (no accounts), for tests/local. */
export const LOCAL_PORT = PORT + 1

export default defineConfig({
  testDir: './tests',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  globalSetup: './global-setup.ts',
  use: {
    baseURL: `http://localhost:${PORT}`,
    locale: 'en-US',
    trace: 'retain-on-failure',
  },
  // The installed Chrome: nothing is downloaded, so this runs in closed networks too.
  projects: [
    {
      name: 'chrome',
      testIgnore: /[\\/]local[\\/]/,
      use: { ...devices['Desktop Chrome'], channel: process.env.MM_E2E_CHANNEL ?? 'chrome' },
    },
    {
      name: 'local',
      testMatch: /[\\/]local[\\/].*\.spec\.ts$/,
      use: {
        ...devices['Desktop Chrome'],
        channel: process.env.MM_E2E_CHANNEL ?? 'chrome',
        baseURL: `http://localhost:${LOCAL_PORT}`,
      },
    },
  ],
})
