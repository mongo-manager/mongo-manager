// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it, vi } from 'vitest'
import {
  assertSafePath,
  buildManifest,
  formatOfKey,
  isSafeKey,
  manifestKeyOf,
  nameOfKey,
  parseManifest,
  probeKey,
  remoteKeyFor,
} from '../src/backup/destinations/layout'
import { MAX_RETRY_AFTER_MS, isRetryable, retryAfterMs, withRetry } from '../src/backup/destinations/retry'
import { DestinationSlots } from '../src/backup/destinations/slots'
import { DestinationError } from '../src/backup/destinations/types'
import { EgressError } from '../src/net/egress'

const ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const AT = Date.UTC(2026, 9, 3, 14, 30, 5)

describe('remote layout (phase 3d-3b spec §1.3, D11, D13, D14)', () => {
  it('names objects by date and id only', () => {
    expect(remoteKeyFor('prod/eu', 'mmbak', ID, AT)).toBe(
      'prod/eu/mongo-manager/2026/10/mm-20261003-143005-7c9e6679.mmbak',
    )
    expect(remoteKeyFor('', 'gzip', ID, AT)).toBe(
      'mongo-manager/2026/10/mm-20261003-143005-7c9e6679.archive.gz',
    )
    expect(manifestKeyOf('mongo-manager/2026/10/mm-20261003-143005-7c9e6679.archive')).toBe(
      'mongo-manager/2026/10/mm-20261003-143005-7c9e6679.archive.json',
    )
    expect(probeKey('p')).toMatch(/^p\/mongo-manager\/\.probe-[0-9a-f]{16}$/)
    expect(nameOfKey('p/mongo-manager/2026/10/mm-20261003-143005-7c9e6679.mmbak')).toBe(
      'mm-20261003-143005-7c9e6679.mmbak',
    )
  })

  it('accepts only keys of the layout under the prefix', () => {
    const k = 'prod/mongo-manager/2026/10/mm-20261003-143005-7c9e6679.mmbak'
    expect(isSafeKey(k, 'prod')).toBe(true)
    expect(formatOfKey(k)).toBe('mmbak')
    expect(formatOfKey('mongo-manager/2026/10/mm-20261003-143005-7c9e6679.archive.gz')).toBe('gzip')
    for (const bad of [
      'other/mongo-manager/2026/10/mm-20261003-143005-7c9e6679.mmbak',
      'prod/mongo-manager/2026/10/../../../etc/passwd',
      'prod/mongo-manager/2026/10/mm-20261003-143005-7c9e6679.mmbak.json',
      'prod/mongo-manager/2026/10/shop-orders.mmbak',
      '/prod/mongo-manager/2026/10/mm-20261003-143005-7c9e6679.mmbak',
      'prod\\mongo-manager\\2026\\10\\mm-20261003-143005-7c9e6679.mmbak',
    ])
      expect(isSafeKey(bad, 'prod'), bad).toBe(false)
    expect(() => assertSafePath('a/../b')).toThrow(DestinationError)
    expect(() => assertSafePath('a//b')).toThrow(DestinationError)
    expect(assertSafePath('a/b.c')).toEqual(['a', 'b.c'])
  })

  it('writes and reads manifests with no names in them, and refuses lies', () => {
    const buf = buildManifest({
      id: ID,
      format: 'mmbak',
      size: 123,
      sha256: 'a'.repeat(64),
      createdAt: AT,
      tool: { name: 'mongo-manager', version: '2.0.0' },
    })
    expect(buf.toString()).not.toMatch(/shop|orders|scope|db/)
    expect(parseManifest(buf)).toMatchObject({ v: 1, id: ID, size: 123 })
    expect(parseManifest(Buffer.from('{"v":1}'))).toBeNull()
    expect(parseManifest(Buffer.from('not json'))).toBeNull()
    expect(parseManifest(Buffer.alloc(70 * 1024, 32))).toBeNull()
    expect(parseManifest(Buffer.from(JSON.stringify({ ...JSON.parse(buf.toString()), size: -1 })))).toBeNull()
    expect(
      parseManifest(Buffer.from(JSON.stringify({ ...JSON.parse(buf.toString()), extra: 'x' }))),
    ).toBeNull()
    expect(parseManifest(null)).toBeNull()
  })
})

