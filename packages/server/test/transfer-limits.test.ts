// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config'
import { MiB, transferLimits } from '../src/transfer/limits'

describe('transfer limits (phase 3d-1 §7)', () => {
  it('has the spec defaults', () => {
    const l = transferLimits(resolveConfig({}))
    expect(l.maxUpload).toBe(1024 * MiB)
    expect(l.quota).toBe(5120 * MiB)
    expect(l.ttlMs).toBe(24 * 3600_000)
    expect(l.maxJobMs).toBe(6 * 3600_000)
    expect(l.total).toBe(51_200 * MiB)
    // Not set, it is never below one user's quota (review, minor 4).
    expect(transferLimits(resolveConfig({ env: { MM_TRANSFER_QUOTA: '102400' } })).total).toBe(102_400 * MiB)
  })

  it('reads the environment in MiB and hours, within range', () => {
    const c = resolveConfig({
      env: {
        MM_TRANSFER_MAX_UPLOAD: '16',
        MM_TRANSFER_QUOTA: '64',
        MM_TRANSFER_TOTAL_QUOTA: '256',
        MM_TRANSFER_TTL_HOURS: '2',
        MM_TRANSFER_MAX_JOB_HOURS: '1',
      },
    })
    expect(transferLimits(c)).toMatchObject({
      maxUpload: 16 * MiB,
      quota: 64 * MiB,
      total: 256 * MiB,
      ttlMs: 2 * 3600_000,
      maxJobMs: 3600_000,
    })
    expect(() => resolveConfig({ env: { MM_TRANSFER_MAX_UPLOAD: '0' } })).toThrow()
    expect(() => resolveConfig({ env: { MM_TRANSFER_TTL_HOURS: '721' } })).toThrow()
    expect(() => resolveConfig({ env: { MM_TRANSFER_QUOTA: 'lots' } })).toThrow()
    expect(() => resolveConfig({ env: { MM_TRANSFER_TOTAL_QUOTA: '8' } })).toThrow()
  })
})
