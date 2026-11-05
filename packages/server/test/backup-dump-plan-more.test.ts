// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AggregationCursor, MongoClient, UUID } from 'mongodb'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { startMongo, type TestMongo } from './support/mongo'
import { backupHarness } from './support/backup'
import { waitJob } from './support/jobs'
import { dumpToolArgs, toolsComplete } from '../src/backup/dump-plan'
import { slow } from './support/slowness'

const S = 'PL4NS3NT'
let a: TestMongo
let b: TestMongo
let ca: MongoClient
let base: string
beforeAll(async () => {
  ;[a, b] = await Promise.all([startMongo(), startMongo()])
  ca = await new MongoClient(`mongodb://127.0.0.1:${a.port}`).connect()
  base = mkdtempSync(join(tmpdir(), 'mm-dump-plan-more-'))
  mkdirSync(join(base, 'root'))
}, slow(180_000))
afterAll(async () => {
  await ca?.close()
  await Promise.all([a?.stop(), b?.stop()])
  if (base) rmSync(base, { recursive: true, force: true })
})
beforeEach(async () => {
  await ca.db('shop').dropDatabase()
  await ca.db('other').dropDatabase()
  const shop = ca.db('shop')
  await shop
    .collection('orders')
    .insertMany(Array.from({ length: 20 }, (_, i) => ({ email: `${S}-${i}@x`, n: i })))
  await shop.collection('items').insertMany([{ sku: 1 }, { sku: 2 }])
  await shop.createCollection('v', { viewOn: 'orders', pipeline: [{ $project: { n: 1 } }] })
  await ca.db('other').collection('x').insertOne({ a: 1 })
})

type H = Awaited<ReturnType<typeof backupHarness>>
type U = ReturnType<H['user']>
type Check = { key: string; level: string; params?: Record<string, unknown>; fix?: { kind: string } }
type Plan = {
  namespaces: Array<{
    db: string
    coll: string
    type: string
    documents: number | null
    bytes: number | null
    skipped?: string
  }>
  checks: Check[]
  refusals: string[]
  masked: boolean
  estimate: { bytes: number; fileBytes: number; seconds: number | null }
}
const planOf = (h: H, u: U, body: object, conn: 'A' | 'B' = 'A') =>
  u.call('POST', `/api/connections/${h.ids[conn]}/backup/plan`, body)
const destinationChecks = (p: Plan) => p.checks.filter((c) => c.key === 'destination')
const names = (p: Plan) => p.namespaces.map((n) => `${n.db}.${n.coll}`).sort()

async function harness() {
  const h = await backupHarness(a, b, { backup: { folderRoots: [join(base, 'root')] } } as never)
  const admin = h.user({ role: 'admin' })
  const destination = async (name: string, encryptedOnly: boolean) => {
    const res = await admin.call('POST', '/api/backup-destinations', {
      type: 'folder',
      name,
      config: { path: join(base, 'root', `${name}-${Math.random().toString(36).slice(2)}`) },
      policy: { encryptedOnly },
    })
    expect(res.statusCode, res.body).toBe(201)
    return res.json().id as string
  }
  return { h, admin, destination }
}

