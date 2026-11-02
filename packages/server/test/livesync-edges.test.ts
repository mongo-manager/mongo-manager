import { afterEach, describe, expect, it } from 'vitest'
import type { MongoClient } from 'mongodb'
import { ConnectionSettingsSchema } from '@mongo-manager/shared'
import { makeApp, type TestApp } from './helpers'
import { checkSync, errorTextFor } from '../src/livesync/checks'
import { driverWrapped } from './support/driver-wrap'
import { verifySync } from '../src/livesync/verify'
import { deploymentOf } from '../src/transfer/same-deployment'
import type { LiveSyncRecord, NewLiveSync } from '../src/livesync/repo'

const apps: TestApp[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})

/** An app in team mode with two connections nothing connects to, and an editor who owns syncs. */
async function setup(config: object = {}) {
  const t = await makeApp({ auth: true, ...config })
  apps.push(t)
  const { ctx } = t.app
  const conn = (name: string, readOnly = false) =>
    ctx.connections.create(
      {
        name,
        favorite: false,
        readOnly,
        settings: ConnectionSettingsSchema.parse({ hosts: [{ host: '127.0.0.1', port: 1 }] }),
      },
      null,
    )
  const a = conn('A')
  const b = conn('B')
  const owner = ctx.users.create({ username: 'owner', passwordHash: 'x', role: 'editor' })
  const sync = (over: Partial<NewLiveSync> = {}): LiveSyncRecord =>
    ctx.liveSync.repo.create({
      owner: owner.id,
      name: 'shop.orders → shop.orders',
      source: { connectionId: a.id, db: 'shop', coll: 'orders', collections: null },
      target: { connectionId: b.id, db: 'shop', coll: 'orders' },
      options: {
        startMode: 'copy',
        errorPolicy: 'pause',
        followNew: false,
        anonymous: false,
        masked: false,
        pairs: [['orders', 'orders']],
      },
      stamps: {
        versions: {
          source: ctx.personalFields.get(a.id).version,
          target: ctx.personalFields.get(b.id).version,
        },
        settings: { source: '', target: '' },
        deployments: {
          source: { kind: 'replicaSet' as const, setName: 'a', hosts: ['a:1'] },
          target: { kind: 'replicaSet' as const, setName: 'b', hosts: ['b:1'] },
        },
      },
      state: 'paused',
      startAt: '100.1',
      copyJobId: null,
      ...over,
    })
  return { t, ctx, a, b, owner, sync }
}

const reason = (fn: () => unknown) => {
  try {
    fn()
  } catch (e) {
    return (e as { details?: { reason?: string } }).details?.reason
  }
  return undefined
}
const reasonAsync = async (fn: () => Promise<unknown>) => {
  try {
    await fn()
  } catch (e) {
    return (e as { details?: { reason?: string } }).details?.reason
  }
  return undefined
}

