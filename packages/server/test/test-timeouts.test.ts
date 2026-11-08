// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import config from '../vitest.config'
import { isCI, SLOW_RUNNER, slowness } from './support/slowness'

/**
 * CI 2026-10-22 (Windows): the runner took 24 s and 35 s over tests that take a few seconds
 * elsewhere, and failed them on the 20 s default. A test's default time, and a hook's, are
 * SLOW_RUNNER times as long on Windows in CI; elsewhere they are as written.
 */
describe('the time a test and a hook are given', () => {
  it('is longer on a Windows runner in CI only', () => {
    expect(slowness('win32', { CI: 'true' })).toBe(SLOW_RUNNER)
    expect(slowness('linux', { CI: 'true' })).toBe(1)
    expect(slowness('darwin', { CI: 'true' })).toBe(1)
    expect(slowness('win32', {})).toBe(1)
    expect(slowness('win32', { CI: '' })).toBe(1)
    // A CI variable that says no is not CI (review of the Windows hardening, N2).
    expect(slowness('win32', { CI: 'false' })).toBe(1)
    expect(slowness('win32', { CI: '0' })).toBe(1)
    expect(slowness('win32', { CI: '1' })).toBe(SLOW_RUNNER)
  })

  // Review of the Windows hardening (M4): the configuration gives a test with no time of its own
  // the default, scaled.
  it('gives a test with no time of its own the scaled default, and a hook', ({ task }) => {
    expect(task.timeout).toBe(20_000 * slowness())
    // Second round, nit 1.
    expect(config.test?.hookTimeout).toBe(120_000 * slowness())
  })

  // Second round, nit 7: one reading of CI for every test helper.
  it('reads CI one way everywhere', () => {
    expect(isCI({ CI: 'true' })).toBe(true)
    expect(isCI({ CI: '1' })).toBe(true)
    expect(isCI({ CI: 'false' })).toBe(false)
    expect(isCI({ CI: '0' })).toBe(false)
    expect(isCI({ CI: '' })).toBe(false)
    expect(isCI({})).toBe(false)
  })
})