describe('dump plan destinations (phase 3d-3b V5)', () => {
  it('refuses a plain backup with personal fields to a destination that accepts plain backups', async () => {
    const { h, destination } = await harness()
    try {
      h.rules('A', [{ db: 'shop', coll: 'orders', field: 'email' }])
      const plainDest = await destination('Plain', false)
      const editor = h.user({ on: { A: 'editor' } })
      h.ctx.backup.destinations.setGrants(plainDest, [{ userId: editor.id, level: 'send' }])
      const scope = { kind: 'database', db: 'shop' }

      // The personal fields would leave in the clear: refused, with encrypting as the way out.
      const gz = (
        await planOf(h, editor, { scope, format: 'gzip', destinations: [plainDest] })
      ).json() as Plan
      expect(destinationChecks(gz)).toEqual([
        {
          key: 'destination',
          level: 'block',
          params: { name: 'Plain', reason: 'personal_plain' },
          fix: { kind: 'encrypt' },
        },
      ])
      expect(gz.refusals).toContain('destination_personal_plain')
      expect(gz.refusals).not.toContain('destination_unknown')
      // The same for the archive format: anything but mmbak is plain.
      const ar = (await planOf(h, editor, { scope, format: 'archive', destinations: [plainDest] })).json()
      expect(ar.refusals).toContain('destination_personal_plain')

      // Encrypted: accepted.
      const mm = (
        await planOf(h, editor, { scope, format: 'mmbak', destinations: [plainDest] })
      ).json() as Plan
      expect(destinationChecks(mm)).toEqual([{ key: 'destination', level: 'ok', params: { name: 'Plain' } }])
      expect(mm.refusals).toEqual([])

      // Anonymous: every personal field is masked, so a plain copy holds none of them.
      const anon = (
        await planOf(h, editor, { scope, format: 'gzip', anonymous: true, destinations: [plainDest] })
      ).json() as Plan
      expect(anon.masked).toBe(true)
      expect(destinationChecks(anon)).toEqual([
        { key: 'destination', level: 'ok', params: { name: 'Plain' } },
      ])
      expect(anon.refusals).toEqual([])
      expect(anon.checks.find((c) => c.key === 'personal')).toBeUndefined()

      // Nothing personal in the scope: a plain backup is fine.
      const other = (
        await planOf(h, editor, {
          scope: { kind: 'database', db: 'other' },
          format: 'gzip',
          destinations: [plainDest],
        })
      ).json() as Plan
      expect(destinationChecks(other)).toEqual([
        { key: 'destination', level: 'ok', params: { name: 'Plain' } },
      ])
      expect(other.refusals).toEqual([])
    } finally {
      await h.t.close()
    }
  })

  it('accepts a masked caller’s plain backup to a plain destination', async () => {
    const { h, destination } = await harness()
    try {
      h.rules('A', [{ db: 'shop', coll: 'orders', field: 'email' }])
      const plainDest = await destination('Plain', false)
      const masked = h.user({ masked: ['A'] })
      h.ctx.backup.destinations.setGrants(plainDest, [{ userId: masked.id, level: 'send' }])
      const p = (
        await planOf(h, masked, {
          scope: { kind: 'database', db: 'shop' },
          format: 'gzip',
          destinations: [plainDest],
        })
      ).json() as Plan
      expect(p.masked).toBe(true)
      expect(destinationChecks(p)).toEqual([{ key: 'destination', level: 'ok', params: { name: 'Plain' } }])
      expect(p.refusals).toEqual([])
      expect(JSON.stringify(p)).not.toContain(S)
    } finally {
      await h.t.close()
    }
  })

  // Security review 2026-10-13 round 2 (I4): a masked backup of a database with a GridFS bucket is
  // made — the bucket left out, saying why — rather than refused whole.
  // User report 2026-10-27: where a rule reaches the bucket; one on another collection leaves it in.
  it('leaves a GridFS bucket out of a masked backup where a rule reaches it, saying why', async () => {
    const { h } = await harness()
    try {
      await ca.db('shop').collection('fs.files').insertOne({ filename: 'a.txt', length: 1, chunkSize: 255 })
      await ca.db('shop').collection('fs.chunks').insertOne({ files_id: 1, n: 0, data: 'x' })
      h.rules('A', [{ db: 'shop', coll: 'orders', field: 'email' }])
      const masked = h.user({ masked: ['A'] })
      const plan = async () => {
        const res = await planOf(h, masked, { scope: { kind: 'database', db: 'shop' }, format: 'gzip' })
        expect(res.statusCode, res.body).toBe(200)
        return res.json() as Plan
      }
      for (const coll of ['fs.files', 'fs.chunks'])
        expect((await plan()).namespaces.find((n) => n.coll === coll)?.skipped).toBeUndefined()
      h.rules('A', [{ db: 'shop', coll: 'fs.files', field: 'metadata.owner' }])
      const p = await plan()
      for (const coll of ['fs.files', 'fs.chunks'])
        expect(p.namespaces.find((n) => n.coll === coll)?.skipped).toMatch(/GridFS/)
    } finally {
      await h.t.close()
    }
  })

  it('checks every chosen destination in order, and names none the caller may not see', async () => {
    const { h, destination } = await harness()
    try {
      h.rules('A', [{ db: 'shop', coll: 'orders', field: 'email' }])
      const enc = await destination('EncOnly', true)
      const plainDest = await destination('Plain', false)
      const hidden = await destination('HiddenDest', false)
      const editor = h.user({ on: { A: 'editor' } })
      h.ctx.backup.destinations.setGrants(enc, [{ userId: editor.id, level: 'browse' }])
      h.ctx.backup.destinations.setGrants(plainDest, [{ userId: editor.id, level: 'send' }])
      const missing = '0e3f3d4a-2b1c-4d5e-8f90-a1b2c3d4e5f6'
      const p = (
        await planOf(h, editor, {
          scope: { kind: 'database', db: 'shop' },
          format: 'gzip',
          destinations: [enc, missing, plainDest, hidden],
        })
      ).json() as Plan
      expect(destinationChecks(p)).toEqual([
        {
          key: 'destination',
          level: 'block',
          params: { name: 'EncOnly', reason: 'encrypted_only' },
          fix: { kind: 'encrypt' },
        },
        { key: 'destination', level: 'block', params: { name: '', reason: 'unknown' } },
        {
          key: 'destination',
          level: 'block',
          params: { name: 'Plain', reason: 'personal_plain' },
          fix: { kind: 'encrypt' },
        },
        // Ungranted: indistinguishable from one that does not exist.
        { key: 'destination', level: 'block', params: { name: '', reason: 'unknown' } },
      ])
      expect(p.refusals).toEqual(
        expect.arrayContaining([
          'destination_encrypted_only',
          'destination_unknown',
          'destination_personal_plain',
        ]),
      )
      expect(JSON.stringify(p)).not.toContain('HiddenDest')
      // A deleted destination reads as unknown too.
      h.ctx.backup.destinations.remove(plainDest)
      const after = (
        await planOf(h, editor, {
          scope: { kind: 'database', db: 'shop' },
          format: 'mmbak',
          destinations: [plainDest],
        })
      ).json() as Plan
      expect(destinationChecks(after)).toEqual([
        { key: 'destination', level: 'block', params: { name: '', reason: 'unknown' } },
      ])
      expect(after.refusals).toEqual(['destination_unknown'])
    } finally {
      await h.t.close()
    }
  })
})

