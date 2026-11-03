import { afterEach, describe, expect, it } from 'vitest'
import { Timestamp } from 'mongodb'
import { makeApp, type TestApp } from './helpers'
import { LiveSyncRepo, tsCompare, tsFrom, tsText, type NewLiveSync } from '../src/livesync/repo'
import { resolveConfig } from '../src/config'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore } from '../src/store/db'
import { createSecretBox, loadOrCreateKey } from '../src/crypto/secret-box'
import { rotateSecretKey } from '../src/crypto/rotate'
import { AiProviderRepo } from '../src/ai/providers'

const apps: TestApp[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})

const input = (over: Partial<NewLiveSync> = {}): NewLiveSync => ({
  owner: 'u1',
  name: 'shop.orders ⇄ shop.orders',
  source: { connectionId: 'a', db: 'shop', coll: 'orders', collections: null },
  target: { connectionId: 'b', db: 'shop', coll: 'orders' },
  options: {
    startMode: 'copy',
    errorPolicy: 'pause',
    followNew: true,
    anonymous: false,
    masked: false,
    pairs: [['orders', 'orders']],
  },
  stamps: {
    versions: { source: 1, target: 1 },
    settings: { source: 'h1', target: 'h2' },
    deployments: {
      source: { kind: 'replicaSet' as const, setName: 'a', hosts: ['a:1'] },
      target: { kind: 'replicaSet' as const, setName: 'b', hosts: ['b:1'] },
    },
  },
  state: 'copying',
  startAt: tsText(new Timestamp({ t: 100, i: 2 })),
  copyJobId: 'job-1',
  ...over,
})

async function repo() {
  const t = await makeApp()
  apps.push(t)
  return { t, repo: t.app.ctx.liveSync.repo, db: t.app.ctx.store.db }
}

describe('the lag history (W4.6)', () => {
  it('keeps the largest lag of each 10 s, a day back at most, and goes with its sync', async () => {
    const { repo: r, db } = await repo()
    const s = r.create(input())
    const day = 24 * 3600_000
    const t0 = Date.UTC(2026, 9, 16, 12)
    r.sampleLag(s.id, t0 + 1_000, 300)
    r.sampleLag(s.id, t0 + 4_000, 900)
    r.sampleLag(s.id, t0 + 9_000, 100)
    r.sampleLag(s.id, t0 + 12_000, 50)
    expect(r.lagHistory(s.id, t0)).toEqual([
      { at: t0, lag: 900 },
      { at: t0 + 10_000, lag: 50 },
    ])
    // A day later the old samples are gone: a day of 10 s buckets at most.
    r.sampleLag(s.id, t0 + day + 20_000, 7)
    expect(r.lagHistory(s.id, 0)).toEqual([{ at: t0 + day + 20_000, lag: 7 }])
    const count = () =>
      (db.prepare('SELECT COUNT(*) AS n FROM live_sync_lag WHERE sync_id = ?').get(s.id) as { n: number }).n
    expect(count()).toBe(1)
    r.remove(s.id)
    expect(count()).toBe(0)
  })

  it('merges a long history into at most the points asked for, keeping each span’s largest lag', async () => {
    const { repo: r } = await repo()
    const s = r.create(input())
    const t0 = Date.UTC(2026, 9, 16, 12)
    for (let i = 0; i < 100; i++) r.sampleLag(s.id, t0 + i * 10_000, i === 37 ? 5000 : 10)
    const merged = r.lagHistory(s.id, t0, 10)
    expect(merged.length).toBeLessThanOrEqual(10)
    expect(Math.max(...merged.map((p) => p.lag))).toBe(5000)
  })
})

describe('cluster times as text (phase 3e-2)', () => {
  it('round-trips and orders them', () => {
    const a = tsText(new Timestamp({ t: 100, i: 2 }))
    expect(a).toBe('100.2')
    expect(tsFrom(a).equals(new Timestamp({ t: 100, i: 2 }))).toBe(true)
    expect(tsCompare('100.2', '100.10')).toBeLessThan(0)
    expect(tsCompare('101.0', '100.10')).toBeGreaterThan(0)
    expect(tsCompare('100.2', '100.2')).toBe(0)
  })
})

