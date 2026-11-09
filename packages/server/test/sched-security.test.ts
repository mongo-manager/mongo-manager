// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { randomBytes, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createZstdCompress } from 'node:zlib'
import { MongoClient } from 'mongodb'
import { ConnectionSettingsSchema, compileCadence, nextRuns } from '@mongo-manager/shared'
import { startMongo, type TestMongo } from './support/mongo'
import { backupHarness } from './support/backup'
import { confirmedKey, teamApp, type Caller } from './support/schedules'
import { executeRun } from '../src/backup/schedules/run'
import { BackupKeyRepo } from '../src/backup/keys/repo'
import { createSecretBox } from '../src/crypto/secret-box'
import { MMBAK_MAGIC, encryptMmbak, readMmbakHeader } from '../src/backup/mmbak'
import { parseKit } from '../src/backup/keys/kit'
import { slow } from './support/slowness'

const ARCHIVE = readFileSync(join(__dirname, 'fixtures/backup/shop.archive'))
let base: string
beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'mm-sched-sec-'))
  mkdirSync(join(base, 'root'))
})
afterAll(() => {
  if (base) rmSync(base, { recursive: true, force: true })
})

async function keyFile(key: { id: string; key: Buffer }): Promise<Buffer> {
  const parts: Buffer[] = []
  const z = Readable.from([ARCHIVE]).pipe(createZstdCompress())
  for await (const p of encryptMmbak(z as AsyncIterable<Buffer>, {
    serverKey: { keyId: key.id, key: key.key },
    chunkBytes: 64 * 1024,
    tool: { name: 'mongo-manager', version: 'test' },
    now: 1,
  }))
    parts.push(p)
  return Buffer.concat(parts)
}
async function upload(u: Caller, file: Buffer): Promise<string> {
  const id = (await u.call('POST', '/api/backups/uploads', { name: 'x.mmbak', size: file.length })).json()
    .uploadId
  await u.raw('PUT', `/api/backups/uploads/${id}?offset=0`, file)
  return id
}
async function noMongo() {
  const h = await teamApp({ backup: { folderRoots: [join(base, 'root')] } } as never)
  const connectionId = h.ctx.connections.create(
    {
      name: 'Shop',
      favorite: false,
      readOnly: false,
      settings: ConnectionSettingsSchema.parse({ hosts: [{ host: '127.0.0.1', port: 1 }] }),
    },
    null,
  ).id
  const admin = h.user('admin')
  const destination = async (u: Caller, encryptedOnly = true) => {
    const d = (
      await admin.call('POST', '/api/backup-destinations', {
        type: 'folder',
        name: `disk-${randomUUID().slice(0, 6)}`,
        config: { path: join(base, 'root', randomUUID()) },
        policy: { encryptedOnly },
      })
    ).json()
    await admin.call('PUT', `/api/backup-destinations/${d.id}/grants`, {
      grants: [{ userId: u.id, level: 'send' }],
    })
    return d.id as string
  }
  const body = (destinations: string[], over: object = {}) => ({
    name: 'S',
    connectionId,
    dump: { scope: { kind: 'database', db: 'shop' } },
    cadence: { kind: 'daily', times: ['02:00'] },
    timeZone: 'UTC',
    destinations,
    ...over,
  })
  return { ...h, connectionId, admin, destination, body }
}

