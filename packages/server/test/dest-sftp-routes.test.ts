// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MongoClient } from 'mongodb'
import { startMongo, type TestMongo } from './support/mongo'
import { backupHarness } from './support/backup'
import { waitJob } from './support/jobs'
import { startSftpServer, type TestSftpServer } from './support/sftp-server'
import { slow } from './support/slowness'

/**
 * W4 item 5: an SFTP destination through the routes — the test reports the host key to trust, the
 * destination is saved with it pinned, a backup is sent (read back to verify), listed and fetched.
 */
let a: TestMongo
let b: TestMongo
let srv: TestSftpServer
let ca: MongoClient
let base: string
beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), 'mm-sftp-routes-'))
  mkdirSync(join(base, 'root'))
  mkdirSync(join(base, 'sftp'))
  mkdirSync(join(base, 'sftp', 'backups'))
  ;[a, b, srv] = await Promise.all([
    startMongo(),
    startMongo(),
    startSftpServer({ root: join(base, 'sftp'), password: 'pw-1' }),
  ])
  ca = await new MongoClient(`mongodb://127.0.0.1:${a.port}`).connect()
  await ca.db('sshop').dropDatabase()
  await ca
    .db('sshop')
    .collection('orders')
    .insertMany([{ n: 1 }, { n: 2 }])
}, slow(180_000))
afterAll(async () => {
  await ca?.close()
  await Promise.all([a?.stop(), b?.stop(), srv?.close()])
  if (base) rmSync(base, { recursive: true, force: true })
})

const config = (over: Record<string, unknown> = {}) => ({
  host: '127.0.0.1',
  port: srv.port,
  username: 'backup',
  folder: '/backups',
  auth: 'password',
  ...over,
})

describe('an SFTP destination (W4.5)', () => {
  it('reports the host key to trust, then is saved pinned, sent to, listed and fetched from', async () => {
    const h = await backupHarness(a, b, {
      backup: { folderRoots: [join(base, 'root')], privateNetworks: ['127.0.0.1/32'] },
    } as never)
    try {
      const admin = h.user({ role: 'admin' })
      const probe = await admin.call('POST', '/api/backup-destinations/test', {
        type: 'sftp',
        name: 'SFTP',
        config: config(),
        secrets: { password: 'pw-1' },
      })
      const steps = probe.json().steps as Array<{
        step: string
        ok: boolean
        reason?: string
        hostKey?: string
      }>
      expect(steps.slice(0, 2).every((s) => s.ok)).toBe(true)
      expect(steps[2]).toMatchObject({
        step: 'auth',
        ok: false,
        reason: 'host_key',
        hostKey: srv.fingerprint,
      })
      const created = await admin.call('POST', '/api/backup-destinations', {
        type: 'sftp',
        name: 'SFTP',
        config: config({ hostFingerprint: srv.fingerprint }),
        // A private key sent along with the password is not kept: the password signs in here.
        secrets: { password: 'pw-1', passphrase: 'unused' },
        policy: { encryptedOnly: false },
      })
      expect(created.statusCode, created.body).toBe(201)
      const view = created.json()
      expect(h.ctx.backup.destinations.secrets(view.id)).toEqual({ password: 'pw-1' })
      const test = (await admin.call('POST', `/api/backup-destinations/${view.id}/test`, {})).json()
      expect(
        test.steps.every((s: { ok: boolean }) => s.ok),
        JSON.stringify(test.steps),
      ).toBe(true)
      const summary = (await admin.get('/api/backup-destinations')).json()
      expect(summary.find((d: { id: string }) => d.id === view.id)).toMatchObject({ verify: 'readBack' })
      const body = { scope: { kind: 'database', db: 'sshop' }, format: 'gzip', destinations: [view.id] }
      const plan = (await admin.call('POST', `/api/connections/${h.ids.A}/backup/plan`, body)).json()
      const res = await admin.call('POST', `/api/connections/${h.ids.A}/backup`, {
        ...body,
        planHash: plan.planHash,
      })
      expect(res.statusCode, res.body).toBe(202)
      await waitJob(h.t, res.json().job.id, 60_000)
      const report = (await admin.get(`/api/transfer/jobs/${res.json().job.id}/report`)).json()
      const sent = await waitJob(h.t, report.sendJobId, 60_000)
      expect(sent.state, sent.error ?? '').toBe('done')
      const page = (await admin.get(`/api/backup-destinations/${view.id}/backups`)).json()
      expect(page.items).toHaveLength(1)
      expect(page.items[0]).toMatchObject({ state: 'complete', format: 'gzip' })
      const fetched = await admin.call('POST', `/api/backup-destinations/${view.id}/backups/fetch`, {
        connectionId: h.ids.B,
        key: page.items[0].key,
      })
      expect(fetched.statusCode, fetched.body).toBe(202)
      expect((await waitJob(h.t, fetched.json().job.id, 60_000)).state).toBe('done')
      // Another host key is another server: the password is asked for again.
      const moved = await admin.call('PATCH', `/api/backup-destinations/${view.id}`, {
        config: { hostFingerprint: `SHA256:${'B'.repeat(43)}` },
      })
      expect([moved.statusCode, moved.json().details?.reason]).toEqual([400, 'secrets_required'])
    } finally {
      await h.t.close()
    }
  }, 240_000)

  it('refuses a server whose key changed, saying which key it showed', async () => {
    const h = await backupHarness(a, b, {
      backup: { folderRoots: [join(base, 'root')], privateNetworks: ['127.0.0.1/32'] },
    } as never)
    try {
      const admin = h.user({ role: 'admin' })
      const steps = (
        await admin.call('POST', '/api/backup-destinations/test', {
          type: 'sftp',
          name: 'SFTP 2',
          config: config({ hostFingerprint: `SHA256:${'C'.repeat(43)}` }),
          secrets: { password: 'pw-1' },
        })
      ).json().steps
      expect(steps[2]).toMatchObject({ reason: 'host_key_changed', hostKey: srv.fingerprint })
    } finally {
      await h.t.close()
    }
  })
})