describe('the checks before every batch (phase 3e-2 spec §3.1)', () => {
  it('stops a sync whose connection is gone, and waits for lost export, read-only and a new restriction', async () => {
    const s = await setup()
    const { settingsStamp } = await import('../src/livesync/plan')
    const stamped = (r: LiveSyncRecord) =>
      s.ctx.liveSync.repo.update(r.id, {
        stamps: {
          ...r.stamps,
          settings: {
            source: settingsStamp(s.ctx.connections.get(r.source.connectionId)!.settings),
            target: settingsStamp(s.ctx.connections.get(r.target.connectionId)!.settings),
          },
        },
      })
    const r = stamped(s.sync())
    expect(checkSync(s.ctx, r)).toMatchObject({ ok: true })
    // No export on the source (a viewer without the grant).
    s.ctx.grants.set(s.a.id, s.owner.id, 'viewer')
    expect(checkSync(s.ctx, r)).toMatchObject({ ok: false, reason: 'owner_access', detail: 'source' })
    s.ctx.grants.set(s.a.id, s.owner.id, null)
    // The owner restricted on the source of an unmasked sync.
    s.ctx.grants.set(s.a.id, s.owner.id, 'editor')
    s.ctx.grants.setMasked(s.a.id, s.owner.id, true)
    expect(checkSync(s.ctx, r)).toMatchObject({ ok: false, reason: 'owner_access', detail: 'masked' })
    s.ctx.grants.setMasked(s.a.id, s.owner.id, false)
    // A read-only target.
    s.ctx.connections.update(s.b.id, { readOnly: true })
    expect(checkSync(s.ctx, r)).toMatchObject({ ok: false, reason: 'read_only' })
    // A deleted connection.
    s.ctx.connections.delete(s.b.id)
    expect(checkSync(s.ctx, r)).toMatchObject({ ok: false, state: 'stopped', reason: 'connection_deleted' })
  })

  // W4 review (minor): a filtered sync's filter is judged again by the server's setting, before every
  // batch and at every start — turning server JavaScript off stops a filter that runs it.
  it('waits when its filter runs server JavaScript the server no longer allows', async () => {
    const s = await setup()
    const { settingsStamp } = await import('../src/livesync/plan')
    const base = s.sync()
    const r = s.ctx.liveSync.repo.update(base.id, {
      options: { ...base.options, filter: { $where: 'this.v > 1' } },
      stamps: {
        ...base.stamps,
        settings: {
          source: settingsStamp(s.a.settings),
          target: settingsStamp(s.b.settings),
        },
      },
    })
    s.ctx.config.allowServerJs = false
    expect(checkSync(s.ctx, r)).toMatchObject({ ok: false, state: 'attention', reason: 'filter_refused' })
    s.ctx.config.allowServerJs = true
    expect(checkSync(s.ctx, r)).toMatchObject({ ok: true })
    const plain = s.ctx.liveSync.repo.update(r.id, { options: { ...r.options, filter: { v: 1 } } })
    s.ctx.config.allowServerJs = false
    expect(checkSync(s.ctx, plain)).toMatchObject({ ok: true })
  })

  // Security audit 2026-10-16 (Important 4): a masked sync on a source with rules withholds GridFS
  // file contents from every batch; an unmasked one, or one with no rules, does not.
  it('withholds file contents from a masked sync when the source has rules', async () => {
    const s = await setup()
    const { settingsStamp } = await import('../src/livesync/plan')
    s.ctx.personalFields.set(s.a.id, [{ db: 'shop', coll: 'orders', field: 'email' }])
    const make = (masked: boolean, pairs: Array<[string, string]> = [['orders', 'orders']]) => {
      const r = s.sync({
        options: {
          startMode: 'copy',
          errorPolicy: 'pause',
          followNew: true,
          anonymous: masked,
          masked,
          pairs,
        },
      })
      return s.ctx.liveSync.repo.update(r.id, {
        stamps: {
          ...r.stamps,
          versions: {
            source: s.ctx.personalFields.get(s.a.id).version,
            target: s.ctx.personalFields.get(s.b.id).version,
          },
          settings: {
            source: settingsStamp(s.ctx.connections.get(s.a.id)!.settings),
            target: settingsStamp(s.ctx.connections.get(s.b.id)!.settings),
          },
        },
      })
    }
    // User report 2026-10-27: withheld where a rule reaches the bucket, not because rules exist.
    const withheld = (r: ReturnType<typeof make>, coll: string) => {
      const check = checkSync(s.ctx, r)
      if (!check.ok) throw new Error(`not ok: ${check.reason}`)
      return check.withholdFiles?.('shop', coll) ?? false
    }
    expect(withheld(make(true), 'fs.chunks')).toBe(false)
    s.ctx.personalFields.set(s.a.id, [
      { db: 'shop', coll: 'orders', field: 'email' },
      { db: 'shop', coll: 'fs.files', field: 'metadata.owner' },
    ])
    expect(withheld(make(true), 'fs.chunks')).toBe(true)
    expect(withheld(make(true), 'fs.files')).toBe(true)
    expect(withheld(make(true), 'photos.chunks')).toBe(false)
    expect(withheld(make(true), 'orders')).toBe(false)
    expect(withheld(make(false), 'fs.chunks')).toBe(false)
    // An owner restricted on the target where rules are elsewhere than the synced database: its
    // buckets hold no personal data there, so nothing is withheld for them (and where a rule reaches
    // the target database, the sync stops as personal_target first).
    s.ctx.grants.set(s.b.id, s.owner.id, 'editor')
    s.ctx.grants.setMasked(s.b.id, s.owner.id, true)
    s.ctx.personalFields.set(s.b.id, [{ db: 'other', coll: 'x', field: 'secret' }])
    expect(withheld(make(false), 'fs.chunks')).toBe(false)
    expect(checkSync(s.ctx, make(false, [['fs.files', 'fs.files']]))).toMatchObject({ ok: true })
    // A rule reaching every database reaches the target's buckets: the sync stops before any.
    s.ctx.personalFields.set(s.b.id, [{ db: '*', coll: '*', field: 'secret' }])
    expect(checkSync(s.ctx, make(false, [['fs.files', 'fs.files']]))).toMatchObject({
      ok: false,
      reason: 'owner_access',
      detail: 'personal_target',
    })
  })

  it('shows MongoDB’s words with the code to an owner who may see personal data', async () => {
    const s = await setup()
    const r = s.sync()
    expect(errorTextFor(s.ctx, r, 'target', { code: 11000, errmsg: 'E11000 duplicate key' })).toBe(
      'E11000 duplicate key (code 11000)',
    )
    expect(errorTextFor(s.ctx, r, 'target', { message: 'no code' })).toBe('no code')
    // The server's own words and code from under the driver's wrapper (independent review, Minor 5).
    expect(
      errorTextFor(
        s.ctx,
        r,
        'target',
        driverWrapped('Cannot perform a non-multi delete on a time-series collection'),
      ),
    ).toBe('Cannot perform a non-multi delete on a time-series collection (code 20)')
  })
})

