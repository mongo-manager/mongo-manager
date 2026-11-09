// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MongoClient } from 'mongodb'
import { ConnectionSettingsSchema, type PauseReason } from '@mongo-manager/shared'
import { startMongo, type TestMongo } from './support/mongo'
import { backupHarness } from './support/backup'
import { confirmedKey } from './support/schedules'
import { runCopies, executeRun } from '../src/backup/schedules/run'
import { readMmbakHeader } from '../src/backup/mmbak'
import { RETAINED } from '../src/backup/store'
import { HIDDEN_JOB_ERROR } from '../src/jobs/visibility'
import { Errors } from '../src/errors'
import { slow } from './support/slowness'

let a: TestMongo
let b: TestMongo
let ca: MongoClient
let base: string
const root = () => join(base, 'root')
beforeAll(async () => {
  ;[a, b] = await Promise.all([startMongo(), startMongo()])
  ca = await new MongoClient(`mongodb://127.0.0.1:${a.port}`).connect()
  await ca.db('shop').dropDatabase()
  await ca
    .db('shop')
    .collection('orders')
    .insertMany([{ email: 'a@x' }, { email: 'b@x' }])
  base = mkdtempSync(join(tmpdir(), 'mm-sched-run-'))
  mkdirSync(root())
}, slow(180_000))
afterAll(async () => {
  await ca?.close()
  await Promise.all([a?.stop(), b?.stop()])
  if (base) rmSync(base, { recursive: true, force: true })
})

type H = Awaited<ReturnType<typeof backupHarness>>
const harness = (over: object = {}) =>
  backupHarness(a, b, {
    backup: { folderRoots: [root()], privateNetworks: ['127.0.0.1/32'], ...over },
  } as never)

async function setup(h: H, opts: { format?: string; encryptedOnly?: boolean; extra?: 's3' } = {}) {
  const admin = h.user({ role: 'admin' })
  const u = h.user({ on: { A: 'editor' } })
  const folder = (
    await admin.call('POST', '/api/backup-destinations', {
      type: 'folder',
      name: `disk-${randomUUID().slice(0, 6)}`,
      config: { path: join(root(), randomUUID()) },
      policy: { encryptedOnly: opts.encryptedOnly ?? true },
    })
  ).json()
  const ids = [folder.id as string]
  if (opts.extra === 's3') {
    // A documentation address the egress refuses at once: every send there fails.
    const s3 = await admin.call('POST', '/api/backup-destinations', {
      type: 's3',
      name: `nowhere-${randomUUID().slice(0, 6)}`,
      config: {
        preset: 'custom',
        endpoint: 'https://192.0.2.10',
        region: 'us-east-1',
        bucket: 'acme-backups',
      },
      secrets: { accessKeyId: 'AKIAEXAMPLE0001', secretAccessKey: 'secret-secret-secret' },
    })
    expect(s3.statusCode, s3.body).toBe(201)
    ids.push(s3.json().id)
  }
  for (const id of ids)
    await admin.call('PUT', `/api/backup-destinations/${id}/grants`, {
      grants: [{ userId: u.id, level: 'send' }],
    })
  const key = opts.format && opts.format !== 'mmbak' ? null : await confirmedKey(u)
  const res = await u.call('POST', '/api/backup-schedules', {
    name: 'Nightly shop',
    connectionId: h.ids.A,
    dump: { scope: { kind: 'database', db: 'shop' } },
    format: opts.format ?? 'mmbak',
    cadence: { kind: 'daily', times: ['02:00'] },
    timeZone: 'UTC',
    destinations: ids,
  })
  expect(res.statusCode, res.body).toBe(201)
  return { admin, u, folder, ids, key, id: res.json().id as string }
}
async function runNow(h: H, scheduleId: string) {
  const run = h.ctx.backup.runs.insert({ scheduleId, dueAt: h.ctx.now(), kind: 'manual' })!
  await executeRun(h.ctx, run.id)
  return h.ctx.backup.runs.get(run.id)!
}
const dumpJobs = (h: H) => h.ctx.jobs.list({}).filter((j) => j.kind === 'backup.dump').length