describe('dump plan scopes (spec §3.1)', () => {
  it('plans only the named databases of a server, and refuses one that does not exist', async () => {
    const { h, admin } = await harness()
    try {
      const p = (
        await planOf(h, admin, { scope: { kind: 'server', databases: ['other'] }, format: 'gzip' })
      ).json()
      expect(names(p)).toEqual(['other.x'])
      const res = await planOf(h, admin, { scope: { kind: 'server', databases: ['other', 'nope'] } })
      expect(res.statusCode).toBe(404)
      expect(res.body).toContain('Database nope not found')
    } finally {
      await h.t.close()
    }
  })

  it('refuses a collection or a named collection that does not exist', async () => {
    const { h, admin } = await harness()
    try {
      const coll = await planOf(h, admin, { scope: { kind: 'collection', db: 'shop', coll: 'nope' } })
      expect(coll.statusCode).toBe(404)
      expect(coll.body).toContain('Collection nope not found')
      const named = await planOf(h, admin, {
        scope: { kind: 'database', db: 'shop', collections: ['orders', 'gone'] },
      })
      expect(named.statusCode).toBe(404)
      expect(named.body).toContain('Collection gone not found')
      // A system collection cannot even be named into a backup: refused by the request's validation.
      const sys = await planOf(h, admin, { scope: { kind: 'collection', db: 'shop', coll: 'system.views' } })
      expect(sys.statusCode).toBe(400)
    } finally {
      await h.t.close()
    }
  })

  it('narrows views to the named ones, and leaves views out when asked', async () => {
    const { h, admin } = await harness()
    try {
      await ca.db('shop').createCollection('view2', { viewOn: 'items', pipeline: [] })
      const plan = async (scope: object) =>
        names(
          (
            await planOf(h, admin, { scope: { kind: 'database', db: 'shop', ...scope }, format: 'gzip' })
          ).json(),
        )
      // A list naming a view: only the named views.
      expect(await plan({ collections: ['orders', 'v'] })).toEqual(['shop.orders', 'shop.v'])
      // A list naming no view: the views follow the views switch.
      expect(await plan({ collections: ['orders'] })).toEqual(['shop.orders', 'shop.v', 'shop.view2'])
      expect(await plan({ collections: ['orders'], views: false })).toEqual(['shop.orders'])
      expect(await plan({ views: false })).toEqual(['shop.items', 'shop.orders'])
      // Views left out: the tools engine must not use --db, which would dump them anyway.
      expect(toolsComplete({ kind: 'database', db: 'shop', views: false }, [{}])).toBe(false)
      expect(toolsComplete({ kind: 'database', db: 'shop', views: true }, [{}, { skipped: 'x' }])).toBe(false)
      expect(toolsComplete({ kind: 'server' }, [{}])).toBe(true)
      // Chosen databases of a server: only those, never the whole server.
      expect(dumpToolArgs({ kind: 'server', databases: ['shop', 'other'] }, [], true)).toEqual([
        '--nsInclude=shop.*',
        '--nsInclude=other.*',
      ])
    } finally {
      await h.t.close()
    }
  })
})

