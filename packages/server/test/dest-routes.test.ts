// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type AddressInfo } from 'node:net'
import { startMongo, type TestMongo } from './support/mongo'
import { backupHarness } from './support/backup'
import { startFakeS3, type FakeS3 } from './support/fake-s3'
import { installDrive, startFakeGoogle, type FakeGoogle } from './support/fake-google'
import { slow } from './support/slowness'

let a: TestMongo
let b: TestMongo
let s3: FakeS3
let g: FakeGoogle
let base: string
beforeAll(async () => {
  ;[a, b, s3, g] = await Promise.all([startMongo(), startMongo(), startFakeS3(), startFakeGoogle()])
  installDrive(g)
  base = mkdtempSync(join(tmpdir(), 'mm-dest-routes-'))
  mkdirSync(join(base, 'root'))
}, slow(180_000))
afterAll(async () => {
  await Promise.all([a?.stop(), b?.stop(), s3?.close(), g?.close()])
  if (base) rmSync(base, { recursive: true, force: true })
})
const harness = async () => {
  const h = await backupHarness(a, b, {
    backup: { folderRoots: [join(base, 'root')], privateNetworks: ['127.0.0.1/32'] },
  } as never)
  h.ctx.backup.googleHosts = g.hosts
  return h
}
const s3Body = (name = 'Offsite') => ({
  type: 's3',
  name,
  config: {
    preset: 'minio',
    endpoint: s3.url,
    region: 'us-east-1',
    bucket: 'mm-test',
    prefix: 'p',
    pathStyle: true,
    caPem: s3.caPem,
  },
  secrets: { ...s3.credentials },
})

