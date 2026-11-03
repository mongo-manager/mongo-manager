import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MongoClient } from 'mongodb'
import { ConnectionSettingsSchema } from '@mongo-manager/shared'
import { ConnectionManager } from '../src/connections/manager'
import { DRILL_STAGING, dropLeftoverStaging } from '../src/jobs/duplicate'
import { indexCreateKind } from '../src/jobs/index-create'
import { JobRepo } from '../src/jobs/repo'
import { KEEP_FINISHED_MS, MAX_ROWS } from '../src/jobs/runner'
import type { JobContext, JobRecord } from '../src/jobs/types'
import { makeApp, type TestApp } from './helpers'

const apps: TestApp[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const t of apps.splice(0)) await t.close()
})

const STAGING = 'mm_duplicate_0123456789abcdef'

async function withRepo() {
  const t = await makeApp()
  apps.push(t)
  const connectionId = t.app.ctx.connections.create(
    {
      name: 'M',
      favorite: false,
      readOnly: false,
      settings: ConnectionSettingsSchema.parse({ hosts: [{ host: '127.0.0.1' }] }),
    },
    null,
  ).id
  const repo = new JobRepo(t.app.ctx.store.db)
  const row = (over: Partial<JobRecord>): JobRecord => ({
    id: crypto.randomUUID(),
    kind: 'collection.duplicate',
    userId: null,
    connectionId,
    targetConnectionId: null,
    stagingConnectionId: null,
    stagingDb: null,
    db: 'shop',
    coll: 'orders',
    target: 'copy',
    state: 'done',
    progress: null,
    estimate: null,
    error: null,
    staging: null,
    startedAt: 1,
    finishedAt: 1,
    ...over,
  })
  return { t, repo, row, connectionId }
}