describe('a scheduled run (phase 3d-3c spec §1.5)', () => {
  it('dumps with the owner’s key, sends it, verifies, and lets the local copy go', async () => {
    const h = await harness()
    try {
      const { folder, key, id } = await setup(h)
      const run = await runNow(h, id)
      expect(run).toMatchObject({
        outcome: 'succeeded',
        reason: null,
        details: {
          keyFingerprint: key!.fingerprint,
          copies: [{ destinationId: folder.id, state: 'complete', reason: null }],
        },
      })
      expect(run.details.size).toBeGreaterThan(0)
      expect(run.dumpJobId && run.sendJobId && run.backupId).toBeTruthy()
      expect(h.ctx.backup.store.byId(run.backupId!)).toBeUndefined()
      const [copy] = h.ctx.backup.copies.forRun(id, run.backupId!)
      const file = join(folder.config.path, ...copy!.remoteKey.split('/'))
      expect(existsSync(`${file}.json`)).toBe(true)
      const header = readMmbakHeader(readFileSync(file))
      if (header === 'more') throw new Error('incomplete header')
      expect(header.header.keySlots).toEqual([expect.objectContaining({ type: 'server', keyId: key!.id })])
      const audit = h.ctx.store.db
        .prepare("SELECT outcome, details FROM audit_log WHERE action = 'backup.schedule.run.finish'")
        .all() as Array<{ outcome: string; details: string }>
      expect(audit).toHaveLength(1)
      expect(JSON.parse(audit[0]!.details)).toMatchObject({
        schedule: id,
        outcome: 'succeeded',
        kind: 'manual',
      })
    } finally {
      await h.t.close()
    }
  })

  it('pauses before reading any data when a right is gone (D5)', async () => {
    const h = await harness()
    try {
      const { admin, u, folder, key, id } = await setup(h)
      const setKeyState = (state: string) =>
        h.ctx.store.db.prepare('UPDATE backup_keys SET state = ? WHERE id = ?').run(state, key!.id)
      const cases: Array<[string, () => unknown, () => unknown, PauseReason]> = [
        [
          'owner disabled',
          () => h.ctx.users.setDisabled(u.id, true),
          () => h.ctx.users.setDisabled(u.id, false),
          'owner_disabled',
        ],
        [
          'connection access removed',
          () => h.ctx.grants.set(h.ids.A, u.id, 'none'),
          () => h.ctx.grants.set(h.ids.A, u.id, 'editor'),
          'connection_access',
        ],
        [
          'demoted on the connection',
          () => h.ctx.grants.set(h.ids.A, u.id, 'viewer'),
          () => h.ctx.grants.set(h.ids.A, u.id, 'editor'),
          'connection_access',
        ],
        [
          'destination grant revoked',
          () => admin.call('PUT', `/api/backup-destinations/${folder.id}/grants`, { grants: [] }),
          () =>
            admin.call('PUT', `/api/backup-destinations/${folder.id}/grants`, {
              grants: [{ userId: u.id, level: 'send' }],
            }),
          'destination_access',
        ],
        ['key no longer active', () => setKeyState('retired'), () => setKeyState('active'), 'key_inactive'],
        [
          'destination deleted',
          () => admin.call('DELETE', `/api/backup-destinations/${folder.id}`),
          () => undefined,
          'destination_gone',
        ],
      ]
      for (const [label, take, give, reason] of cases) {
        await take()
        const before = dumpJobs(h)
        const run = await runNow(h, id)
        expect(run, label).toMatchObject({ outcome: 'failed', reason, dumpJobId: null })
        expect(h.ctx.backup.schedules.get(id), label).toMatchObject({
          state: 'paused',
          pauseReason: reason,
          pausedBy: 'system',
        })
        expect(dumpJobs(h), label).toBe(before)
        await give()
        h.ctx.backup.schedules.resume(id, null)
        h.t.clock.now += 1
      }
    } finally {
      await h.t.close()
    }
  })

  it('pauses a plain schedule once its scope holds personal fields (D9)', async () => {
    const h = await harness()
    try {
      const { id } = await setup(h, { format: 'gzip', encryptedOnly: false })
      h.rules('A', [{ db: 'shop', coll: 'orders', field: 'email' }])
      const before = dumpJobs(h)
      const run = await runNow(h, id)
      expect(run).toMatchObject({ outcome: 'failed', reason: 'personal_plain' })
      expect(h.ctx.backup.schedules.get(id)).toMatchObject({ state: 'paused', pauseReason: 'personal_plain' })
      expect(dumpJobs(h)).toBe(before)
    } finally {
      await h.t.close()
    }
  })

  it('fails a run on an unreachable connection or a full quota, and keeps the schedule active', async () => {
    const h = await harness({ quotaMb: 16 })
    try {
      const { u, id } = await setup(h)
      const down = h.ctx.connections.create(
        {
          name: 'Down',
          favorite: false,
          readOnly: false,
          settings: ConnectionSettingsSchema.parse({
            hosts: [{ host: '127.0.0.1', port: 1 }],
            serverSelectionTimeoutMS: 500,
          }),
        },
        null,
      ).id
      h.ctx.store.db.prepare('UPDATE backup_schedules SET connection_id = ? WHERE id = ?').run(down, id)
      // W3.3: a failed run is an alert event, with the schedule's name and the reason code only.
      h.ctx.alerts.repo.createRule(
        {
          kind: 'event',
          event: 'schedule.failed',
          connectionId: null,
          enabled: true,
          channels: { inApp: true, email: false, webhooks: [] },
        },
        null,
      )
      expect(await runNow(h, id)).toMatchObject({ outcome: 'failed', reason: 'connection' })
      expect(h.ctx.alerts.repo.history({ limit: 10 })).toEqual([
        expect.objectContaining({
          event: 'schedule.failed',
          connectionId: down,
          connectionName: 'Down',
          detail: expect.objectContaining({ outcome: 'failed', reason: 'connection' }),
        }),
      ])
      expect(h.ctx.backup.schedules.get(id)!.state).toBe('active')
      h.ctx.store.db.prepare('UPDATE backup_schedules SET connection_id = ? WHERE id = ?').run(h.ids.A, id)
      // A run is unique per due time: the next one is a minute later.
      h.t.clock.now += 60_000
      // D4: the quota is checked before a run reads anything.
      h.ctx.store.db
        .prepare(
          "INSERT INTO backups (id, owner, kind, name, size, complete, meta, created_at, expires_at) VALUES (?, ?, 'backup', 'full', ?, 1, '{}', 1, ?)",
        )
        .run(randomUUID(), u.id, 16 * 1024 * 1024, Date.UTC(2100, 0, 1))
      expect(await runNow(h, id)).toMatchObject({
        outcome: 'failed',
        reason: 'backup_quota',
        dumpJobId: null,
      })
      expect(h.ctx.backup.schedules.get(id)!.state).toBe('active')
    } finally {
      await h.t.close()
    }
  })

  // Final review I6: kept server copies have no time to live, and retention runs only after a run
  // that succeeds: once they fill the space, every run failed for ever with the schedule "Active".
  it('pauses a keep-on-server schedule whose own kept copies fill the backup space, saying what to do', async () => {
    const h = await harness({ quotaMb: 16 })
    try {
      const { u, id } = await setup(h)
      expect((await u.call('PATCH', `/api/backup-schedules/${id}`, { keepOnServer: true })).statusCode).toBe(
        200,
      )
      h.ctx.store.db
        .prepare(
          "INSERT INTO backups (id, owner, kind, name, size, complete, meta, created_at, expires_at, schedule_id) VALUES (?, ?, 'backup', 'kept', ?, 1, '{}', 1, ?, ?)",
        )
        .run(randomUUID(), u.id, 16 * 1024 * 1024, RETAINED, id)
      expect(await runNow(h, id)).toMatchObject({
        outcome: 'failed',
        reason: 'server_space',
        dumpJobId: null,
      })
      expect(h.ctx.backup.schedules.get(id)).toMatchObject({ state: 'paused', pauseReason: 'server_space' })
    } finally {
      await h.t.close()
    }
  })

  // Second review of the personal-data rework (4): MongoDB's words in a run were judged by its owner
  // when written; an administrator reading another's runs while the values are hidden from them read
  // them all the same. Judged when read, as a job's are.
  it('keeps a run’s MongoDB words from a reader the values are hidden from, whoever owns it', async () => {
    const h = await harness()
    try {
      const { admin, id } = await setup(h)
      h.ctx.personalFields.set(h.ids.A, [{ db: 'shop', coll: 'orders', field: 'email' }])
      const hold = vi.spyOn(h.ctx.manager, 'hold').mockImplementation(() => {
        throw Errors.conflict('E11000 duplicate key: { email: "a@x" }')
      })
      const run = await runNow(h, id)
      hold.mockRestore()
      // Its owner sees the values: the words are kept.
      expect(run.details.message).toContain('a@x')
      const runs = () => admin.call('GET', `/api/backup-schedules/${id}/runs`)
      expect((await runs()).json()[0].message).toContain('a@x')
      h.ctx.personalFields.setHiddenFromSelf(h.ids.A, admin.id, true)
      expect((await runs()).json()[0].message).toBe(HIDDEN_JOB_ERROR)
    } finally {
      await h.t.close()
    }
  })

  // Final review minor 23: the catch-all kept MongoDB's own words for a restricted owner.
  it('keeps an unexpected failure’s own words from an owner who may not see personal values', async () => {
    const h = await harness()
    try {
      const { u, id } = await setup(h)
      h.ctx.grants.setMasked(h.ids.A, u.id, true)
      const hold = vi.spyOn(h.ctx.manager, 'hold').mockImplementation(() => {
        throw Errors.conflict('E11000 duplicate key: { email: "a@x" }')
      })
      const run = await runNow(h, id)
      hold.mockRestore()
      expect(run).toMatchObject({ outcome: 'failed', reason: 'internal' })
      expect(run.details.message).toBe(HIDDEN_JOB_ERROR)
    } finally {
      await h.t.close()
    }
  })

  it('fails a run the job runner refuses, or whose dump fails, and keeps the schedule active', async () => {
    const h = await harness()
    try {
      const { id } = await setup(h, { format: 'gzip', encryptedOnly: false })
      const start = vi.spyOn(h.ctx.jobs, 'start').mockImplementation(() => {
        throw Errors.conflict('Too many jobs are running')
      })
      expect(await runNow(h, id)).toMatchObject({ outcome: 'failed', reason: 'server_busy', dumpJobId: null })
      start.mockImplementation(() => ({ id: 'fake' }) as never)
      const real = h.ctx.jobs.get.bind(h.ctx.jobs)
      const get = vi
        .spyOn(h.ctx.jobs, 'get')
        .mockImplementation((jobId) =>
          jobId === 'fake'
            ? ({ id: 'fake', state: 'failed', error: 'mongodump exited with 1' } as never)
            : real(jobId),
        )
      h.t.clock.now += 60_000
      expect(await runNow(h, id)).toMatchObject({
        outcome: 'failed',
        reason: 'dump_failed',
        dumpJobId: 'fake',
        details: { message: 'mongodump exited with 1' },
      })
      start.mockRestore()
      get.mockRestore()
      expect(h.ctx.backup.schedules.get(id)!.state).toBe('active')
    } finally {
      await h.t.close()
    }
  })

  it('is partial when one destination of two fails, and keeps the local copy', async () => {
    const h = await harness()
    try {
      const { folder, ids, id } = await setup(h, { extra: 's3' })
      const run = await runNow(h, id)
      expect(run.outcome).toBe('partial')
      expect(run.reason).toBe('send_failed')
      expect(run.details.copies).toEqual([
        expect.objectContaining({ destinationId: folder.id, state: 'complete' }),
        expect.objectContaining({ destinationId: ids[1], state: 'failed', reason: expect.any(String) }),
      ])
      expect(h.ctx.backup.store.byId(run.backupId!)?.complete).toBe(true)
      expect(h.ctx.backup.schedules.get(id)!.state).toBe('active')
    } finally {
      await h.t.close()
    }
  })
})

// Short names review 12 (M-2): a destination the send failed before any copy of it was made (the
// local file could not be read) has its reason in the run's details, found by its id.
describe('a run’s copies', () => {
  it('give a destination with no copy the reason its send failed with', () => {
    const copies = runCopies(
      ['d1', 'd2', 'd3'],
      [{ destinationId: 'd1', state: 'complete', reason: null }],
      [
        { destination: 'Disk', destinationId: 'd2', reason: 'body' },
        { destination: 'A deleted destination', reason: 'destination_deleted' },
      ],
      (id) => (id === 'd3' ? null : id.toUpperCase()),
    )
    expect(copies).toEqual([
      { destinationId: 'd1', name: 'D1', state: 'complete', reason: null },
      { destinationId: 'd2', name: 'D2', state: 'missing', reason: 'body' },
      { destinationId: 'd3', name: null, state: 'missing', reason: null },
    ])
  })
})