describe('destination routes (phase 3d-3b spec §4.3–§4.5, D4, D5, D7)', () => {
  it('lets administrators define, view, edit and delete destinations without ever returning a secret', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const created = await admin.call('POST', '/api/backup-destinations', s3Body())
      expect(created.statusCode, created.body).toBe(201)
      const view = created.json()
      expect(view).toMatchObject({
        name: 'Offsite',
        type: 's3',
        secrets: { accessKeyId: true, secretAccessKey: true },
        keyHint: '0001',
        policy: { encryptedOnly: true },
      })
      expect(created.body).not.toContain(s3.credentials.secretAccessKey)
      const all = await admin.get('/api/backup-destinations/all')
      expect(all.body).not.toContain(s3.credentials.secretAccessKey)
      const renamed = await admin.call('PATCH', `/api/backup-destinations/${view.id}`, {
        name: 'Renamed',
        policy: { encryptedOnly: false },
      })
      expect(renamed.json()).toMatchObject({ name: 'Renamed', policy: { encryptedOnly: false } })
      const audit = JSON.stringify(
        h.ctx.store.db
          .prepare("SELECT action, details FROM audit_log WHERE action LIKE 'backup.destination.%'")
          .all(),
      )
      expect(audit).toContain('backup.destination.create')
      expect(audit).toContain('backup.destination.policy')
      expect(audit).not.toContain(s3.credentials.secretAccessKey)
      expect((await admin.call('DELETE', `/api/backup-destinations/${view.id}`)).statusCode).toBe(204)
      expect((await admin.get('/api/backup-destinations/all')).json()).toEqual([])
    } finally {
      await h.t.close()
    }
  })

  it('refuses an identity change without its secrets', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const id = (await admin.call('POST', '/api/backup-destinations', s3Body())).json().id
      const moved = await admin.call('PATCH', `/api/backup-destinations/${id}`, {
        config: { endpoint: 'https://evil.example.com' },
      })
      expect([moved.statusCode, moved.json().details?.reason]).toEqual([400, 'secrets_required'])
      const ok = await admin.call('PATCH', `/api/backup-destinations/${id}`, {
        config: { bucket: 'other' },
        secrets: { ...s3.credentials },
      })
      expect(ok.statusCode).toBe(200)
    } finally {
      await h.t.close()
    }
  })

  it('keeps non-administrators out, and shows granted users only names and levels', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const editor = h.user({ role: 'editor' })
      const other = h.user({ role: 'editor' })
      expect((await editor.call('POST', '/api/backup-destinations', s3Body())).statusCode).toBe(403)
      expect((await editor.call('POST', '/api/backup-destinations/test', s3Body())).statusCode).toBe(403)
      const id = (await admin.call('POST', '/api/backup-destinations', s3Body())).json().id
      expect(
        (
          await admin.call('PUT', `/api/backup-destinations/${id}/grants`, {
            grants: [{ userId: editor.id, level: 'send' }],
          })
        ).statusCode,
      ).toBe(200)
      const seen = (await editor.get('/api/backup-destinations')).json()
      expect(seen).toEqual([
        // Still names and levels only; how a copy is verified (final review B34) is no secret.
        {
          id,
          name: 'Offsite',
          type: 's3',
          level: 'send',
          policy: { encryptedOnly: true },
          verify: 'checksum',
          // Phase 3d-3c: the schedule editor's Cold Storage warning (a minio preset is not one).
          coldStorage: false,
        },
      ])
      expect((await other.get('/api/backup-destinations')).json()).toEqual([])
      expect((await admin.get('/api/backup-destinations')).json()[0].level).toBe('admin')
      expect(
        (
          await admin.call('PUT', `/api/backup-destinations/${id}/grants`, {
            grants: [{ userId: 'nobody', level: 'send' }],
          })
        ).statusCode,
      ).toBe(400)
    } finally {
      await h.t.close()
    }
  })

  it('tests saved and unsaved destinations and records the status', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const unsaved = (await admin.call('POST', '/api/backup-destinations/test', s3Body())).json()
      expect(unsaved.steps.every((s: { ok: boolean }) => s.ok)).toBe(true)
      const id = (await admin.call('POST', '/api/backup-destinations', s3Body())).json().id
      await admin.call('POST', `/api/backup-destinations/${id}/test`)
      expect((await admin.get('/api/backup-destinations/all')).json()[0].status).toMatchObject({
        state: 'ok',
      })
      const folder = await admin.call('POST', '/api/backup-destinations', {
        type: 'folder',
        name: 'Disk',
        config: { path: join(base, 'elsewhere') },
      })
      expect([folder.statusCode, folder.json().details?.reason]).toEqual([400, 'path'])
    } finally {
      await h.t.close()
    }
  })

  // Phase 3d-3b UI review: a destination that could not be reached answered a listing with a bare
  // 500 ("Something went wrong") instead of saying why.
  it('says why a destination cannot be listed when its server cannot be reached', async () => {
    const h = await harness()
    try {
      const closed = await new Promise<number>((resolve) => {
        const srv = createServer().listen(0, '127.0.0.1', () => {
          const { port } = srv.address() as AddressInfo
          srv.close(() => resolve(port))
        })
      })
      const admin = h.user({ role: 'admin' })
      const body = s3Body('Gone')
      const id = (
        await admin.call('POST', '/api/backup-destinations', {
          ...body,
          config: { ...body.config, endpoint: `https://127.0.0.1:${closed}` },
        })
      ).json().id
      const res = await admin.get(`/api/backup-destinations/${id}/backups`)
      expect([res.statusCode, res.json().details?.reason]).toEqual([400, 'connect'])
    } finally {
      await h.t.close()
    }
  })

  it('limits tests to ten a minute per administrator', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const body = { type: 'folder', name: 'Disk', config: { path: join(base, 'root', 'rate') } }
      const codes: number[] = []
      for (let i = 0; i < 11; i++)
        codes.push((await admin.call('POST', '/api/backup-destinations/test', body)).statusCode)
      expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true)
      expect(codes[10]).toBe(429)
    } finally {
      await h.t.close()
    }
  })

  it('connects Google Drive by device code, keeping the refresh token on the server', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const other = h.user({ role: 'admin' })
      const start = await admin.call('POST', '/api/backup-destinations/google/device', {
        clientId: 'client-id-0001.apps.googleusercontent.com',
        clientSecret: 'client-secret-1',
      })
      expect(start.statusCode, start.body).toBe(200)
      const flow = start.json()
      expect(flow).toMatchObject({ userCode: 'ABCD-EFGH', verificationUrl: 'https://www.google.com/device' })
      expect((await other.get(`/api/backup-destinations/google/device/${flow.flowId}`)).statusCode).toBe(404)
      g.device.answers.push('approved')
      const polled = (await admin.get(`/api/backup-destinations/google/device/${flow.flowId}`)).json()
      expect(polled).toEqual({ state: 'approved', account: 'ops@example.com' })
      const saved = await admin.call('POST', '/api/backup-destinations', {
        type: 'gdrive',
        name: 'Drive',
        config: { auth: 'oauth', clientId: 'client-id-0001.apps.googleusercontent.com' },
        deviceFlowId: flow.flowId,
      })
      expect(saved.statusCode, saved.body).toBe(201)
      expect(saved.json()).toMatchObject({
        secrets: { clientSecret: true, refreshToken: true },
        status: { account: 'ops@example.com' },
      })
      expect(saved.body).not.toContain('1//refresh-1')
      expect(saved.body).not.toContain('client-secret-1')
      // A flow is used once.
      const again = await admin.call('POST', '/api/backup-destinations', {
        type: 'gdrive',
        name: 'Drive 2',
        config: { auth: 'oauth', clientId: 'client-id-0001.apps.googleusercontent.com' },
        deviceFlowId: flow.flowId,
      })
      expect(again.json().details?.reason).toBe('device_flow_not_approved')
    } finally {
      await h.t.close()
    }
  })
})
