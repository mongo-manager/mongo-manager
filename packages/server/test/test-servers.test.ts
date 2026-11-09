// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it, vi } from 'vitest'
import { createServer, type AddressInfo } from 'node:net'
import { MongoClient } from 'mongodb'
import { MongoMemoryReplSet, MongoMemoryServer } from 'mongodb-memory-server'
import { startMongo } from './support/mongo'
import { portTaken } from './support/port-retry'
import { LAUNCH_MS, SERVER_START_MS, SET_START_MS } from './support/slowness'

/**
 * CI 2026-10-18: mongodb-memory-server starts MongoDB before 7.0 on its ephemeralForTest engine,
 * which no deployment runs. 6.0 on it fell over at the first write to a replica set (every change
 * stream test timed out) and said nothing of its disk space (every drill refused). Every server the
 * tests start runs wiredTiger, as a real one does, whatever the version (MONGOMS_VERSION).
 */
const engineOf = async (uri: string) => {
  const c = await new MongoClient(uri, { directConnection: true }).connect()
  try {
    return (await c.db('admin').command({ serverStatus: 1 })).storageEngine.name as string
  } finally {
    await c.close()
  }
}

/**
 * Starts servers together, so they take one slow start's time, not the sum of theirs
 * (start-budget.test.ts; review of the Windows hardening, third round, B); those that started are
 * stopped when one did not.
 */
async function together<T extends readonly Promise<{ stop(): Promise<unknown> }>[]>(
  starts: T,
): Promise<{ -readonly [K in keyof T]: Awaited<T[K]> }> {
  const settled = await Promise.allSettled(starts)
  const failed = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected')
  if (failed) {
    // Every stop is waited for, and one that fails does not hide the start's failure (fourth
    // round, Minor 3; fifth, nit 6).
    await Promise.allSettled(settled.map((r) => (r.status === 'fulfilled' ? r.value.stop() : undefined)))
    throw failed.reason
  }
  return settled.map((r) => (r as PromiseFulfilledResult<unknown>).value) as never
}

describe('the MongoDB servers the tests start', () => {
  it('stops the servers that started together when another did not', async () => {
    let stopped = 0
    // Stopped a moment later: what is said comes once every stop is done.
    const up = { stop: () => new Promise<void>((done) => setTimeout(() => done(void stopped++), 20)) }
    await expect(
      together([Promise.resolve(up), Promise.reject(new Error('no start'))] as const),
    ).rejects.toThrow('no start')
    expect(stopped).toBe(1)
    // A stop that fails too does not hide why the start did.
    const stuck = { stop: async () => Promise.reject(new Error('folder held')) }
    await expect(
      together([Promise.resolve(stuck), Promise.resolve(up), Promise.reject(new Error('no start'))] as const),
    ).rejects.toThrow('no start')
    expect(stopped).toBe(2)
  })

  // CI 2026-10-22 (Windows): a runner starting several servers at once took more than the library's
  // 10 s; every server, a set's members too, is given LAUNCH_MS, unless the test names its own (a
  // named member beside one named nothing for: review of the Windows hardening, M3).
  it('wait LAUNCH_MS for each server to start, alone and every member of a set', async () => {
    // What the library reads when it starts a member's mongod.
    const timeOf = (s: MongoMemoryServer) => s.instanceInfo?.instance.instanceOpts.launchTimeout
    const [one, own, unset, set] = await together([
      MongoMemoryServer.create(),
      MongoMemoryServer.create({ instance: { launchTimeout: 45_000 } }),
      MongoMemoryServer.create({ instance: { launchTimeout: undefined } }),
      MongoMemoryReplSet.create({ replSet: { count: 2 }, instanceOpts: [{ launchTimeout: 45_000 }] }),
    ] as const)
    try {
      expect([one, own, unset].map(timeOf)).toEqual([LAUNCH_MS, 45_000, LAUNCH_MS])
      expect(set.servers.map(timeOf)).toEqual([45_000, LAUNCH_MS])
    } finally {
      await Promise.all([one, own, unset, set].map((s) => s.stop()))
    }
  }, 180_000)

  it(
    'run wiredTiger, alone and in a replica set',
    async () => {
      const [one, set, helper] = await together([
        MongoMemoryServer.create(),
        MongoMemoryReplSet.create({ replSet: { count: 1 } }),
        startMongo(),
      ] as const)
      try {
        expect(await engineOf(one.getUri())).toBe('wiredTiger')
        expect(await engineOf(set.servers[0]!.getUri())).toBe('wiredTiger')
        expect(await engineOf(`mongodb://${helper.host}:${helper.port}`)).toBe('wiredTiger')
      } finally {
        await Promise.all([one.stop(), set.stop(), helper.stop()])
      }
    },
    SET_START_MS,
  )
})