describe('dump plan checks (spec §6)', () => {
  it('blocks a dump larger than the room left, warns past 80 %, and offers deleting old backups', async () => {
    const { h, admin } = await harness()
    try {
      const body = { scope: { kind: 'database', db: 'shop' }, format: 'archive' }
      const free = (await planOf(h, admin, body)).json() as Plan
      const fileBytes = free.estimate.fileBytes
      expect(fileBytes).toBeGreaterThan(0)
      expect(free.checks.find((c) => c.key === 'quota')).toMatchObject({ level: 'ok' })
      const room = vi.spyOn(h.ctx.backup.store, 'room')
      room.mockReturnValue(fileBytes - 1)
      const full = (await planOf(h, admin, body)).json() as Plan
      expect(full.checks.find((c) => c.key === 'quota')).toEqual({
        key: 'quota',
        level: 'block',
        params: { room: fileBytes - 1, fileBytes },
        fix: { kind: 'deleteOld' },
      })
      expect(full.refusals).toContain('backup_quota')
      room.mockReturnValue(fileBytes)
      const tight = (await planOf(h, admin, body)).json() as Plan
      expect(tight.checks.find((c) => c.key === 'quota')).toMatchObject({ level: 'warn' })
      expect(tight.refusals).not.toContain('backup_quota')
      room.mockRestore()
    } finally {
      await h.t.close()
    }
  })

  it('notes personal fields without a warning when the backup is encrypted', async () => {
    const { h, admin } = await harness()
    try {
      h.rules('A', [{ db: 'shop', coll: 'orders', field: 'email' }])
      const p = (
        await planOf(h, admin, { scope: { kind: 'database', db: 'shop' }, format: 'mmbak' })
      ).json() as Plan
      expect(p.checks.find((c) => c.key === 'personal')).toEqual({
        key: 'personal',
        level: 'ok',
        params: { count: 1 },
      })
    } finally {
      await h.t.close()
    }
  })

  it('offers only encrypting for a collection scope (nothing to exclude, anonymous kept for builtin)', async () => {
    const { h, admin } = await harness()
    try {
      h.rules('A', [{ db: 'shop', coll: 'orders', field: 'email' }])
      const p = (
        await planOf(h, admin, { scope: { kind: 'collection', db: 'shop', coll: 'orders' }, format: 'gzip' })
      ).json() as Plan & { checks: Array<Check & { more?: unknown[] }> }
      expect(p.checks.find((c) => c.key === 'personal')).toEqual({
        key: 'personal',
        level: 'warn',
        params: { count: 1 },
        fix: { kind: 'encrypt' },
        more: [{ kind: 'anonymous' }],
      })
      // A masked caller cannot pick anonymous (already masked): no personal warning at all.
      const masked = h.user({ masked: ['A'] })
      const m = (
        await planOf(h, masked, { scope: { kind: 'collection', db: 'shop', coll: 'orders' }, format: 'gzip' })
      ).json() as Plan
      expect(m.checks.find((c) => c.key === 'personal')).toBeUndefined()
    } finally {
      await h.t.close()
    }
  })

  it('reads a size it cannot measure as unknown instead of failing the plan', async () => {
    const { h, admin } = await harness()
    const spy = vi
      .spyOn(AggregationCursor.prototype, 'toArray')
      .mockRejectedValue(Object.assign(new Error('not authorized on shop to execute command'), { code: 13 }))
    try {
      const res = await planOf(h, admin, {
        scope: { kind: 'collection', db: 'shop', coll: 'items' },
        format: 'gzip',
      })
      expect(res.statusCode, res.body).toBe(200)
      const p = res.json() as Plan
      expect(p.namespaces).toEqual([expect.objectContaining({ coll: 'items', documents: null, bytes: null })])
      expect(p.estimate.bytes).toBe(0)
    } finally {
      spy.mockRestore()
      await h.t.close()
    }
  })

  it('estimates the time from this caller’s finished dumps on the same connection only', async () => {
    const { h, admin } = await harness()
    try {
      const body = { scope: { kind: 'database', db: 'shop' }, format: 'gzip' }
      const first = (await planOf(h, admin, body)).json() as Plan & { planHash: string }
      expect(first.estimate.seconds).toBeNull()
      const res = await admin.call('POST', `/api/connections/${h.ids.A}/backup`, {
        ...body,
        planHash: first.planHash,
      })
      expect(res.statusCode, res.body).toBe(202)
      expect((await waitJob(h.t, res.json().job.id, 60_000)).state).toBe('done')
      const again = (await planOf(h, admin, body)).json() as Plan
      expect(again.estimate.seconds).toEqual(expect.any(Number))
      expect(again.estimate.seconds).toBeGreaterThanOrEqual(1)
      expect(again.checks.find((c) => c.key === 'size')?.params).toMatchObject({
        seconds: again.estimate.seconds,
      })
      // Another connection, or another caller: no history, no estimate.
      const onB = (await planOf(h, admin, body, 'B')).json() as Plan
      expect(onB.estimate.seconds).toBeNull()
      const otherAdmin = h.user({ role: 'admin' })
      expect(((await planOf(h, otherAdmin, body)).json() as Plan).estimate.seconds).toBeNull()
    } finally {
      await h.t.close()
    }
  }, 90_000)
})

