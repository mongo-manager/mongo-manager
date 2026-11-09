// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MongoClient } from 'mongodb'
import { startMongo, type TestMongo } from './support/mongo'
import { backupHarness } from './support/backup'
import { waitJob } from './support/jobs'
import { slow } from './support/slowness'

let a: TestMongo
let b: TestMongo
let ca: MongoClient
let base: string
beforeAll(async () => {
  ;[a, b] = await Promise.all([startMongo(), startMongo()])
  ca = await new MongoClient(`mongodb://127.0.0.1:${a.port}`).connect()
  base = mkdtempSync(join(tmpdir(), 'mm-dump-send-'))
  mkdirSync(join(base, 'root'))
}, slow(180_000))
afterAll(async () => {
  await ca?.close()
  await Promise.all([a?.stop(), b?.stop()])
  if (base) rmSync(base, { recursive: true, force: true })
})
beforeEach(async () => {
  await ca.db('shop').dropDatabase()
  await ca
    .db('shop')
    .collection('orders')
    .insertMany([{ email: 'a@x' }])
})

describe('dumps with destinations (phase 3d-3b spec §1.2 step 2, §4.5, V5)', () => {
  it('checks each destination in the plan and refuses what it does not accept', async () => {
    const h = await backupHarness(a, b, { backup: { folderRoots: [join(base, 'root')] } } as never)
    try {
      const admin = h.user({ role: 'admin' })
      const dest = (
        await admin.call('POST', '/api/backup-destinations', {
          type: 'folder',
          name: 'Disk',
          config: { path: join(base, 'root', 'd1') },
        })
      ).json().id
      const url = `/api/connections/${h.ids.A}/backup/plan`
      const scope = { kind: 'database', db: 'shop' }
      const gz = (await admin.call('POST', url, { scope, format: 'gzip', destinations: [dest] })).json()
      expect(gz.checks).toContainEqual({
        key: 'destination',
        level: 'block',
        params: { name: 'Disk', reason: 'encrypted_only' },
        fix: { kind: 'encrypt' },
      })
      expect(gz.refusals).toContain('destination_encrypted_only')
      const mm = (await admin.call('POST', url, { scope, format: 'mmbak', destinations: [dest] })).json()
      expect(mm.checks).toContainEqual({ key: 'destination', level: 'ok', params: { name: 'Disk' } })
      const none = (await admin.call('POST', url, { scope, format: 'mmbak' })).json()
      expect(none.planHash).not.toBe(mm.planHash)
      const unknown = (
        await admin.call('POST', url, {
          scope,
          format: 'mmbak',
          destinations: ['0e3f3d4a-2b1c-4d5e-8f90-a1b2c3d4e5f6'],
        })
      ).json()
      expect(unknown.refusals).toContain('destination_unknown')
      // A user without a grant learns nothing about the destination: it reads as unknown.
      const editor = h.user({ on: { A: 'editor' } })
      expect(
        (await editor.call('POST', url, { scope, format: 'mmbak', destinations: [dest] })).json().refusals,
      ).toContain('destination_unknown')
    } finally {
      await h.t.close()
    }
  })

  it('queues the send when the dump finishes, and deletes the local copy after it', async () => {
    const h = await backupHarness(a, b, { backup: { folderRoots: [join(base, 'root')] } } as never)
    try {
      const admin = h.user({ role: 'admin' })
      const dest = (
        await admin.call('POST', '/api/backup-destinations', {
          type: 'folder',
          name: 'Disk',
          config: { path: join(base, 'root', 'd2') },
        })
      ).json().id
      const body = {
        scope: { kind: 'database', db: 'shop' },
        format: 'mmbak',
        destinations: [dest],
        deleteLocal: true,
      }
      const plan = (await admin.call('POST', `/api/connections/${h.ids.A}/backup/plan`, body)).json()
      const res = await admin.call('POST', `/api/connections/${h.ids.A}/backup`, {
        ...body,
        planHash: plan.planHash,
        password: 'correct horse battery',
      })
      expect(res.statusCode, res.body).toBe(202)
      expect((await waitJob(h.t, res.json().job.id, 60_000)).state).toBe('done')
      const report = (await admin.get(`/api/transfer/jobs/${res.json().job.id}/report`)).json()
      expect(report.sendJobId).toEqual(expect.any(String))
      expect((await waitJob(h.t, report.sendJobId, 60_000)).state).toBe('done')
      expect(h.ctx.backup.store.byId(report.backupId)).toBeUndefined()
      expect(h.ctx.backup.copies.byDestination(dest)).toEqual([
        expect.objectContaining({ state: 'complete', backupId: null }),
      ])
    } finally {
      await h.t.close()
    }
  }, 180_000)
})