describe('phase 3d-3c abuse cases without MongoDB (spec §4)', () => {
  it('D2: the database alone opens no backup key', async () => {
    const { t, ctx, user } = await noMongo()
    try {
      const u = user()
      const k = await confirmedKey(u)
      const elsewhere = new BackupKeyRepo(ctx.store.db, createSecretBox(randomBytes(32)), ctx.now)
      expect(elsewhere.open(u.id, k.id)).toBeNull()
      const sealed = (
        ctx.store.db.prepare('SELECT sealed_key FROM backup_keys WHERE id = ?').get(k.id) as {
          sealed_key: string
        }
      ).sealed_key
      expect(() => ctx.secretBox.open(sealed, `backup-key:${randomUUID()}`)).toThrow()
      // A write to the database that moves this sealed key into another user's key row opens nothing there.
      const v = user()
      const theirs = await confirmedKey(v)
      ctx.store.db.prepare('UPDATE backup_keys SET sealed_key = ? WHERE id = ?').run(sealed, theirs.id)
      expect(ctx.backup.keys.open(v.id, theirs.id)).toBeNull()
    } finally {
      await t.close()
    }
  }) // [break: seal the key without its own context]

  it('D3: a server slot is tried with the caller’s own keys only; another key’s kit never opens it', async () => {
    const { t, ctx, user } = await noMongo()
    try {
      const owner = user()
      const k = await confirmedKey(owner)
      const file = await keyFile(k)
      const other = user()
      const theirs = await confirmedKey(other)
      const spy = vi.spyOn(ctx.backup.keys, 'open')
      const id = await upload(other, file)
      expect(
        (
          await other.call('POST', '/api/backups/inspect', { source: { kind: 'upload', uploadId: id } })
        ).json(),
      ).toMatchObject({
        state: 'key',
        fingerprint: k.fingerprint,
      })
      // The owner's key is never even opened for another caller.
      expect(spy).not.toHaveBeenCalledWith(owner.id, expect.anything())
      const wrong = await other.call('POST', '/api/backups/inspect', {
        source: { kind: 'upload', uploadId: id },
        kit: theirs.kit,
      })
      expect(wrong.json().details.reason).toBe('backup_key')
      spy.mockRestore()
    } finally {
      await t.close()
    }
  }) // [break: slotKeysFor tries every key of every user]

  it('D4: schedules, cadences, previews and run histories are bounded', async () => {
    const { t, ctx, user, destination, body } = await noMongo()
    try {
      const u = user()
      await confirmedKey(u)
      const dest = await destination(u)
      const fast = await u.call(
        'POST',
        '/api/backup-schedules',
        body([dest], { cadence: { kind: 'cron', expression: '*/30 * * * *' } }),
      )
      expect(fast.json().details.reason).toBe('cadence_min_gap')
      const ids: string[] = []
      for (let i = 0; i < 10; i++)
        ids.push((await u.call('POST', '/api/backup-schedules', body([dest]))).json().id)
      expect((await u.call('POST', '/api/backup-schedules', body([dest]))).json().details.reason).toBe(
        'schedule_limit',
      )
      for (let i = 0; i < 210; i++)
        ctx.backup.runs.insert({ scheduleId: ids[0]!, dueAt: i, kind: 'scheduled', outcome: 'missed' })
      expect(ctx.backup.runs.list(ids[0]!, 1000)).toHaveLength(200)
    } finally {
      await t.close()
    }
  }) // [break: MAX_SCHEDULE_RUNS_KEPT not applied in prune]

  it('D6: a policy change that removes many needs its count confirmed', async () => {
    const { t, ctx, user, destination, body } = await noMongo()
    try {
      const u = user()
      await confirmedKey(u)
      const dest = await destination(u)
      const id = (await u.call('POST', '/api/backup-schedules', body([dest]))).json().id
      for (let i = 0; i < 12; i++)
        ctx.store.db
          .prepare(
            `INSERT INTO backup_remote_copies (id, destination_id, backup_id, remote_key, owner, connection_id, meta, format,
              size, sha256, state, created_at, completed_at, schedule_id) VALUES (?, ?, NULL, ?, ?, NULL, ?, 'mmbak', 1, ?, 'complete', ?, ?, ?)`,
          )
          .run(
            randomUUID(),
            dest,
            `mongo-manager/2026/01/mm-20260101-0200${String(i).padStart(2, '0')}-aaaaaaaa.mmbak`,
            u.id,
            JSON.stringify({ startedAt: i }),
            'a'.repeat(64),
            i,
            i,
            id,
          )
      const ask = await u.call('PATCH', `/api/backup-schedules/${id}`, {
        retention: { last: 1, daily: 0, weekly: 0, monthly: 0 },
      })
      expect(ask.json().details).toMatchObject({ reason: 'retention_confirm', count: 11 })
      const wrongCount = await u.call('PATCH', `/api/backup-schedules/${id}`, {
        retention: { last: 1, daily: 0, weekly: 0, monthly: 0 },
        confirmRemovals: 3,
      })
      expect(wrongCount.statusCode).toBe(409)
    } finally {
      await t.close()
    }
  }) // [break: RETENTION_CONFIRM_ABOVE check removed from PATCH]

  it('D7: crafted files are refused before any key is tried; kits are bounded', async () => {
    const { t, ctx, user } = await noMongo()
    try {
      const u = user()
      const k = await confirmedKey(u)
      const file = await keyFile(k)
      const at = (readMmbakHeader(file) as { bytes: number }).bytes
      const json = JSON.parse(file.subarray(12, at).toString('utf8'))
      json.keySlots.push({ ...json.keySlots[0] })
      const body = Buffer.from(JSON.stringify(json))
      const len = Buffer.alloc(4)
      len.writeUInt32LE(body.length)
      const twoSlots = Buffer.concat([MMBAK_MAGIC, len, body, file.subarray(at)])
      const huge = Buffer.concat([MMBAK_MAGIC, Buffer.from([0, 0, 2, 0]), Buffer.alloc(16)])
      const spy = vi.spyOn(ctx.backup.keys, 'open')
      for (const crafted of [twoSlots, huge]) {
        const id = await upload(u, crafted)
        const res = await u.call('POST', '/api/backups/inspect', { source: { kind: 'upload', uploadId: id } })
        expect(res.statusCode).toBe(400)
        expect(res.json().details.reason).toBe('mmbak')
      }
      expect(spy).not.toHaveBeenCalled()
      spy.mockRestore()
      expect((await u.call('POST', '/api/backup-keys/import', { kit: 'x'.repeat(8193) })).statusCode).toBe(
        400,
      )
    } finally {
      await t.close()
    }
  }) // [break: readMmbakHeader counts server slots after the key is opened]

  it('D8: zones, cron lists and the next-run search are bounded', async () => {
    const { t, user, destination, body } = await noMongo()
    try {
      const u = user()
      await confirmedKey(u)
      const dest = await destination(u)
      expect(
        (await u.call('POST', '/api/backup-schedules', body([dest], { timeZone: 'Mars/Olympus' })))
          .statusCode,
      ).toBe(400)
      const list = Array.from({ length: 61 }, (_, i) => i % 60).join(',')
      expect(
        (
          await u.call(
            'POST',
            '/api/backup-schedules',
            body([dest], { cadence: { kind: 'cron', expression: `${list} 2 * * *` } }),
          )
        ).json().details.reason,
      ).toBe('cadence_cron')
      const started = Date.now()
      const never = await u.call('POST', '/api/backup-schedules/preview', {
        cadence: { kind: 'cron', expression: '0 0 30 2 *' },
      })
      expect(never.json().problem).toEqual({ reason: 'never' })
      expect(Date.now() - started).toBeLessThan(5000)
      // 2100 is no leap year: from March 2096 the next 29 February (2104) lies past the five-year search.
      const leap = compileCadence({ kind: 'cron', expression: '0 0 29 2 *' })
      expect(nextRuns(leap, 'UTC', Date.UTC(2096, 2, 1), 1)).toEqual([])
      expect(nextRuns(leap, 'UTC', Date.UTC(2026, 2, 1), 1)).toEqual([Date.UTC(2028, 1, 29)])
    } finally {
      await t.close()
    }
  }) // [break: MAX_DAYS raised to 100 years]

  it('D9: an unmasked plain schedule of personal data is refused when saved or changed', async () => {
    const { t, ctx, user, destination, body, connectionId } = await noMongo()
    try {
      const u = user()
      const loose = await destination(u, false)
      const strict = await destination(u)
      const id = (await u.call('POST', '/api/backup-schedules', body([loose], { format: 'gzip' }))).json().id
      ctx.personalFields.set(connectionId, [{ db: '*', coll: 'orders', field: 'email' }])
      const edit = await u.call('PATCH', `/api/backup-schedules/${id}`, { name: 'Renamed' })
      expect(edit.json().details.reason).toBe('personal_plain')
      ctx.personalFields.set(connectionId, [])
      expect(
        (await u.call('PATCH', `/api/backup-schedules/${id}`, { destinations: [strict] })).json().details
          .reason,
      ).toBe('encrypted_only')
    } finally {
      await t.close()
    }
  }) // [break: plainProblem ignores rules on "*"]
})

