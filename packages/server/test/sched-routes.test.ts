// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConnectionSettingsSchema, RETENTION_PRESETS } from '@mongo-manager/shared'
import { confirmedKey, teamApp, type Caller } from './support/schedules'
import { RETAINED } from '../src/backup/store'

const DAY = 86_400_000
let base: string
beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'mm-sched-routes-'))
})
afterAll(() => {
  if (base) rmSync(base, { recursive: true, force: true })
})

async function setup() {
  const h = await teamApp({ backup: { folderRoots: [base] } } as never)
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
  const destination = async (policy = { encryptedOnly: true }, grantTo: Caller[] = []) => {
    const d = (
      await admin.call('POST', '/api/backup-destinations', {
        type: 'folder',
        name: `disk-${randomUUID().slice(0, 6)}`,
        config: { path: join(base, randomUUID()) },
        policy,
      })
    ).json()
    await admin.call('PUT', `/api/backup-destinations/${d.id}/grants`, {
      grants: grantTo.map((u) => ({ userId: u.id, level: 'send' })),
    })
    return d.id as string
  }
  const body = (destinations: string[], over: object = {}) => ({
    name: 'Nightly shop',
    connectionId,
    dump: { scope: { kind: 'database', db: 'shop' } },
    cadence: { kind: 'daily', times: ['02:00'] },
    timeZone: 'Europe/Berlin',
    destinations,
    ...over,
  })
  return { ...h, connectionId, admin, destination, body }
}

