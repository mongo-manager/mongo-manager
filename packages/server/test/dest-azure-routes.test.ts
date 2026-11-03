import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MongoClient } from 'mongodb'
import { verifyOf } from '../src/routes/destinations'
import { startMongo, type TestMongo } from './support/mongo'
import { backupHarness } from './support/backup'
import { waitJob } from './support/jobs'
import { startFakeAzure, type FakeAzure } from './support/fake-azure'
import { slow } from './support/slowness'

/**
 * W4 item 5: an Azure Blob destination through the routes — created with a sealed key (only the one
 * its way of signing uses), tested, a backup sent, listed, thawed when archived, fetched back.
 */
let a: TestMongo
let b: TestMongo
let az: FakeAzure
let ca: MongoClient
let base: string
beforeAll(async () => {
  ;[a, b, az] = await Promise.all([startMongo(), startMongo(), startFakeAzure()])
  ca = await new MongoClient(`mongodb://127.0.0.1:${a.port}`).connect()
  await ca.db('ashop').dropDatabase()
  await ca
    .db('ashop')
    .collection('orders')
    .insertMany([{ n: 1 }, { n: 2 }])
  base = mkdtempSync(join(tmpdir(), 'mm-azure-routes-'))
  mkdirSync(join(base, 'root'))
}, slow(180_000))
afterAll(async () => {
  await ca?.close()
  await Promise.all([a?.stop(), b?.stop(), az?.close()])
  if (base) rmSync(base, { recursive: true, force: true })
})

const config = (over: Record<string, unknown> = {}) => ({
  account: az.account,
  container: az.containerName,
  prefix: 'mm',
  auth: 'sharedKey',
  endpoint: az.url,
  caPem: az.caPem,
  ...over,
})

describe('an Azure Blob destination (W4.5)', () => {
  // W4 review I3: a large backup's blocks are each checked by their MD5 on the way, the whole only by
  // its size: the summary does not claim a checksum of the whole.
  it('says a copy there is verified by its size', () => {
    expect(verifyOf({ type: 'azure', config: {} } as never)).toBe('size')
    expect(verifyOf({ type: 'gcs', config: {} } as never)).toBe('checksum')
  })

  it('is created, tested, sent to, listed, thawed and fetched from', async () => {
    const h = await backupHarness(a, b, {
      backup: { folderRoots: [join(base, 'root')], privateNetworks: ['127.0.0.1/32'] },
    } as never)
    try {
      const admin = h.user({ role: 'admin' })
      const created = await admin.call('POST', '/api/backup-destinations', {
        type: 'azure',
        name: 'Azure',
        config: config(),
        // A SAS token sent along with the key is not kept: the key signs here.
        secrets: { accountKey: az.accountKey, sasToken: az.sasToken },
        policy: { encryptedOnly: false },
      })
      expect(created.statusCode, created.body).toBe(201)
      const view = created.json()
      expect(view.secrets).toEqual({ sasToken: false, accountKey: true })
      expect(JSON.stringify(view)).not.toContain(az.accountKey)
      expect(h.ctx.backup.destinations.secrets(view.id)).toEqual({ accountKey: az.accountKey })
      const test = (await admin.call('POST', `/api/backup-destinations/${view.id}/test`, {})).json()
      expect(test.steps.every((s: { ok: boolean }) => s.ok)).toBe(true)
      const body = { scope: { kind: 'database', db: 'ashop' }, format: 'gzip', destinations: [view.id] }
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
      const remoteKey = page.items[0].key as string
      expect(remoteKey).toMatch(/^mm\/mongo-manager\//)
      const fetched = await admin.call('POST', `/api/backup-destinations/${view.id}/backups/fetch`, {
        connectionId: h.ids.B,
        key: remoteKey,
      })
      expect(fetched.statusCode, fetched.body).toBe(202)
      expect((await waitJob(h.t, fetched.json().job.id, 60_000)).state).toBe('done')
      // Archived meanwhile: listed as such, thawed (rehydrated) on request.
      az.blobs.get(remoteKey)!.tier = 'Archive'
      const archived = (await admin.get(`/api/backup-destinations/${view.id}/backups`)).json()
      expect(archived.items[0]).toMatchObject({ archived: true })
      const thaw = await admin.call('POST', `/api/backup-destinations/${view.id}/backups/thaw`, {
        key: remoteKey,
        days: 1,
        tier: 'Standard',
      })
      expect(thaw.statusCode, thaw.body).toBe(200)
      expect(az.blobs.get(remoteKey)!.rehydrating).toBe('Standard')
    } finally {
      await h.t.close()
    }
  }, 240_000)

  it('asks for the credential again when the container or the way of signing changes', async () => {
    const h = await backupHarness(a, b, {
      backup: { folderRoots: [join(base, 'root')], privateNetworks: ['127.0.0.1/32'] },
    } as never)
    try {
      const admin = h.user({ role: 'admin' })
      const id = (
        await admin.call('POST', '/api/backup-destinations', {
          type: 'azure',
          name: 'Azure 2',
          config: config({ auth: 'sas' }),
          secrets: { sasToken: az.sasToken },
        })
      ).json().id
      for (const change of [{ container: 'other-container' }, { auth: 'sharedKey' }]) {
        const moved = await admin.call('PATCH', `/api/backup-destinations/${id}`, { config: change })
        expect([moved.statusCode, moved.json().details?.reason], JSON.stringify(change)).toEqual([
          400,
          'secrets_required',
        ])
      }
      const bad = await admin.call('PATCH', `/api/backup-destinations/${id}`, {
        secrets: { sasToken: 'sv=1&sig=x&comp=list' },
      })
      expect(bad.statusCode).toBe(400)
      expect(bad.body).not.toContain('comp=list')
    } finally {
      await h.t.close()
    }
  })
})