describe('retries (phase 3d-3b spec §2.1)', () => {
  it('retries network errors, 408, 429 and 5xx three times with growing delays', async () => {
    const waits: number[] = []
    const sleep = async (ms: number) => void waits.push(ms)
    let n = 0
    const out = await withRetry(
      async () => {
        if (n++ < 3) throw new DestinationError('provider', 'busy', { status: 503 })
        return 'ok'
      },
      { signal: new AbortController().signal, sleep },
    )
    expect(out).toBe('ok')
    expect(waits).toEqual([1000, 4000, 16000])
    expect(isRetryable(new EgressError('network', 'x'))).toBe(true)
    expect(isRetryable(new EgressError('address_refused', 'x'))).toBe(false)
    expect(isRetryable(new DestinationError('auth', 'x', { status: 403 }))).toBe(false)
    expect(isRetryable(new DestinationError('provider', 'x', { status: 429 }))).toBe(true)
  })

  it('gives up after three retries and never retries a 4xx', async () => {
    const sleep = vi.fn(async () => undefined)
    await expect(
      withRetry(async () => Promise.reject(new DestinationError('provider', 'down', { status: 500 })), {
        signal: new AbortController().signal,
        sleep,
      }),
    ).rejects.toThrow('down')
    expect(sleep).toHaveBeenCalledTimes(3)
    sleep.mockClear()
    await expect(
      withRetry(async () => Promise.reject(new DestinationError('not_found', 'gone', { status: 404 })), {
        signal: new AbortController().signal,
        sleep,
      }),
    ).rejects.toThrow('gone')
    expect(sleep).not.toHaveBeenCalled()
  })

  // Phase 3d-3b UI review: someone waiting on a listing or a test is not kept for 21 s of retries.
  it('does not retry when asked not to (interactive calls)', async () => {
    const sleep = vi.fn(async () => undefined)
    let calls = 0
    await expect(
      withRetry(
        async () => {
          calls++
          return Promise.reject(new DestinationError('connect', 'refused'))
        },
        { signal: new AbortController().signal, sleep, retries: 0 },
      ),
    ).rejects.toThrow('refused')
    expect([calls, sleep.mock.calls.length]).toEqual([1, 0])
  })

  it('caps Retry-After', async () => {
    expect(retryAfterMs('5', 0)).toBe(5000)
    expect(retryAfterMs('3600', 0)).toBe(MAX_RETRY_AFTER_MS)
    expect(retryAfterMs(new Date(30_000).toUTCString(), 0)).toBe(30_000)
    expect(retryAfterMs('soon', 0)).toBeUndefined()
    const waits: number[] = []
    let n = 0
    await withRetry(
      async () => {
        if (n++ === 0)
          throw new DestinationError('provider', 'slow down', { status: 429, retryAfterMs: 999_999 })
        return 1
      },
      { signal: new AbortController().signal, sleep: async (ms) => void waits.push(ms) },
    )
    expect(waits).toEqual([MAX_RETRY_AFTER_MS])
  })
})

describe('transfer slots (phase 3d-3b spec §3)', () => {
  it('lets two transfers run per destination and queues the rest', async () => {
    const slots = new DestinationSlots(2)
    const signal = new AbortController().signal
    const a = await slots.acquire('d1', signal)
    const b = await slots.acquire('d1', signal)
    let waited = false
    const c = slots.acquire('d1', signal, () => (waited = true))
    const other = await slots.acquire('d2', signal)
    expect(waited).toBe(true)
    expect(slots.inUse('d1')).toBe(2)
    a()
    const release = await c
    expect(slots.inUse('d1')).toBe(2)
    a() // a second call does nothing
    b()
    release()
    other()
    expect(slots.inUse('d1')).toBe(0)
  })

  it('stops waiting when the job is cancelled', async () => {
    const slots = new DestinationSlots(1)
    const hold = await slots.acquire('d', new AbortController().signal)
    const ctl = new AbortController()
    const waiting = slots.acquire('d', ctl.signal)
    ctl.abort()
    await expect(waiting).rejects.toThrow()
    hold()
    expect(slots.inUse('d')).toBe(0)
  })
})