describe('dump plan and Queryable Encryption (spec §3.1)', () => {
  // Encrypted collections need a replica set: a one-member set on its own port.
  let rs: MongoMemoryReplSet
  let rsMongo: TestMongo
  let rc: MongoClient
  beforeAll(async () => {
    rs = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
    const port = Number(new URL(rs.getUri()).port)
    rsMongo = { host: '127.0.0.1', port, stop: async () => void (await rs.stop()) }
    rc = await new MongoClient(rs.getUri()).connect()
  }, slow(180_000))
  afterAll(async () => {
    await rc?.close()
    await rs?.stop()
  })

  it('leaves an encrypted collection out of every backup and says so', async () => {
    await rc.db('vault').dropDatabase()
    await rc.db('vault').collection('plain').insertOne({ a: 1 })
    // CI 2026-10-18: by the server's own command, as 6.0 (Queryable Encryption's preview) keeps such
    // collections too; the driver's createCollection refuses to make one before 7.0.
    await rc.db('vault').command({
      create: 'secure',
      encryptedFields: { fields: [{ path: 'ssn', bsonType: 'string', keyId: new UUID() }] },
    })
    const h = await backupHarness(rsMongo, b)
    try {
      const admin = h.user({ role: 'admin' })
      const res = await planOf(h, admin, { scope: { kind: 'database', db: 'vault' }, format: 'mmbak' })
      expect(res.statusCode, res.body).toBe(200)
      const p = res.json() as Plan
      const secure = p.namespaces.find((n) => n.coll === 'secure')
      expect(secure?.skipped).toMatch(/Queryable Encryption/)
      expect(p.namespaces.find((n) => n.coll === 'plain')?.skipped).toBeUndefined()
      expect(p.checks.find((c) => c.key === 'encrypted')).toEqual({
        key: 'encrypted',
        level: 'warn',
        params: { names: 'vault.secure' },
      })
      expect(p.refusals).toEqual([])
      // Only the encrypted collection: nothing left to back up.
      const only = (
        await planOf(h, admin, {
          scope: { kind: 'collection', db: 'vault', coll: 'secure' },
          format: 'mmbak',
        })
      ).json() as Plan
      expect(only.refusals).toContain('empty')
    } finally {
      await h.t.close()
    }
  })
})
