// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readBusy, sameHosts } from '../src/ai/agent/execute'
import type { RouteAnswer } from '../src/ai/agent/calls'

/** Fifth review of B2 (M-4, M-5): the same server told before the plan, and a busy read waited for. */
type Settings = {
  scheme: 'mongodb' | 'mongodb+srv'
  hosts: Array<{ host: string; port?: number }>
  ssh?: { enabled: boolean; host: string; port: number }
}
const conn = (settings: Settings) => ({ record: { settings } }) as unknown as Parameters<typeof sameHosts>[0]
const seeds = (...hosts: string[]) =>
  conn({
    scheme: 'mongodb',
    hosts: hosts.map((h) => {
      const [host, port] = h.split(':')
      return { host: host!, ...(port ? { port: Number(port) } : {}) }
    }),
  })

describe('sameHosts', () => {
  it('takes two seed lists sharing a host for one server, its case and default port aside', () => {
    expect(sameHosts(seeds('a.example:27017', 'b.example:27017'), seeds('B.EXAMPLE', 'c.example'))).toBe(true)
    expect(sameHosts(seeds('a.example:27018'), seeds('a.example'))).toBe(false)
  })

  it('never takes an SRV name for its seeds, nor two tunnels for one', () => {
    const srv = conn({ scheme: 'mongodb+srv', hosts: [{ host: 'x.example' }] })
    expect(sameHosts(srv, seeds('x.example:27017'))).toBe(false)
    const tunnel = (bastion: string) =>
      conn({
        scheme: 'mongodb',
        hosts: [{ host: 'localhost', port: 27017 }],
        ssh: { enabled: true, host: bastion, port: 22 },
      })
    expect(sameHosts(tunnel('one.example'), tunnel('two.example'))).toBe(false)
    expect(sameHosts(tunnel('one.example'), tunnel('ONE.example'))).toBe(true)
    expect(sameHosts(tunnel('one.example'), seeds('localhost:27017'))).toBe(false)
  })
})

describe('readBusy', () => {
  afterEach(() => vi.useRealTimers())
  const answer = (status: number, body: unknown = {}): RouteAnswer => ({ status, body }) as RouteAnswer

  it('asks a read the person’s slots refused once more, after the wait it was told', async () => {
    vi.useFakeTimers()
    const call = vi
      .fn<() => Promise<RouteAnswer>>()
      .mockResolvedValueOnce(answer(429, { details: { retryAfterMs: 500, reason: 'reads_busy' } }))
      .mockResolvedValueOnce(answer(200, { count: 3 }))
    const read = readBusy(call)
    await vi.advanceTimersByTimeAsync(499)
    expect(call).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(await read).toMatchObject({ status: 200 })
    expect(call).toHaveBeenCalledTimes(2)
  })

  it('waits no more than two seconds, and asks only once more', async () => {
    vi.useFakeTimers()
    const call = vi
      .fn<() => Promise<RouteAnswer>>()
      .mockResolvedValue(answer(429, { details: { retryAfterMs: 60_000 } }))
    const read = readBusy(call)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(await read).toMatchObject({ status: 429 })
    expect(call).toHaveBeenCalledTimes(2)
  })

  it('asks a read that went through once', async () => {
    const call = vi.fn<() => Promise<RouteAnswer>>().mockResolvedValue(answer(200))
    expect(await readBusy(call)).toMatchObject({ status: 200 })
    expect(call).toHaveBeenCalledTimes(1)
  })
})