describe('final review 1h, minor findings', () => {
  it('never prunes a job that still names a staging collection to drop (Minor 1)', async () => {
    const { repo, row } = await withRepo()
    const kept = row({ state: 'interrupted', staging: STAGING })
    repo.insert(kept)
    for (let i = 0; i < MAX_ROWS + 3; i++) repo.insert(row({ finishedAt: 10 + i }))
    repo.prune(KEEP_FINISHED_MS * 10, MAX_ROWS)
    expect(repo.get(kept.id)?.staging).toBe(STAGING)
  })

  it('drops the staging of failed and cancelled copies too, killing their copy first, and logs failures (Minors 1, 2)', async () => {
    const { repo, row, connectionId } = await withRepo()
    const failed = row({ state: 'failed', staging: STAGING })
    const stuck = row({ state: 'cancelled', staging: 'mm_duplicate_fedcba9876543210' })
    const tampered = row({ state: 'failed', staging: 'orders' })
    for (const r of [failed, stuck, tampered]) repo.insert(r)
    const dropped: string[] = []
    const client = {
      db: () => ({
        collection: (name: string) => ({
          drop: async () => {
            if (name === stuck.staging) throw Object.assign(new Error('not authorized'), { code: 13 })
            dropped.push(name)
          },
        }),
      }),
    } as unknown as MongoClient
    const killed: string[] = []
    const warn = vi.fn()
    await dropLeftoverStaging(
      {
        withStaging: (id) => repo.withStaging(id),
        forgetStaging: (id) => repo.update({ ...repo.get(id)!, staging: null }),
      },
      connectionId,
      client,
      { kill: async (_c, comment) => (killed.push(comment), 0), warn },
    )
    expect(dropped).toEqual([STAGING])
    expect(killed.sort()).toEqual([`mm-job:${failed.id}`, `mm-job:${stuck.id}`].sort())
    expect(repo.get(failed.id)?.staging).toBeNull()
    expect(repo.get(stuck.id)?.staging).toBe(stuck.staging)
    expect(repo.get(tampered.id)?.staging).toBe('orders')
    expect(warn).toHaveBeenCalledWith({ job: stuck.id }, expect.stringMatching(/staging/))
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/mm_duplicate_|orders|shop/)
  })

  // Review of the open's stop (nit 7): stopped, the client is closed under it: no drop is tried,
  // and no failure it caused is logged as one to retry.
  it('drops nothing, and warns of nothing, once the open is stopped', async () => {
    const { repo, row, connectionId } = await withRepo()
    const a = row({ state: 'failed', staging: STAGING })
    const b = row({ state: 'failed', staging: 'mm_duplicate_fedcba9876543210' })
    for (const r of [a, b]) repo.insert(r)
    const stop = new AbortController()
    const tried: string[] = []
    const client = {
      db: () => ({
        collection: (name: string) => ({
          drop: async () => {
            tried.push(name)
            stop.abort()
            throw new Error('Client must be connected before running operations')
          },
        }),
      }),
    } as unknown as MongoClient
    const warn = vi.fn()
    await dropLeftoverStaging(
      {
        withStaging: (id) => repo.withStaging(id),
        forgetStaging: (id) => repo.update({ ...repo.get(id)!, staging: null }),
      },
      connectionId,
      client,
      { kill: async () => 0, warn, signal: stop.signal },
    )
    expect(tried).toHaveLength(1)
    expect(warn).not.toHaveBeenCalled()
    expect(repo.get(a.id)?.staging).toBe(STAGING)

    // Stopped after a drop that went through: that one is forgotten, and the next is not tried.
    const later = new AbortController()
    const went: string[] = []
    const closing = {
      db: () => ({
        collection: (name: string) => ({
          drop: async () => {
            went.push(name)
            later.abort()
          },
        }),
      }),
    } as unknown as MongoClient
    await dropLeftoverStaging(
      {
        withStaging: (id) => repo.withStaging(id),
        forgetStaging: (id) => repo.update({ ...repo.get(id)!, staging: null }),
      },
      connectionId,
      closing,
      { kill: async () => 0, warn, signal: later.signal },
    )
    expect(went).toHaveLength(1)
    expect([a, b].filter((r) => repo.get(r.id)?.staging === null)).toHaveLength(1)
  })

  // Third review of the open's stop (nit 5): stopped while its copy's operation was being killed,
  // nothing is sent after it, a collection's drop or a drill's scratch database's.
  it('sends no drop after a kill the stop came during', async () => {
    const { repo, row, connectionId } = await withRepo()
    repo.insert(row({ state: 'failed', staging: STAGING }))
    repo.insert(row({ state: 'failed', staging: DRILL_STAGING, stagingDb: 'mm_drill_0123456789ab' }))
    for (const kind of ['collection', 'drill']) {
      const stop = new AbortController()
      const sent: string[] = []
      let kills = 0
      const client = {
        db: () => ({
          dropDatabase: async () => void sent.push('dropDatabase'),
          collection: () => ({ drop: async () => void sent.push('drop') }),
        }),
      } as unknown as MongoClient
      await dropLeftoverStaging(
        {
          withStaging: (id) =>
            repo.withStaging(id).filter((j) => (j.staging === DRILL_STAGING) === (kind === 'drill')),
          forgetStaging: () => undefined,
        },
        connectionId,
        client,
        {
          kill: async () => {
            kills++
            stop.abort()
            return 0
          },
          warn: vi.fn(),
          signal: stop.signal,
        },
      )
      // Fourth review (nit 5): its job reached the kill, so what follows it was tested.
      expect(kills, kind).toBe(1)
      expect(sent, kind).toEqual([])
    }
  })

  it('asks MongoDB for a build’s progress once at a time, however slow it answers (Minor 3)', async () => {
    let calls = 0
    let answer!: () => void
    const client = {
      db: () => ({
        aggregate: () => ({
          toArray: () => {
            calls++
            return new Promise((resolve) => (answer = () => resolve([])))
          },
        }),
        collection: () => ({ createIndex: () => new Promise(() => undefined) }),
      }),
    } as unknown as MongoClient
    const kind = indexCreateKind({ client: async () => client, pollMs: 10 })
    const ctx = {
      id: 'j',
      comment: 'mm-job:j',
      signal: new AbortController().signal,
      target: { userId: null, connectionId: 'c', db: 'd', coll: 'c', target: 'n_1' },
      progress: () => undefined,
      setStaging: () => undefined,
      setEstimate: () => undefined,
      setParts: () => undefined,
    } satisfies JobContext
    void kind.run(ctx, { key: { n: 1 }, options: {} })
    await new Promise((r) => setTimeout(r, 120))
    expect(calls).toBe(1)
    answer()
    await new Promise((r) => setTimeout(r, 40))
    expect(calls).toBe(2)
  })

  it('refuses to open a client once the manager is closed (Minor 3)', async () => {
    const manager = new ConnectionManager({
      load: () => ({ settings: ConnectionSettingsSchema.parse({ hosts: [{ host: '127.0.0.1', port: 1 }] }) }),
    })
    await manager.closeAll()
    await expect(manager.getClient('c1')).rejects.toThrow(/shutting down/)
  })
})