/**
 * Review of the port retry (important 1, minors 4, 5): the setup file's own create, against a port
 * really held by another process, as CI's was. The first server (a set's first member) is given the
 * held port; mongod refuses it (on Windows in the system's own words, exit 48), and the next try
 * starts on a free one, on wiredTiger still, leaving no server of the first try running. The
 * library's "Starting the MongoMemoryServer Instance failed" and the retry's warning in its output
 * are those first tries, as they should be (second review, nit 6).
 */
describe('a test MongoDB server whose port another process holds', () => {
  const holding = async () => {
    const holder = createServer()
    await new Promise<void>((done) => holder.listen(0, '127.0.0.1', done))
    return { holder, port: (holder.address() as AddressInfo).port }
  }
  /**
   * Gives the held port to the first server that asks, and keeps every server made, with the mongod
   * process of each that came to run.
   */
  const handOut = (port: number) => {
    const made: MongoMemoryServer[] = []
    const pids = new Map<MongoMemoryServer, number>()
    // Where the library picks a server's port (protected in its types).
    const picks = MongoMemoryServer.prototype as unknown as { getNewPort(port?: number): Promise<number> }
    const original = picks.getNewPort
    let given = false
    const patch = vi.spyOn(picks, 'getNewPort').mockImplementation(async function (
      this: MongoMemoryServer,
      wanted?: number,
    ) {
      if (!made.includes(this)) {
        made.push(this)
        // The library's own event and state names (its enums are not exported).
        ;(this as unknown as NodeJS.EventEmitter).on('stateChange', (state: string) => {
          const pid = this.instanceInfo?.instance.mongodProcess?.pid
          if (state === 'running' && pid) pids.set(this, pid)
        })
      }
      if (given) return original.call(this, wanted)
      given = true
      return port
    })
    return { made, pids, restore: () => patch.mockRestore() }
  }
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  it('starts on another port, on wiredTiger', async () => {
    const { holder, port } = await holding()
    const { made, restore } = handOut(port)
    try {
      const one = await MongoMemoryServer.create()
      try {
        expect(made.length).toBeGreaterThanOrEqual(2)
        expect(one.instanceInfo!.port).not.toBe(port)
        expect(await engineOf(one.getUri())).toBe('wiredTiger')
        expect(made[0]!.state).not.toBe('running')
      } finally {
        await one.stop()
      }
    } finally {
      restore()
      holder.close()
    }
  }, 120_000)

  // Second review of the port retry (nit 4): held to one port, it fails at once.
  it(
    'fails at once where the test holds it to the port that is taken',
    async () => {
      const { holder, port } = await holding()
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      try {
        await expect(
          MongoMemoryServer.create({ instance: { port, portGeneration: false } }),
        ).rejects.toSatisfy(portTaken)
        expect(warn.mock.calls.flat().join('\n')).not.toMatch(/starting again/)
      } finally {
        warn.mockRestore()
        holder.close()
      }
    },
    SERVER_START_MS,
  )

  it('starts a replica set again, leaving none of the first set’s members running', async () => {
    const { holder, port } = await holding()
    const { made, pids, restore } = handOut(port)
    try {
      const set = await MongoMemoryReplSet.create({ replSet: { count: 2 } })
      try {
        const now = new Set(set.servers)
        const first = made.filter((m) => !now.has(m))
        expect(first.length).toBeGreaterThanOrEqual(2)
        // The first set's other member came to run, and its mongod is gone.
        const ran = first.filter((m) => pids.has(m))
        expect(ran.length).toBeGreaterThanOrEqual(1)
        for (const m of ran) expect(alive(pids.get(m)!), `mongod ${pids.get(m)}`).toBe(false)
        expect(set.servers.map((s) => s.instanceInfo!.port)).not.toContain(port)
        expect(await engineOf(set.servers[0]!.getUri())).toBe('wiredTiger')
      } finally {
        await set.stop()
      }
    } finally {
      restore()
      holder.close()
    }
  }, 180_000)
})