describe('the live sync store (phase 3e-2 spec §2.2)', () => {
  it('keeps a sync and lists it for its owner, and all for an administrator', async () => {
    const { repo: r } = await repo()
    const a = r.create(input())
    r.create(input({ owner: 'u2' }))
    expect(r.get(a.id)).toMatchObject({
      owner: 'u1',
      state: 'copying',
      startAt: '100.2',
      copyJobId: 'job-1',
      copiedAt: null,
    })
    expect(r.update(a.id, { copiedAt: 5 }).copiedAt).toBe(5)
    expect(r.list('u1').map((s) => s.id)).toEqual([a.id])
    expect(r.list()).toHaveLength(2)
    expect(r.countActive('u1')).toBe(1)
    expect(r.countActive()).toBe(2)
  })

  it('seals the place: the stored row never holds the resume token', async () => {
    const { repo: r, db } = await repo()
    const s = r.create(input())
    r.savePlace(
      s.id,
      { token: { _data: '82secret' }, time: '120.1' },
      {
        inserted: 3,
        replaced: 0,
        deleted: 1,
        skipped: 0,
        batches: 2,
        lastEventAt: 5,
        lagMs: 0,
        caughtUpAt: null,
      },
    )
    const raw = db.prepare('SELECT * FROM live_syncs WHERE id = ?').get(s.id) as Record<string, unknown>
    expect(JSON.stringify(raw)).not.toContain('82secret')
    expect(r.place(s.id)).toEqual({ token: { _data: '82secret' }, time: '120.1' })
    expect(r.get(s.id)).toMatchObject({
      placeTime: '120.1',
      counters: { inserted: 3, deleted: 1, batches: 2 },
    })
  })

  it('refuses to open a place sealed for another sync', async () => {
    const { repo: r, db } = await repo()
    const a = r.create(input())
    const b = r.create(input())
    r.savePlace(a.id, { token: { _data: 'x' }, time: '1.1' }, r.get(a.id)!.counters)
    const sealed = (db.prepare('SELECT place FROM live_syncs WHERE id = ?').get(a.id) as { place: string })
      .place
    db.prepare('UPDATE live_syncs SET place = ?, place_time = ? WHERE id = ?').run(sealed, '1.1', b.id)
    expect(() => r.place(b.id)).toThrow()
  })

  it('changes state with its reason, and counts only syncs that are not final', async () => {
    const { repo: r } = await repo()
    const s = r.create(input())
    expect(r.setState(s.id, 'attention', 'write_error', 'code 11000')).toMatchObject({
      state: 'attention',
      reason: 'write_error',
      detail: 'code 11000',
      finishedAt: null,
    })
    expect(r.countActive('u1')).toBe(1)
    expect(r.setState(s.id, 'stopped', 'owner')).toMatchObject({
      state: 'stopped',
      finishedAt: expect.any(Number),
    })
    expect(r.countActive('u1')).toBe(0)
    expect(r.listRunning()).toEqual([])
  })

  it('keeps the last 500 events of a sync, newest last', async () => {
    const { repo: r } = await repo()
    const s = r.create(input())
    for (let i = 0; i < 510; i++) r.log(s.id, { at: i, kind: 'batch', counts: { batches: i } })
    const events = r.events(s.id)
    expect(events).toHaveLength(500)
    expect(events[0]!.counts?.batches).toBe(10)
    expect(events.at(-1)!.counts?.batches).toBe(509)
    r.remove(s.id)
    expect(r.get(s.id)).toBeUndefined()
    expect(r.events(s.id)).toEqual([])
  })
})

describe('live sync settings (phase 3e-2 spec §2.4)', () => {
  it('reads MM_LIVE_SYNC and MM_LIVE_SYNC_MAX within bounds', () => {
    expect(resolveConfig({}).liveSync).toEqual({ enabled: true, maxSyncs: 10 })
    expect(resolveConfig({ env: { MM_LIVE_SYNC: '0', MM_LIVE_SYNC_MAX: '100' } }).liveSync).toEqual({
      enabled: false,
      maxSyncs: 100,
    })
    expect(() => resolveConfig({ env: { MM_LIVE_SYNC_MAX: '0' } })).toThrow()
    expect(() => resolveConfig({ env: { MM_LIVE_SYNC_MAX: '101' } })).toThrow()
  })
})

describe('live sync places and key rotation (phase 3e-2, S7)', () => {
  it('re-seals every place when the server key rotates', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-live-rotate-'))
    try {
      const store = await openStore(dir)
      const r = new LiveSyncRepo(store.db, createSecretBox(loadOrCreateKey({ dataDir: dir })), Date.now)
      const s = r.create(input())
      r.savePlace(s.id, { token: { _data: '82place' }, time: '7.1' }, s.counters)
      // Phase 4a-1: AI providers' keys are re-sealed too.
      const ai = new AiProviderRepo(
        store.db,
        createSecretBox(loadOrCreateKey({ dataDir: dir })),
        Date.now,
      ).create(
        {
          name: 'C',
          kind: 'anthropic',
          apiKey: 'k-rotated',
          maxTokens: 2048,
          enabled: true,
          isDefault: false,
        },
        null,
      )
      store.close()
      const result = await rotateSecretKey({ dataDir: dir })
      expect(result.liveSyncPlaces).toBe(1)
      expect(result.aiProviderKeys).toBe(1)
      const reopened = await openStore(dir)
      try {
        const box = createSecretBox(
          Buffer.from(readFileSync(join(dir, 'secret.key'), 'utf8').trim(), 'base64'),
        )
        expect(new LiveSyncRepo(reopened.db, box, Date.now).place(s.id)).toEqual({
          token: { _data: '82place' },
          time: '7.1',
        })
        expect(new AiProviderRepo(reopened.db, box, Date.now).key(ai.id)).toBe('k-rotated')
      } finally {
        reopened.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