describe('schedule routes (phase 3d-3c spec §3.4)', () => {
  it('creates a schedule with the owner’s active key, its next run and the standard retention', async () => {
    const { t, user, destination, body } = await setup()
    try {
      const u = user()
      const dest = await destination(undefined, [u])
      const noKey = await u.call('POST', '/api/backup-schedules', body([dest]))
      expect(noKey.statusCode).toBe(409)
      expect(noKey.json().details.reason).toBe('key_required')
      const key = await confirmedKey(u)
      const res = await u.call('POST', '/api/backup-schedules', body([dest]))
      expect(res.statusCode, res.body).toBe(201)
      expect(res.json()).toMatchObject({
        name: 'Nightly shop',
        mine: true,
        owner: { id: u.id, username: u.username },
        connectionName: 'Shop',
        format: 'mmbak',
        key: { id: key.id, fingerprint: key.fingerprint },
        retention: RETENTION_PRESETS.standard,
        state: 'active',
        // 2026-01-01 00:00 UTC is 01:00 in Berlin: 02:00 Berlin is 01:00 UTC.
        nextRunAt: Date.UTC(2026, 0, 1, 1),
        lastRuns: [],
      })
      expect(res.json().destinations).toEqual([
        { id: dest, name: expect.stringMatching(/^disk-/), coldStorage: false },
      ])
    } finally {
      await t.close()
    }
  })

  it('checks rights at creation: backup rights on the connection, a grant on each destination', async () => {
    const { t, ctx, user, destination, body, connectionId } = await setup()
    try {
      const u = user()
      await confirmedKey(u)
      const granted = await destination(undefined, [u])
      const other = await destination()
      expect((await u.call('POST', '/api/backup-schedules', body([granted, other]))).statusCode).toBe(404)
      const hidden = user()
      await confirmedKey(hidden)
      ctx.grants.set(connectionId, hidden.id, 'none')
      expect((await hidden.call('POST', '/api/backup-schedules', body([granted]))).statusCode).toBe(404)
      const viewer = user('viewer')
      await confirmedKey(viewer)
      expect((await viewer.call('POST', '/api/backup-schedules', body([granted]))).statusCode).toBe(403)
    } finally {
      await t.close()
    }
  })

  it('refuses a cadence under an hour, in words (spec §1.3)', async () => {
    const { t, user, destination, body } = await setup()
    try {
      const u = user()
      await confirmedKey(u)
      const dest = await destination(undefined, [u])
      const close = await u.call(
        'POST',
        '/api/backup-schedules',
        body([dest], { cadence: { kind: 'daily', times: ['02:00', '02:30'] } }),
      )
      expect(close.statusCode).toBe(400)
      expect(close.json().details).toMatchObject({ reason: 'cadence_min_gap', problem: { minutes: 30 } })
      const bad = await u.call(
        'POST',
        '/api/backup-schedules',
        body([dest], { cadence: { kind: 'cron', expression: '61 * * * *' } }),
      )
      expect(bad.json().details).toMatchObject({ reason: 'cadence_cron', problem: { field: 'minute' } })
      expect(bad.json().message).toMatch(/61/)
    } finally {
      await t.close()
    }
  })

  it('refuses a plain format where personal data or an encrypted-only destination forbids it (D9)', async () => {
    const { t, ctx, user, destination, body, connectionId } = await setup()
    try {
      const u = user()
      const strict = await destination(undefined, [u])
      const loose = await destination({ encryptedOnly: false }, [u])
      expect(
        (await u.call('POST', '/api/backup-schedules', body([strict], { format: 'gzip' }))).json().details
          .reason,
      ).toBe('encrypted_only')
      ctx.personalFields.set(connectionId, [{ db: 'shop', coll: 'orders', field: 'email' }])
      expect(
        (await u.call('POST', '/api/backup-schedules', body([loose], { format: 'gzip' }))).json().details
          .reason,
      ).toBe('personal_plain')
      const anonymous = await u.call(
        'POST',
        '/api/backup-schedules',
        body([loose], { format: 'gzip', dump: { scope: { kind: 'database', db: 'shop' }, anonymous: true } }),
      )
      expect(anonymous.statusCode, anonymous.body).toBe(201)
      expect(anonymous.json().key).toBeNull()
      const other = await u.call(
        'POST',
        '/api/backup-schedules',
        body([loose], { format: 'gzip', dump: { scope: { kind: 'database', db: 'crm' } } }),
      )
      expect(other.statusCode).toBe(201)
    } finally {
      await t.close()
    }
  })

  // Review of the personal-data rework (I3): a schedule runs unattended, where "hide from me" (or
  // local mode's hiding) does not mask what it writes: saved plain, it paused at every run.
  it('judges a plain format as the schedule will run, not as its owner views the data', async () => {
    const { t, ctx, admin, destination, body, connectionId } = await setup()
    try {
      const loose = await destination({ encryptedOnly: false })
      ctx.personalFields.set(connectionId, [{ db: 'shop', coll: 'orders', field: 'email' }])
      ctx.personalFields.setHiddenFromSelf(connectionId, admin.id, true)
      const res = await admin.call('POST', '/api/backup-schedules', body([loose], { format: 'gzip' }))
      expect(res.statusCode).toBe(409)
      expect(res.json().details.reason).toBe('personal_plain')
    } finally {
      await t.close()
    }
  })

  it('allows at most ten schedules per user (D4)', async () => {
    const { t, user, destination, body } = await setup()
    try {
      const u = user()
      await confirmedKey(u)
      const dest = await destination(undefined, [u])
      for (let i = 0; i < 10; i++)
        expect((await u.call('POST', '/api/backup-schedules', body([dest]))).statusCode).toBe(201)
      const eleventh = await u.call('POST', '/api/backup-schedules', body([dest]))
      expect(eleventh.statusCode).toBe(409)
      expect(eleventh.json().details.reason).toBe('schedule_limit')
    } finally {
      await t.close()
    }
  })

  it('lets administrators see, pause, resume and delete every schedule, but not edit another’s (spec §0)', async () => {
    const { t, ctx, user, admin, destination, body } = await setup()
    try {
      const u = user()
      await confirmedKey(u)
      const dest = await destination(undefined, [u])
      const id = (await u.call('POST', '/api/backup-schedules', body([dest]))).json().id
      const stranger = user()
      const all = (await admin.get('/api/backup-schedules')).json()
      expect(all).toMatchObject({
        enabled: true,
        schedules: [{ id, mine: false, owner: { username: u.username } }],
      })
      expect((await stranger.get('/api/backup-schedules')).json().schedules).toEqual([])
      for (const [method, url, payload] of [
        ['PATCH', `/api/backup-schedules/${id}`, { name: 'x' }],
        ['DELETE', `/api/backup-schedules/${id}`, undefined],
        ['POST', `/api/backup-schedules/${id}/pause`, undefined],
        ['GET', `/api/backup-schedules/${id}/runs`, undefined],
      ] as const)
        expect((await stranger.call(method, url, payload)).statusCode, `${method} ${url}`).toBe(404)
      const edit = await admin.call('PATCH', `/api/backup-schedules/${id}`, { name: 'Mine now' })
      expect(edit.statusCode).toBe(403)
      expect(edit.json().details.reason).toBe('not_owner')
      const paused = await admin.call('POST', `/api/backup-schedules/${id}/pause`)
      expect(paused.json()).toMatchObject({
        state: 'paused',
        nextRunAt: null,
        pause: { reason: 'admin', by: 'admin', byName: admin.username },
      })
      // Final review minor 24: an administrator's pause is lifted by an administrator, not silently
      // undone by the owner.
      const undo = await u.call('POST', `/api/backup-schedules/${id}/resume`)
      expect(undo.statusCode).toBe(403)
      expect(undo.json().details.reason).toBe('paused_by_admin')
      expect(ctx.backup.schedules.get(id)!.state).toBe('paused')
      const resumed = await admin.call('POST', `/api/backup-schedules/${id}/resume`)
      expect(resumed.json()).toMatchObject({
        state: 'active',
        pause: null,
        nextRunAt: Date.UTC(2026, 0, 1, 1),
      })
      expect((await u.call('POST', `/api/backup-schedules/${id}/pause`)).json().pause).toMatchObject({
        by: 'owner',
      })
      expect((await admin.call('DELETE', `/api/backup-schedules/${id}`)).statusCode).toBe(204)
      const actions = (
        ctx.store.db
          .prepare(
            "SELECT action FROM audit_log WHERE action LIKE 'backup.schedule.%' AND outcome = 'success' ORDER BY id",
          )
          .all() as Array<{ action: string }>
      ).map((a) => a.action)
      expect(actions).toEqual([
        'backup.schedule.create',
        'backup.schedule.pause',
        'backup.schedule.resume',
        'backup.schedule.pause',
        'backup.schedule.delete',
      ])
    } finally {
      await t.close()
    }
  })

  it('moves the next run when the cadence changes, and asks before a policy that removes many (plan ruling 21)', async () => {
    const { t, ctx, user, destination, body } = await setup()
    try {
      const u = user()
      await confirmedKey(u)
      const dest = await destination(undefined, [u])
      const id = (await u.call('POST', '/api/backup-schedules', body([dest]))).json().id
      // 2026-01-01 is a Thursday: the next Monday is the 5th.
      const weekly = await u.call('PATCH', `/api/backup-schedules/${id}`, {
        cadence: { kind: 'weekly', days: [1], time: '02:00' },
        timeZone: 'UTC',
      })
      expect(weekly.json().nextRunAt).toBe(Date.UTC(2026, 0, 5, 2))
      for (let i = 0; i < 15; i++) {
        const copyId = randomUUID()
        const at = ctx.now() - i * DAY
        ctx.store.db
          .prepare(
            `INSERT INTO backup_remote_copies (id, destination_id, backup_id, remote_key, owner, connection_id, meta, format,
              size, sha256, state, created_at, completed_at, schedule_id) VALUES (?, ?, NULL, ?, ?, NULL, ?, 'mmbak', 1, ?, 'complete', ?, ?, ?)`,
          )
          .run(
            copyId,
            dest,
            `mongo-manager/2026/01/mm-20260101-020000-${copyId.slice(0, 8)}.mmbak`,
            u.id,
            JSON.stringify({ startedAt: at }),
            'a'.repeat(64),
            at,
            at,
            id,
          )
      }
      const tight = { last: 1, daily: 0, weekly: 0, monthly: 0 }
      const preview = await u.call('POST', '/api/backup-schedules/preview', {
        scheduleId: id,
        retention: tight,
        timeZone: 'UTC',
      })
      expect(preview.json().removals).toEqual([{ location: dest, name: expect.any(String), count: 14 }])
      const ask = await u.call('PATCH', `/api/backup-schedules/${id}`, { retention: tight })
      expect(ask.statusCode).toBe(409)
      expect(ask.json().details).toMatchObject({ reason: 'retention_confirm', count: 14 })
      expect(
        (
          await u.call('PATCH', `/api/backup-schedules/${id}`, { retention: tight, confirmRemovals: 14 })
        ).json().retention,
      ).toEqual(tight)
      // A small change needs no confirmation.
      expect(
        (await u.call('PATCH', `/api/backup-schedules/${id}`, { retention: RETENTION_PRESETS.long }))
          .statusCode,
      ).toBe(200)
    } finally {
      await t.close()
    }
  })

  it('previews next runs and words, within a rate (spec §3.4)', async () => {
    const { t, user } = await setup()
    try {
      const u = user()
      const res = await u.call('POST', '/api/backup-schedules/preview', {
        cadence: { kind: 'daily', times: ['02:00'] },
        timeZone: 'Europe/Berlin',
        locale: 'tr',
      })
      expect(res.json()).toEqual({
        runs: [1, 2, 3, 4, 5].map((d) => Date.UTC(2026, 0, d, 1)),
        words: 'Her gün saat 02:00',
        problem: null,
        removals: [],
      })
      const never = await u.call('POST', '/api/backup-schedules/preview', {
        cadence: { kind: 'cron', expression: '0 0 30 2 *' },
      })
      expect(never.json()).toMatchObject({ runs: [], problem: { reason: 'never' } })
      for (let i = 0; i < 58; i++) await u.call('POST', '/api/backup-schedules/preview', {})
      expect((await u.call('POST', '/api/backup-schedules/preview', {})).statusCode).toBe(429)
    } finally {
      await t.close()
    }
  })

  it('shows a schedule’s runs to its owner and administrators', async () => {
    const { t, ctx, user, admin, destination, body } = await setup()
    try {
      const u = user()
      await confirmedKey(u)
      const dest = await destination(undefined, [u])
      const id = (await u.call('POST', '/api/backup-schedules', body([dest]))).json().id
      ctx.backup.runs.insert({
        scheduleId: id,
        dueAt: 5,
        kind: 'scheduled',
        outcome: 'missed',
        reason: 'server_down',
        details: { missed: 2 },
      })
      for (const who of [u, admin])
        expect((await who.get(`/api/backup-schedules/${id}/runs`)).json()).toEqual([
          expect.objectContaining({ dueAt: 5, outcome: 'missed', reason: 'server_down', missed: 2 }),
        ])
    } finally {
      await t.close()
    }
  })

  // Final review minor 8: a destination added back, a zone or keep changed can remove many too; the
  // preview took only the policy, and the confirmation only a policy change.
  it('previews and confirms what any change of where, when or keep would remove now', async () => {
    const { t, ctx, user, destination, body } = await setup()
    try {
      const u = user()
      await confirmedKey(u)
      const kept = await destination(undefined, [u])
      const old = await destination(undefined, [u])
      const id = (
        await u.call(
          'POST',
          '/api/backup-schedules',
          body([kept], { retention: { last: 1, daily: 0, weekly: 0, monthly: 0 } }),
        )
      ).json().id as string
      // Twelve copies this schedule left at a destination it no longer sends to.
      for (let i = 0; i < 12; i++)
        ctx.store.db
          .prepare(
            `INSERT INTO backup_remote_copies (id, destination_id, backup_id, remote_key, owner, connection_id, meta, format,
              size, sha256, state, created_at, completed_at, schedule_id) VALUES (?, ?, NULL, ?, ?, NULL, ?, 'mmbak', 1, ?, 'complete', ?, ?, ?)`,
          )
          .run(
            randomUUID(),
            old,
            `mongo-manager/2026/01/mm-20260101-0200${String(i).padStart(2, '0')}-aaaaaaaa.mmbak`,
            u.id,
            JSON.stringify({ startedAt: i }),
            'a'.repeat(64),
            i,
            i,
            id,
          )
      const preview = await u.call('POST', '/api/backup-schedules/preview', {
        scheduleId: id,
        destinations: [kept, old],
      })
      expect(preview.json().removals).toEqual([
        { location: kept, name: expect.any(String), count: 0 },
        { location: old, name: expect.any(String), count: 11 },
      ])
      const ask = await u.call('PATCH', `/api/backup-schedules/${id}`, { destinations: [kept, old] })
      expect(ask.statusCode).toBe(409)
      expect(ask.json().details).toMatchObject({ reason: 'retention_confirm', count: 11 })
      const ok = await u.call('PATCH', `/api/backup-schedules/${id}`, {
        destinations: [kept, old],
        confirmRemovals: 11,
      })
      expect(ok.statusCode, ok.body).toBe(200)
      // A destination the user may not use is not named in a preview.
      const foreign = await destination()
      const leak = await u.call('POST', '/api/backup-schedules/preview', {
        scheduleId: id,
        destinations: [kept, foreign],
      })
      expect(leak.json().removals.map((r: { location: string }) => r.location)).toEqual([kept])
    } finally {
      await t.close()
    }
  })

  // Final review I1: kept server copies had no time to live once "keep on the server too" was off.
  it('gives kept server copies the normal time to live when keeping is turned off, or its schedule is gone', async () => {
    const { t, ctx, user, destination, body } = await setup()
    try {
      const u = user()
      await confirmedKey(u)
      const dest = await destination(undefined, [u])
      const id = (await u.call('POST', '/api/backup-schedules', body([dest], { keepOnServer: true }))).json()
        .id as string
      const kept = (scheduleId: string | null) => {
        const row = randomUUID()
        ctx.store.db
          .prepare(
            "INSERT INTO backups (id, owner, kind, name, size, complete, meta, created_at, expires_at, schedule_id) VALUES (?, ?, 'backup', 'n', 1, 1, '{}', 1, ?, ?)",
          )
          .run(row, u.id, RETAINED, scheduleId)
        return row
      }
      const expiry = (row: string) =>
        (
          ctx.store.db.prepare('SELECT expires_at FROM backups WHERE id = ?').get(row) as {
            expires_at: number
          }
        ).expires_at
      const first = kept(id)
      const res = await u.call('PATCH', `/api/backup-schedules/${id}`, { keepOnServer: false })
      expect(res.statusCode, res.body).toBe(200)
      expect(expiry(first)).toBe(ctx.now() + ctx.backup.limits.ttlMs)
      // The sweep catches a schedule that no longer keeps copies however that came about.
      const second = kept(id)
      ctx.backup.store.sweep()
      expect(expiry(second)).toBe(ctx.now() + ctx.backup.limits.ttlMs)
      // A schedule that keeps them leaves them kept.
      await u.call('PATCH', `/api/backup-schedules/${id}`, { keepOnServer: true })
      const third = kept(id)
      ctx.backup.store.sweep()
      expect(expiry(third)).toBe(RETAINED)
    } finally {
      await t.close()
    }
  })
})
