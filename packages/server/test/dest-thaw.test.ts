// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { S3ConfigSchema } from '@mongo-manager/shared'
import { createEgress } from '../src/net/egress'
import { createS3Adapter } from '../src/backup/destinations/s3'
import { remoteKeyFor } from '../src/backup/destinations/layout'
import { DestinationError } from '../src/backup/destinations/types'
import { startMongo, type TestMongo } from './support/mongo'
import { backupHarness } from './support/backup'
import { startFakeS3, type FakeS3 } from './support/fake-s3'
import { slow } from './support/slowness'

/**
 * W4 item 5 (completion design §2 W4.5): thawing an archived S3 object (GLACIER, DEEP_ARCHIVE)
 * from the app — a RestoreObject request, then a waiting state until the copy can be restored.
 */
let s3: FakeS3
let a: TestMongo
let b: TestMongo
let base: string
const signal = new AbortController().signal
beforeAll(async () => {
  ;[a, b, s3] = await Promise.all([startMongo(), startMongo(), startFakeS3()])
  base = mkdtempSync(join(tmpdir(), 'mm-thaw-'))
  mkdirSync(join(base, 'root'))
}, slow(180_000))
afterAll(async () => {
  await Promise.all([a?.stop(), b?.stop(), s3?.close()])
  if (base) rmSync(base, { recursive: true, force: true })
})
beforeEach(() => {
  s3.objects.clear()
  s3.restores.length = 0
})

const adapter = () =>
  createS3Adapter({
    egress: createEgress({ networks: ['127.0.0.1/32'] }),
    config: S3ConfigSchema.parse({
      preset: 'aws',
      endpoint: s3.url,
      region: 'us-east-1',
      bucket: 'mm-test',
      pathStyle: true,
      caPem: s3.caPem,
    }),
    secrets: s3.credentials,
    partBytes: 16 * 1024 * 1024,
    now: () => Date.now(),
  })
const keyOf = () => remoteKeyFor('', 'mmbak', randomUUID(), Date.now())

describe('thawing an archived S3 object (W4.5)', () => {
  it('asks for a restore with the days and the tier, then says it is thawing, then thawed', async () => {
    const key = keyOf()
    s3.objects.set(key, { body: Buffer.from('cold'), storageClass: 'DEEP_ARCHIVE' })
    const ad = adapter()
    expect(await ad.stat(key, signal)).toMatchObject({ archived: true, thaw: 'none' })
    expect(await ad.thaw!(key, { days: 3, tier: 'Bulk' }, signal)).toEqual({ state: 'thawing' })
    expect(s3.restores[0]!.body).toMatch(/<Days>3<\/Days>/)
    expect(s3.restores[0]!.body).toMatch(/<Tier>Bulk<\/Tier>/)
    expect(await ad.stat(key, signal)).toMatchObject({ archived: true, thaw: 'thawing' })
    // Asked again while it runs: still thawing, no error.
    expect(await ad.thaw!(key, { days: 3, tier: 'Bulk' }, signal)).toEqual({ state: 'thawing' })
    s3.objects.get(key)!.restoring = false
    s3.objects.get(key)!.restored = true
    expect(await ad.stat(key, signal)).toMatchObject({ archived: false, thaw: 'thawed' })
    expect(await ad.thaw!(key, { days: 3, tier: 'Bulk' }, signal)).toEqual({ state: 'thawed' })
  })

  it('refuses to thaw what is not archived', async () => {
    const key = keyOf()
    s3.objects.set(key, { body: Buffer.from('warm'), storageClass: 'STANDARD' })
    await expect(adapter().thaw!(key, { days: 1, tier: 'Standard' }, signal)).rejects.toMatchObject({
      reason: 'not_archived',
    })
    await expect(adapter().thaw!(key, { days: 1, tier: 'Standard' }, signal)).rejects.toBeInstanceOf(
      DestinationError,
    )
  })
})