describe('phase 3d-3c abuse cases with MongoDB (spec §4)', () => {
  let a: TestMongo
  let b: TestMongo
  let ca: MongoClient
  beforeAll(async () => {
    ;[a, b] = await Promise.all([startMongo(), startMongo()])
    ca = await new MongoClient(`mongodb://127.0.0.1:${a.port}`).connect()
    await ca.db('shop').dropDatabase()
    await ca
      .db('shop')
      .collection('orders')
      .insertMany([{ n: 1 }, { n: 2 }])
  }, slow(180_000))
  afterAll(async () => {
    await ca?.close()
    await Promise.all([a?.stop(), b?.stop()])
  })

  async function scheduled(h: Awaited<ReturnType<typeof backupHarness>>) {
    const admin = h.user({ role: 'admin' })
    const u = h.user({ on: { A: 'editor' } })
    const d = (
      await admin.call('POST', '/api/backup-destinations', {
        type: 'folder',
        name: `disk-${randomUUID().slice(0, 6)}`,
        config: { path: join(base, 'root', randomUUID()) },
      })
    ).json()
    await admin.call('PUT', `/api/backup-destinations/${d.id}/grants`, {
      grants: [{ userId: u.id, level: 'send' }],
    })
    const created = (await u.call('POST', '/api/backup-keys', {})).json()
    const line = (created.kit as string).match(/MMKEY1-\S+/)![0]
    await u.call('POST', `/api/backup-keys/${created.key.id}/confirm`, { check: line.slice(-4) })
    const id = (
      await u.call('POST', '/api/backup-schedules', {
        name: 'Nightly',
        connectionId: h.ids.A,
        dump: { scope: { kind: 'database', db: 'shop' } },
        cadence: { kind: 'daily', times: ['02:00'] },
        timeZone: 'UTC',
        destinations: [d.id],
      })
    ).json().id as string
    return { u, id, created, line }
  }

  it('D1: no key, kit or key group reaches a DTO, the audit, a job, a report, a table or the log', async () => {
    const logFile = join(base, `log-${Math.random()}.log`)
    const h = await backupHarness(
      a,
      b,
      { logLevel: 'trace', logFile, backup: { folderRoots: [join(base, 'root')] } } as never,
      { logger: true },
    )
    try {
      const { u, id, created, line } = await scheduled(h)
      const run = h.ctx.backup.runs.insert({ scheduleId: id, dueAt: h.ctx.now(), kind: 'manual' })!
      await executeRun(h.ctx, run.id)
      expect(h.ctx.backup.runs.get(run.id)!.outcome).toBe('succeeded')
      // Final review minor 25: the kit sent in request bodies — import, inspect, a restore plan — leaves
      // no trace either, whatever those requests answer.
      const missing = { kind: 'backup', backupId: randomUUID() }
      await u.call('POST', '/api/backup-keys/import', { kit: created.kit })
      await u.call('POST', '/api/backups/inspect', { source: missing, kit: created.kit })
      await u.call('POST', `/api/connections/${h.ids.A}/restore/plan`, {
        source: missing,
        kit: created.kit,
        mapping: [{ from: { db: 'shop', coll: 'orders' }, to: { db: 'shop', coll: 'orders' } }],
      })
      const groups = line.slice(7).split('-')
      const key = parseKit(created.kit)
      const sealed = (
        h.ctx.store.db.prepare('SELECT sealed_key FROM backup_keys WHERE id = ?').get(created.key.id) as {
          sealed_key: string
        }
      ).sealed_key
      const secrets = [
        sealed,
        key.toString('base64'),
        key.toString('hex'),
        line,
        ...groups.slice(0, 12).map((_, i) => groups.slice(i, i + 3).join('-')),
      ]
      const surfaces = [
        (await u.get('/api/backup-keys')).body,
        (await u.get('/api/backup-schedules')).body,
        (await u.get(`/api/backup-schedules/${id}/runs`)).body,
        (await u.get('/api/jobs')).body,
        (await u.get('/api/backups')).body,
        ...[
          'audit_log',
          'jobs',
          'transfer_reports',
          'backup_schedule_runs',
          'backup_remote_copies',
          'backups',
        ].map((table) => JSON.stringify(h.ctx.store.db.prepare(`SELECT * FROM ${table}`).all())),
        JSON.stringify(
          h.ctx.store.db.prepare('SELECT id, owner, name, fingerprint, state FROM backup_keys').all(),
        ),
      ]
      await h.t.close()
      surfaces.push(readFileSync(logFile, 'utf8'))
      for (const s of surfaces) for (const secret of secrets) expect(s).not.toContain(secret)
    } finally {
      await h.t.close().catch(() => undefined)
    }
  }) // [break: toKeyView returns the sealed column]

  it('D5: a demoted owner’s schedule pauses before any data is read', async () => {
    const h = await backupHarness(a, b, { backup: { folderRoots: [join(base, 'root')] } } as never)
    try {
      const { u, id } = await scheduled(h)
      h.ctx.grants.set(h.ids.A, u.id, 'viewer')
      const before = h.ctx.jobs.list({}).length
      const run = h.ctx.backup.runs.insert({ scheduleId: id, dueAt: h.ctx.now(), kind: 'scheduled' })!
      await executeRun(h.ctx, run.id)
      expect(h.ctx.backup.runs.get(run.id)).toMatchObject({ outcome: 'failed', reason: 'connection_access' })
      expect(h.ctx.backup.schedules.get(id)).toMatchObject({
        state: 'paused',
        pauseReason: 'connection_access',
      })
      expect(h.ctx.jobs.list({}).length).toBe(before)
    } finally {
      await h.t.close()
    }
  }) // [break: runChecks checks the role the schedule was saved with]
})