describe('control refusals (phase 3e-2 spec §2.5)', () => {
  it('refuses actions the sync’s state does not allow', async () => {
    const s = await setup()
    const runner = s.ctx.liveSync
    const stopped = s.sync({ state: 'stopped' })
    const copying = s.sync({ state: 'copying', copyJobId: 'j' })
    const paused = s.sync()
    const live = s.sync({ state: 'live' })
    expect(await reasonAsync(() => runner.pause(stopped, 'owner', 'x'))).toBe('not_running')
    expect(await reasonAsync(() => runner.pause(copying, 'owner', 'x'))).toBe('copying')
    expect(await reasonAsync(() => runner.stop(stopped, 'owner'))).toBe('final')
    expect(
      await reasonAsync(() => runner.confirm(paused, { stamps: paused.stamps, options: paused.options })),
    ).toBe('not_resumable')
    expect(reason(() => runner.skip(paused))).toBe('nothing_to_skip')
    expect(reason(() => runner.remove(live))).toBe('running')
    expect(reason(() => runner.verify(copying))).toBe('not_ready')
    expect(await reasonAsync(() => runner.finish(paused, true))).toBe('not_live')
    expect(await reasonAsync(() => runner.applySchema(paused, true))).toBe('nothing_to_apply')
  })

  it('runs at most two verifications at once on the server', async () => {
    const s = await setup()
    const runner = s.ctx.liveSync
    const [x, y, z] = [s.sync(), s.sync(), s.sync()]
    runner.verify(x)
    expect(reason(() => runner.verify(x))).toBe('verify_running')
    runner.verify(y)
    expect(reason(() => runner.verify(z))).toBe('verify_busy')
  })

  it('applies new options only for an owner who still has the rights', async () => {
    const s = await setup()
    const r = s.sync({ state: 'attention' })
    const waiting = s.ctx.liveSync.repo.update(r.id, {
      skip: { id: '$schema', at: '100.2', armed: false, ns: 'orders' },
    })
    s.ctx.liveSync.repo.setState(r.id, 'attention', 'schema_changed', 'shop.orders')
    s.ctx.users.setDisabled(s.owner.id, true)
    const after = await s.ctx.liveSync.applySchema(
      { ...waiting, state: 'attention', reason: 'schema_changed' },
      false,
    )
    expect(after).toMatchObject({ state: 'attention', reason: 'owner_access' })
  })
})

describe('boot (phase 3e-2 plan rulings 1, 18)', () => {
  it('ends a verification a stop cut, and leaves syncs that are not running alone on a connection edit', async () => {
    const s = await setup()
    const r = s.sync()
    s.ctx.liveSync.repo.update(r.id, {
      verify: { state: 'running', startedAt: 1, finishedAt: null, pairs: [] },
    })
    s.ctx.liveSync.boot()
    expect(s.ctx.liveSync.repo.get(r.id)!.verify).toMatchObject({ state: 'failed', error: 'aborted' })
    await s.ctx.liveSync.connectionChanged(s.a.id)
    expect(s.ctx.liveSync.repo.get(r.id)!.state).toBe('paused')
  })
})

describe('verify without its connections (phase 3e-2 spec §1.5)', () => {
  it('fails with the reason the checks give, reading nothing', async () => {
    const s = await setup()
    const r = s.sync()
    s.ctx.connections.delete(s.b.id)
    const v = await verifySync(
      { ctx: s.ctx, settled: async () => true },
      r,
      new AbortController().signal,
      false,
    )
    expect(v).toMatchObject({ state: 'failed', error: 'connection_deleted', pairs: [] })
  })
})

describe('deployments (phase 3e-2 plan ruling 4)', () => {
  it('reads a sharded cluster’s id where it may', async () => {
    const fake = (clusterId: unknown) =>
      ({
        db: (name: string) => ({
          command: async () => ({ msg: 'isdbgrid' }),
          collection: () => ({
            findOne: async () => {
              if (name !== 'config') throw new Error('wrong db')
              if (clusterId instanceof Error) throw clusterId
              return { clusterId }
            },
          }),
        }),
      }) as unknown as MongoClient
    expect(await deploymentOf(fake('c1'))).toEqual({ kind: 'mongos', clusterId: 'c1' })
    expect(await deploymentOf(fake(new Error('not authorized')))).toEqual({ kind: 'mongos' })
  })
})