describe('the thaw route and the listing (W4.5)', () => {
  type H = Awaited<ReturnType<typeof backupHarness>>
  const harness = () =>
    backupHarness(a, b, {
      backup: { folderRoots: [join(base, 'root')], privateNetworks: ['127.0.0.1/32'] },
    } as never)
  async function destination(h: H) {
    const admin = h.user({ role: 'admin' })
    const id = (
      await admin.call('POST', '/api/backup-destinations', {
        type: 's3',
        name: `Cold ${randomUUID().slice(0, 6)}`,
        config: {
          preset: 'aws',
          endpoint: s3.url,
          region: 'us-east-1',
          bucket: 'mm-test',
          pathStyle: true,
          caPem: s3.caPem,
          storageClass: 'DEEP_ARCHIVE',
        },
        secrets: s3.credentials,
        policy: { encryptedOnly: false },
      })
    ).json().id as string
    return { admin, id }
  }

  it('thaws for a browsing user, shows the waiting state in the list, and bounds what it takes', async () => {
    const h = await harness()
    try {
      const { admin, id } = await destination(h)
      const viewer = h.user({ role: 'viewer' })
      await admin.call('PUT', `/api/backup-destinations/${id}/grants`, {
        grants: [{ userId: viewer.id, level: 'browse' }],
      })
      const key = keyOf()
      s3.objects.set(key, { body: Buffer.from('cold'), storageClass: 'DEEP_ARCHIVE' })
      const list = async () =>
        (
          (await viewer.get(`/api/backup-destinations/${id}/backups`)).json().items as Array<{
            key: string
            archived: boolean
            thaw: string | null
          }>
        ).find((i) => i.key === key)!
      expect(await list()).toMatchObject({ archived: true, thaw: 'none' })
      // W4 review (minor): fetching it says to thaw it here, not in the provider's console.
      const early = await admin.call('POST', `/api/backup-destinations/${id}/backups/fetch`, {
        connectionId: h.ids.B,
        key,
      })
      expect([early.statusCode, early.json().details?.reason]).toEqual([409, 'archived'])
      expect(early.json().message).toMatch(/Thaw…/)
      expect(early.json().message).not.toMatch(/console/)
      const res = await viewer.call('POST', `/api/backup-destinations/${id}/backups/thaw`, {
        key,
        days: 2,
        tier: 'Standard',
      })
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json()).toEqual({ state: 'thawing' })
      expect(await list()).toMatchObject({ archived: true, thaw: 'thawing' })
      // Bounds and the layout.
      for (const body of [
        { key, days: 0, tier: 'Standard' },
        { key, days: 31, tier: 'Standard' },
        { key, days: 2, tier: 'Instant' },
        { key: '../../etc/passwd', days: 2, tier: 'Standard' },
      ])
        expect(
          (await viewer.call('POST', `/api/backup-destinations/${id}/backups/thaw`, body)).statusCode,
        ).toBe(400)
      // No grant: no destination.
      const stranger = h.user({ role: 'viewer' })
      expect(
        (
          await stranger.call('POST', `/api/backup-destinations/${id}/backups/thaw`, {
            key,
            days: 2,
            tier: 'Standard',
          })
        ).statusCode,
      ).toBe(404)
      const audit = h.ctx.store.db
        .prepare("SELECT details FROM audit_log WHERE action = 'backup.destination.thaw'")
        .all() as Array<{ details: string }>
      expect(audit.length).toBeGreaterThan(0)
      expect(JSON.parse(audit[0]!.details)).toMatchObject({ destination: id, days: 2, tier: 'Standard' })
    } finally {
      await h.t.close()
    }
  })

  it('refuses a thaw where the destination cannot (a folder)', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const id = (
        await admin.call('POST', '/api/backup-destinations', {
          type: 'folder',
          name: 'disk',
          config: { path: join(base, 'root', 'f') },
          policy: { encryptedOnly: false },
        })
      ).json().id as string
      const res = await admin.call('POST', `/api/backup-destinations/${id}/backups/thaw`, {
        key: keyOf(),
        days: 2,
        tier: 'Standard',
      })
      expect([res.statusCode, res.json().details?.reason]).toEqual([409, 'thaw_unsupported'])
    } finally {
      await h.t.close()
    }
  })
})
