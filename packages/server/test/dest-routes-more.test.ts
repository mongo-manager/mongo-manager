// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createServer, type AddressInfo } from 'node:net'
import { MongoClient } from 'mongodb'
import { startMongo, type TestMongo } from './support/mongo'
import { backupHarness } from './support/backup'
import { waitJob } from './support/jobs'
import { startFakeS3, type FakeS3 } from './support/fake-s3'
import { installDrive, startFakeGoogle, type FakeGoogle } from './support/fake-google'
import { startHttpsServer } from './support/https-server'
import { H } from './helpers'
import { slow } from './support/slowness'

let a: TestMongo
let b: TestMongo
let s3: FakeS3
let g: FakeGoogle
let ca: MongoClient
let base: string
beforeAll(async () => {
  ;[a, b, s3, g] = await Promise.all([startMongo(), startMongo(), startFakeS3(), startFakeGoogle()])
  installDrive(g)
  ca = await new MongoClient(`mongodb://127.0.0.1:${a.port}`).connect()
  await ca
    .db('shop')
    .collection('orders')
    .insertMany([{ n: 1 }, { n: 2 }])
  base = mkdtempSync(join(tmpdir(), 'mm-dest-routes-more-'))
  mkdirSync(join(base, 'root'))
}, slow(180_000))
afterAll(async () => {
  await ca?.close()
  await Promise.all([a?.stop(), b?.stop(), s3?.close(), g?.close()])
  if (base) rmSync(base, { recursive: true, force: true })
})
beforeEach(() => {
  g.device.answers.length = 0
  g.revoked.clear()
})

type H = Awaited<ReturnType<typeof backupHarness>>
type U = ReturnType<H['user']>
const harness = async () => {
  const h = await backupHarness(a, b, {
    backup: { folderRoots: [join(base, 'root')], privateNetworks: ['127.0.0.1/32'] },
  } as never)
  h.ctx.backup.googleHosts = g.hosts
  return h
}
const s3Body = (name: string, prefix: string, over: object = {}) => ({
  type: 's3',
  name,
  config: {
    preset: 'minio',
    endpoint: s3.url,
    region: 'us-east-1',
    bucket: 'mm-test',
    prefix,
    pathStyle: true,
    caPem: s3.caPem,
    ...over,
  },
  secrets: { ...s3.credentials },
})
const CLIENT = 'client-id-0001.apps.googleusercontent.com'
const saKey = (extra: object = {}) => JSON.stringify({ type: 'service_account', ...g.serviceKey, ...extra })
const nowhere = () => randomUUID()
const keyOf = (prefix: string, n: number, ext = 'archive') =>
  `${prefix ? `${prefix}/` : ''}mongo-manager/2026/10/mm-20261003-00000${n}-${String(n).repeat(8)}.${ext}`
const put = (key: string, body: string | Buffer, storageClass = 'STANDARD') =>
  s3.objects.set(key, { body: Buffer.from(body), storageClass })
const manifest = (size: number, format = 'archive', createdAt = 1234) =>
  JSON.stringify({
    v: 1,
    id: randomUUID(),
    format,
    size,
    sha256: 'e'.repeat(64),
    createdAt,
    tool: { name: 'mongo-manager', version: '2.0.0' },
  })
const audit = (h: H, action: string) =>
  h.ctx.store.db.prepare('SELECT outcome, details FROM audit_log WHERE action = ?').all(action) as Array<{
    outcome: string
    details: string
  }>
const tokenPolls = () => g.requests.filter((r) => r === 'POST /token').length
/** A port on 127.0.0.1 that nothing listens on. */
const closedPort = () =>
  new Promise<number>((resolve) => {
    const srv = createServer().listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as AddressInfo
      srv.close(() => resolve(port))
    })
  })

/** A copy row as a finished (or failed) send leaves it. */
function copyOf(
  h: H,
  dest: string,
  owner: string,
  key: string,
  size: number,
  state: 'sending' | 'complete' | 'failed' = 'complete',
) {
  const c = h.ctx.backup.copies.create({
    destinationId: dest,
    backupId: null,
    remoteKey: key,
    owner,
    connectionId: h.ids.A,
    meta: null,
    format: 'archive',
    size,
    sha256: 'f'.repeat(64),
    md5: null,
  })
  if (state === 'complete') h.ctx.backup.copies.complete(c.id, null)
  if (state === 'failed') h.ctx.backup.copies.fail(c.id, 'boom')
  return h.ctx.backup.copies.get(c.id)!
}
async function grant(admin: U, dest: string, grants: Array<{ userId: string; level: 'send' | 'browse' }>) {
  const res = await admin.call('PUT', `/api/backup-destinations/${dest}/grants`, { grants })
  expect(res.statusCode, res.body).toBe(200)
}
async function approvedFlow(admin: U, clientId = CLIENT) {
  const start = await admin.call('POST', '/api/backup-destinations/google/device', {
    clientId,
    clientSecret: 'client-secret-1',
  })
  expect(start.statusCode, start.body).toBe(200)
  const flowId = start.json().flowId as string
  g.device.answers.push('approved')
  expect((await admin.get(`/api/backup-destinations/google/device/${flowId}`)).json().state).toBe('approved')
  return flowId
}

describe('destination administration: refusals and what a view never shows', () => {
  it('answers an unknown destination with 404 and a malformed id with 400, changing nothing', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const id = nowhere()
      for (const [m, u, body] of [
        ['PATCH', `/api/backup-destinations/${id}`, { name: 'x' }],
        ['DELETE', `/api/backup-destinations/${id}`, undefined],
        ['POST', `/api/backup-destinations/${id}/test`, undefined],
        ['PUT', `/api/backup-destinations/${id}/grants`, { grants: [] }],
        ['GET', `/api/backup-destinations/${id}/backups`, undefined],
        [
          'POST',
          `/api/backup-destinations/${id}/backups/fetch`,
          { connectionId: h.ids.B, key: keyOf('', 1) },
        ],
        ['DELETE', `/api/backup-destinations/${id}/backups/${nowhere()}`, undefined],
      ] as const) {
        const res = await admin.call(m, u, body)
        expect(res.statusCode, `${m} ${u}`).toBe(404)
      }
      for (const [m, u] of [
        ['PATCH', '/api/backup-destinations/not-a-uuid'],
        ['DELETE', '/api/backup-destinations/not-a-uuid'],
        ['GET', '/api/backup-destinations/not-a-uuid/backups'],
        ['DELETE', `/api/backup-destinations/${id}/backups/not-a-uuid`],
        ['GET', '/api/backup-destinations/google/device/not-a-uuid'],
      ] as const)
        expect((await admin.call(m, u, m === 'PATCH' ? { name: 'x' } : undefined)).statusCode, u).toBe(400)
      expect((await admin.get('/api/backup-destinations/all')).json()).toEqual([])
    } finally {
      await h.t.close()
    }
  })

  it('does not tell a user without a grant whether a destination exists', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const stranger = h.user({ on: { A: 'editor', B: 'editor' } })
      const id = (await admin.call('POST', '/api/backup-destinations', s3Body('Hidden', 'hid'))).json().id
      put(keyOf('hid', 1), 'abc')
      const routes = (dest: string) =>
        [
          ['GET', `/api/backup-destinations/${dest}/backups`, undefined],
          [
            'POST',
            `/api/backup-destinations/${dest}/backups/fetch`,
            { connectionId: h.ids.B, key: keyOf('hid', 1) },
          ],
          ['DELETE', `/api/backup-destinations/${dest}/backups/${nowhere()}`, undefined],
        ] as const
      for (const [[m, u, body], [, u2, body2]] of routes(id).map(
        (r, i) => [r, routes(nowhere())[i]!] as const,
      )) {
        const real = await stranger.call(m, u, body)
        const fake = await stranger.call(m, u2, body2)
        expect([real.statusCode, fake.statusCode], `${m} ${u}`).toEqual([404, 404])
        expect(real.json().message).toBe(fake.json().message)
      }
      expect(s3.objects.has(keyOf('hid', 1))).toBe(true)
    } finally {
      await h.t.close()
    }
  })

  it('checks an edited config against its type and names the field that is wrong', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const id = (await admin.call('POST', '/api/backup-destinations', s3Body('Edit', 'ed'))).json().id
      const bad = await admin.call('PATCH', `/api/backup-destinations/${id}`, {
        config: { storageClass: 'FREE_FOREVER' },
      })
      expect(bad.statusCode).toBe(400)
      expect(bad.json().details.issues).toEqual([expect.objectContaining({ path: 'storageClass' })])
      // A key the type does not have is refused, not stored.
      const smuggled = await admin.call('PATCH', `/api/backup-destinations/${id}`, {
        config: { injected: 'x' },
      })
      expect(smuggled.statusCode).toBe(400)
      expect(h.ctx.backup.destinations.get(id)!.config).not.toHaveProperty('injected')
      expect(h.ctx.backup.destinations.get(id)!.config.storageClass).toBe('STANDARD')
      // A folder may not be moved outside its roots by an edit either.
      const folder = (
        await admin.call('POST', '/api/backup-destinations', {
          type: 'folder',
          name: 'Disk',
          config: { path: join(base, 'root', 'edit') },
        })
      ).json().id
      const moved = await admin.call('PATCH', `/api/backup-destinations/${folder}`, {
        config: { path: join(base, 'outside-edit') },
      })
      expect([moved.statusCode, moved.json().details?.reason]).toEqual([400, 'path'])
      expect(h.ctx.backup.destinations.get(folder)!.config.path).toBe(join(base, 'root', 'edit'))
    } finally {
      await h.t.close()
    }
  })

  it('refuses credentials a destination type does not have, including a refresh token set by hand', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const id = (await admin.call('POST', '/api/backup-destinations', s3Body('Creds', 'cr'))).json().id
      const res = await admin.call('PATCH', `/api/backup-destinations/${id}`, {
        secrets: { password: 'pw-1' },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json().message).toContain('"password"')
      expect(h.ctx.backup.destinations.secrets(id)).not.toHaveProperty('password')
      const flowId = await approvedFlow(admin)
      const drive = await admin.call('POST', '/api/backup-destinations', {
        type: 'gdrive',
        name: 'Drive',
        config: { auth: 'oauth', clientId: CLIENT },
        deviceFlowId: flowId,
      })
      expect(drive.statusCode, drive.body).toBe(201)
      const forged = await admin.call('PATCH', `/api/backup-destinations/${drive.json().id}`, {
        secrets: { refreshToken: '1//attacker-token' },
      })
      expect(forged.statusCode).toBe(400)
      expect(h.ctx.backup.destinations.secrets(drive.json().id).refreshToken).toBe('1//refresh-1')
      // A folder has no credentials at all.
      const folder = await admin.call('POST', '/api/backup-destinations', {
        type: 'folder',
        name: 'Disk',
        config: { path: join(base, 'root', 'creds') },
        secrets: { password: 'x' },
      })
      expect(folder.statusCode).toBe(400)
    } finally {
      await h.t.close()
    }
  })

  it('stores only the four fields of a service-account key and shows only that it is stored', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const created = await admin.call('POST', '/api/backup-destinations', {
        type: 'gdrive',
        name: 'Shared',
        config: { auth: 'serviceAccount', sharedDriveId: 'shared-drive-0001' },
        secrets: { serviceAccountKey: saKey({ project_id: 'proj-secret-77', client_id: '9988776655' }) },
      })
      expect(created.statusCode, created.body).toBe(201)
      const view = created.json()
      expect(view.secrets).toEqual({ clientSecret: false, serviceAccountKey: true })
      expect(view.keyHint).toBeNull()
      expect(created.body).not.toContain('PRIVATE KEY')
      const stored = JSON.parse(h.ctx.backup.destinations.secrets(view.id).serviceAccountKey!)
      expect(stored).not.toHaveProperty('project_id')
      expect(stored).not.toHaveProperty('client_id')
      expect(stored).toMatchObject({ client_email: g.serviceKey.client_email, private_key_id: 'kid-1' })
    } finally {
      await h.t.close()
    }
  })

  // The create route stores the key without its "type" field (only the fields that are used), but
  // the adapter parses the stored key with the same schema, which requires type: "service_account":
  // a saved service-account Drive can then never sign in.
  it('tests an unsaved service-account Drive with the key as entered', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const res = await admin.call('POST', '/api/backup-destinations/test', {
        type: 'gdrive',
        name: 'Shared',
        config: { auth: 'serviceAccount', sharedDriveId: 'shared-drive-0001' },
        secrets: { serviceAccountKey: saKey() },
      })
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json()).toMatchObject({ account: g.serviceKey.client_email })
      expect(res.body).not.toContain('PRIVATE KEY')
    } finally {
      await h.t.close()
    }
  })

  it('signs a saved service-account Drive in, and keeps its folder id server-side', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const view = (
        await admin.call('POST', '/api/backup-destinations', {
          type: 'gdrive',
          name: 'Shared',
          config: { auth: 'serviceAccount', sharedDriveId: 'shared-drive-0001' },
          secrets: { serviceAccountKey: saKey() },
        })
      ).json()
      const tested = await admin.call('POST', `/api/backup-destinations/${view.id}/test`)
      expect(tested.json().account, tested.body).toBe(g.serviceKey.client_email)
      expect(h.ctx.backup.destinations.get(view.id)!.status).toMatchObject({
        state: 'ok',
        account: g.serviceKey.client_email,
        folderId: expect.any(String),
      })
      const all = (await admin.get('/api/backup-destinations/all')).json()
      expect(all[0].status).toMatchObject({ state: 'ok', account: g.serviceKey.client_email })
      expect(all[0].status).not.toHaveProperty('folderId')
      expect(JSON.stringify(all)).not.toContain('PRIVATE KEY')
    } finally {
      await h.t.close()
    }
  })

  // A key that is not a service-account key is the administrator's input error: it must answer 400
  // with a reason like every other credential problem, not an internal server error.
  it('answers an unusable service-account key with a reason, not a server error', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const body = {
        type: 'gdrive',
        name: 'Bad key',
        config: { auth: 'serviceAccount', sharedDriveId: 'shared-drive-0001' },
        secrets: { serviceAccountKey: '{"type":"service_account"}' },
      }
      for (const url of ['/api/backup-destinations', '/api/backup-destinations/test']) {
        const res = await admin.call('POST', url, body)
        // Short names review 7 (M-1): a credential not valid, like the other credential problems.
        expect([res.statusCode, res.json().details?.reason], url).toEqual([400, 'secrets_invalid'])
      }
      expect((await admin.get('/api/backup-destinations/all')).json()).toEqual([])
    } finally {
      await h.t.close()
    }
  })

  it('deletes a destination: abandons unfinished provider uploads, keeps finished files, drops cached tokens', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const id = (await admin.call('POST', '/api/backup-destinations', s3Body('Gone', 'del'))).json().id
      const uploadId = randomUUID()
      s3.uploads.set(uploadId, new Map([[1, Buffer.from('part')]]))
      const unfinished = copyOf(h, id, admin.id, keyOf('del', 1), 10, 'failed')
      h.ctx.backup.copies.setResume(unfinished.id, { uploadId, key: unfinished.remoteKey, parts: [] })
      // A copy that failed before any upload began has nothing to abandon.
      copyOf(h, id, admin.id, keyOf('del', 3), 10, 'failed')
      put(keyOf('del', 2), 'done')
      copyOf(h, id, admin.id, keyOf('del', 2), 4)
      h.ctx.backup.tokens.set(`${id}|1`, {} as never)
      h.ctx.backup.tokens.set('someone-else|1', {} as never)
      expect((await admin.call('DELETE', `/api/backup-destinations/${id}`)).statusCode).toBe(204)
      expect(s3.uploads.has(uploadId)).toBe(false)
      expect(s3.objects.has(keyOf('del', 2))).toBe(true)
      expect([...h.ctx.backup.tokens.keys()]).toEqual(['someone-else|1'])
      expect(h.ctx.backup.destinations.get(id)).toBeUndefined()
      expect(audit(h, 'backup.destination.delete')).toEqual([
        expect.objectContaining({ outcome: 'success', details: expect.stringContaining(id) }),
      ])
    } finally {
      await h.t.close()
    }
  })

  it('records a failed or revoked saved test in the status, and clears the reason once it passes', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const flowId = await approvedFlow(admin)
      const id = (
        await admin.call('POST', '/api/backup-destinations', {
          type: 'gdrive',
          name: 'Drive',
          config: { auth: 'oauth', clientId: CLIENT },
          deviceFlowId: flowId,
        })
      ).json().id
      g.revoked.add('1//refresh-1')
      const revoked = (await admin.call('POST', `/api/backup-destinations/${id}/test`)).json()
      expect(revoked.steps.find((s: { step: string }) => s.step === 'auth')).toMatchObject({
        ok: false,
        reason: 'reconnect',
      })
      expect(h.ctx.backup.destinations.get(id)!.status).toMatchObject({
        state: 'reconnect',
        reason: 'reconnect',
      })
      g.revoked.clear()
      h.ctx.backup.tokens.clear()
      await admin.call('POST', `/api/backup-destinations/${id}/test`)
      const status = (await admin.get('/api/backup-destinations/all')).json()[0].status
      expect(status).toMatchObject({ state: 'ok', account: 'ops@example.com' })
      const s3id = (
        await admin.call('POST', '/api/backup-destinations', {
          ...s3Body('Wrong', 'wr'),
          secrets: { ...s3.credentials, secretAccessKey: 'definitely-wrong-1' },
        })
      ).json().id
      await admin.call('POST', `/api/backup-destinations/${s3id}/test`)
      expect(h.ctx.backup.destinations.get(s3id)!.status).toMatchObject({ state: 'failed', reason: 'auth' })
    } finally {
      await h.t.close()
    }
  })
})

describe('Google sign-in by device code (spec §2.4, §4.5)', () => {
  it('starts no sign-in for a client Google does not know', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const res = await admin.call('POST', '/api/backup-destinations/google/device', {
        clientId: 'bad-client-id',
        clientSecret: 'x',
      })
      expect([res.statusCode, res.json().details?.reason]).toEqual([400, 'auth'])
      // Google out of reach: the connection failure is named, never a bare 500.
      h.ctx.backup.googleHosts = { ...g.hosts, oauth: `https://127.0.0.1:${await closedPort()}` }
      const down = await admin.call('POST', '/api/backup-destinations/google/device', {
        clientId: CLIENT,
        clientSecret: 'client-secret-1',
      })
      expect([down.statusCode, down.json().details?.reason]).toEqual([400, 'connect'])
      h.ctx.backup.googleHosts = g.hosts
      const editor = h.user({ role: 'editor' })
      expect(
        (
          await editor.call('POST', '/api/backup-destinations/google/device', {
            clientId: CLIENT,
            clientSecret: 'client-secret-1',
          })
        ).statusCode,
      ).toBe(403)
    } finally {
      await h.t.close()
    }
  })

  it('polls Google no faster than it asks, slows down when told, and records a refusal', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const flowId = (
        await admin.call('POST', '/api/backup-destinations/google/device', {
          clientId: CLIENT,
          clientSecret: 'client-secret-1',
        })
      ).json().flowId
      const poll = async () => (await admin.get(`/api/backup-destinations/google/device/${flowId}`)).json()
      const before = tokenPolls()
      expect(await poll()).toEqual({ state: 'pending' })
      expect(tokenPolls()).toBe(before + 1)
      // Asked again at once: answered without asking Google.
      expect(await poll()).toEqual({ state: 'pending' })
      expect(tokenPolls()).toBe(before + 1)
      h.t.clock.now += 5_000
      g.device.answers.push('slow_down')
      expect(await poll()).toEqual({ state: 'pending' })
      expect(h.ctx.backup.deviceFlows.get(admin.id, flowId)!.interval).toBe(10)
      h.t.clock.now += 5_000
      expect(await poll()).toEqual({ state: 'pending' })
      expect(tokenPolls()).toBe(before + 2)
      h.t.clock.now += 5_000
      g.device.answers.push('access_denied')
      expect(await poll()).toEqual({ state: 'denied' })
      expect(audit(h, 'backup.destination.connect')).toEqual([
        { outcome: 'failure', details: JSON.stringify({ state: 'denied' }) },
      ])
      // A refused sign-in stays refused and cannot be saved.
      h.t.clock.now += 60_000
      expect(await poll()).toEqual({ state: 'denied' })
      expect(tokenPolls()).toBe(before + 3)
      const saved = await admin.call('POST', '/api/backup-destinations', {
        type: 'gdrive',
        name: 'Drive',
        config: { auth: 'oauth', clientId: CLIENT },
        deviceFlowId: flowId,
      })
      expect([saved.statusCode, saved.json().details?.reason]).toEqual([400, 'device_flow_not_approved'])
    } finally {
      await h.t.close()
    }
  })

  it('forgets a sign-in Google let expire, and one older than fifteen minutes', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const start = () =>
        admin
          .call('POST', '/api/backup-destinations/google/device', {
            clientId: CLIENT,
            clientSecret: 'client-secret-1',
          })
          .then((r) => r.json().flowId as string)
      const first = await start()
      g.device.answers.push('expired_token')
      expect((await admin.get(`/api/backup-destinations/google/device/${first}`)).json()).toEqual({
        state: 'expired',
      })
      const second = await start()
      h.t.clock.now += 15 * 60_000 + 1
      const late = await admin.get(`/api/backup-destinations/google/device/${second}`)
      expect(late.statusCode).toBe(404)
    } finally {
      await h.t.close()
    }
  })

  it('lets at most five sign-ins wait at once', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const codes: number[] = []
      for (let i = 0; i < 6; i++)
        codes.push(
          (
            await admin.call('POST', '/api/backup-destinations/google/device', {
              clientId: CLIENT,
              clientSecret: 'client-secret-1',
            })
          ).statusCode,
        )
      expect(codes).toEqual([200, 200, 200, 200, 200, 409])
    } finally {
      await h.t.close()
    }
  })

  it('says why when Google refuses the client secret during a poll', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const flowId = (
        await admin.call('POST', '/api/backup-destinations/google/device', {
          clientId: CLIENT,
          clientSecret: 'the-wrong-secret',
        })
      ).json().flowId
      const res = await admin.get(`/api/backup-destinations/google/device/${flowId}`)
      expect([res.statusCode, res.json().details?.reason]).toEqual([400, 'auth'])
    } finally {
      await h.t.close()
    }
  })

  it('approves without an account name when Drive does not say who it is', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      g.setDrive((_req, res) => {
        res.statusCode = 200
        res.end('this is not json')
      })
      const flowId = await approvedFlow(admin)
      expect((await admin.get(`/api/backup-destinations/google/device/${flowId}`)).json()).toEqual({
        state: 'approved',
      })
      expect(audit(h, 'backup.destination.connect')).toEqual([
        { outcome: 'success', details: JSON.stringify({ state: 'approved' }) },
      ])
      const saved = await admin.call('POST', '/api/backup-destinations', {
        type: 'gdrive',
        name: 'Drive',
        config: { auth: 'oauth', clientId: CLIENT },
        deviceFlowId: flowId,
      })
      expect(saved.statusCode, saved.body).toBe(201)
      expect(saved.json().status).not.toHaveProperty('account')
    } finally {
      installDrive(g)
      await h.t.close()
    }
  })

  it('needs an approved sign-in of the same client and administrator to save or test a Drive', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const other = h.user({ role: 'admin' })
      const body = (deviceFlowId?: string) => ({
        type: 'gdrive',
        name: 'Drive',
        config: { auth: 'oauth', clientId: CLIENT },
        ...(deviceFlowId ? { deviceFlowId } : {}),
      })
      for (const url of ['/api/backup-destinations', '/api/backup-destinations/test']) {
        const res = await admin.call('POST', url, body())
        expect([res.statusCode, res.json().details?.reason], url).toEqual([400, 'device_flow_not_approved'])
      }
      const pending = (
        await admin.call('POST', '/api/backup-destinations/google/device', {
          clientId: CLIENT,
          clientSecret: 'client-secret-1',
        })
      ).json().flowId
      const notYet = await admin.call('POST', '/api/backup-destinations/test', body(pending))
      expect(notYet.json().details?.reason).toBe('device_flow_not_approved')
      // Another administrator's approved sign-in is not usable.
      const theirs = await approvedFlow(other)
      for (const url of ['/api/backup-destinations', '/api/backup-destinations/test']) {
        const res = await admin.call('POST', url, body(theirs))
        expect([res.statusCode, res.json().details?.reason], url).toEqual([400, 'device_flow_not_approved'])
      }
      // A test uses the sign-in without spending it; the save then takes it.
      const mine = await approvedFlow(admin)
      const tested = await admin.call('POST', '/api/backup-destinations/test', body(mine))
      expect(tested.statusCode, tested.body).toBe(200)
      expect(tested.json()).toMatchObject({ account: 'ops@example.com' })
      expect(tested.json().steps.every((s: { ok: boolean }) => s.ok)).toBe(true)
      expect(tested.body).not.toContain('1//refresh-1')
      // A sign-in for another OAuth client cannot be attached to this one.
      const otherClient = await approvedFlow(admin, 'another-client-0002.apps.googleusercontent.com')
      const mismatch = await admin.call('POST', '/api/backup-destinations', body(otherClient))
      expect(mismatch.statusCode).toBe(400)
      const saved = await admin.call('POST', '/api/backup-destinations', body(mine))
      expect(saved.statusCode, saved.body).toBe(201)
    } finally {
      await h.t.close()
    }
  })

  it('reconnects a saved Drive with a new sign-in: new secrets, a fresh status, no cached token', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const id = (
        await admin.call('POST', '/api/backup-destinations', {
          type: 'gdrive',
          name: 'Drive',
          config: { auth: 'oauth', clientId: CLIENT },
          deviceFlowId: await approvedFlow(admin),
        })
      ).json().id
      await admin.call('POST', `/api/backup-destinations/${id}/test`)
      expect([...h.ctx.backup.tokens.keys()].some((k) => k.startsWith(`${id}|`))).toBe(true)
      h.ctx.backup.tokens.set('another-destination|1', {} as never)
      const flowId = await approvedFlow(admin)
      const res = await admin.call('PATCH', `/api/backup-destinations/${id}`, { deviceFlowId: flowId })
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json().status).toEqual({ state: 'unknown', checkedAt: null, account: 'ops@example.com' })
      expect(res.json().secrets).toEqual({ clientSecret: true, serviceAccountKey: false, refreshToken: true })
      expect([...h.ctx.backup.tokens.keys()]).toEqual(['another-destination|1'])
      // The sign-in was spent by the edit.
      const again = await admin.call('PATCH', `/api/backup-destinations/${id}`, { deviceFlowId: flowId })
      expect([again.statusCode, again.json().details?.reason]).toEqual([400, 'device_flow_not_approved'])
    } finally {
      await h.t.close()
    }
  })

  // The create route refuses a sign-in made for another OAuth client ("The client id differs from the
  // one that was connected"); an edit must not attach one either, or the destination keeps a client id
  // its refresh token was never issued to.
  // Final gate: a create naming another client used the approved sign-in up before refusing.
  it('keeps an approved sign-in when a save names another client, so the right save still works', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const flowId = await approvedFlow(admin)
      const save = (clientId: string) =>
        admin.call('POST', '/api/backup-destinations', {
          type: 'gdrive',
          name: 'Drive',
          config: { auth: 'oauth', clientId },
          deviceFlowId: flowId,
        })
      const wrong = await save('client-id-9999.apps.googleusercontent.com')
      expect([wrong.statusCode, wrong.json().details?.reason]).toEqual([400, 'device_flow_client'])
      const right = await save(CLIENT)
      expect(right.statusCode, right.body).toBe(201)
    } finally {
      await h.t.close()
    }
  })

  it('refuses to reconnect a Drive with a sign-in made for another OAuth client', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const id = (
        await admin.call('POST', '/api/backup-destinations', {
          type: 'gdrive',
          name: 'Drive',
          config: { auth: 'oauth', clientId: CLIENT },
          deviceFlowId: await approvedFlow(admin),
        })
      ).json().id
      const foreign = await approvedFlow(admin, 'another-client-0002.apps.googleusercontent.com')
      const res = await admin.call('PATCH', `/api/backup-destinations/${id}`, { deviceFlowId: foreign })
      expect(res.statusCode).toBe(400)
      expect(h.ctx.backup.destinations.get(id)!.config.clientId).toBe(CLIENT)
    } finally {
      await h.t.close()
    }
  })
})

describe('remote listings (spec §4.3, D12, D14)', () => {
  it('shows a send-level user only the copies they sent, and others everything with its sender', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const sender = h.user({ on: { A: 'editor' } })
      const browser = h.user({ on: { A: 'editor' } })
      const id = (await admin.call('POST', '/api/backup-destinations', s3Body('List', 'ls'))).json().id
      await grant(admin, id, [
        { userId: sender.id, level: 'send' },
        { userId: browser.id, level: 'browse' },
      ])
      put(keyOf('ls', 1), 'mine!')
      put(keyOf('ls', 2), 'admins')
      put(keyOf('ls', 3), 'withmanifest', 'GLACIER')
      put(`${keyOf('ls', 3)}.json`, manifest(12, 'archive', 1234))
      put(keyOf('ls', 4, 'mmbak'), 'bare')
      put(keyOf('ls', 5), 'local')
      put(keyOf('ls', 6), 'ghost')
      put(`${keyOf('ls', 7)}.json`, 'not a manifest')
      put(keyOf('ls', 7), 'badmanifest')
      // D14: a manifest larger than any real one is not read to its end, and vouches for nothing.
      put(`${keyOf('ls', 8)}.json`, `${manifest(4)}${' '.repeat(70_000)}`)
      put(keyOf('ls', 8), 'huge')
      const mine = copyOf(h, id, sender.id, keyOf('ls', 1), 5)
      copyOf(h, id, admin.id, keyOf('ls', 2), 6)
      copyOf(h, id, 'local', keyOf('ls', 5), 5)
      copyOf(h, id, 'a-user-that-was-deleted', keyOf('ls', 6), 5, 'failed')

      const own = (await sender.get(`/api/backup-destinations/${id}/backups`)).json()
      expect(own).toEqual({
        items: [
          expect.objectContaining({ key: keyOf('ls', 1), copyId: mine.id, mine: true, state: 'complete' }),
        ],
        cursor: null,
      })

      const all = (await browser.get(`/api/backup-destinations/${id}/backups`)).json().items as Array<
        Record<string, unknown>
      >
      const by = (n: number, ext?: string) => all.find((i) => i.key === keyOf('ls', n, ext))!
      expect(all).toHaveLength(8)
      expect(all.every((i) => !String(i.key).endsWith('.json'))).toBe(true)
      expect(by(8)).toMatchObject({ state: 'foreign', size: 4 })
      expect(by(1)).toMatchObject({ mine: false, state: 'complete' })
      expect(by(2)).toMatchObject({ mine: false, sender: expect.stringMatching(/^u-/) })
      expect(by(3)).toMatchObject({
        state: 'complete',
        createdAt: 1234,
        archived: true,
        copyId: null,
        sender: null,
      })
      expect(by(4, 'mmbak')).toMatchObject({
        state: 'foreign',
        format: 'mmbak',
        createdAt: Date.parse('2026-10-03T12:00:00.000Z'),
      })
      expect(by(5)).toMatchObject({ sender: 'local', state: 'complete' })
      expect(by(6)).toMatchObject({ sender: null, state: 'incomplete' })
      expect(by(7)).toMatchObject({ state: 'foreign' })
      const adminView = (await admin.get(`/api/backup-destinations/${id}/backups`)).json().items
      expect(adminView).toHaveLength(8)
      expect(adminView.find((i: { key: string }) => i.key === keyOf('ls', 2)).mine).toBe(true)
    } finally {
      await h.t.close()
    }
  })

  // Phase 3d-3b final review (A9): S3 is gathered over its pages and served newest first; the route's
  // own cursor (a provider page and an offset in it) is covered in dest-routes-final.
  it('gathers an S3 listing over its pages, newest first, and refuses an oversized or broken cursor', async () => {
    const paged = await startFakeS3({ pageSize: 2 })
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const id = (
        await admin.call('POST', '/api/backup-destinations', {
          ...s3Body('Paged', 'pg', { endpoint: paged.url, caPem: paged.caPem }),
          secrets: { ...paged.credentials },
        })
      ).json().id
      for (const n of [1, 2, 3])
        paged.objects.set(keyOf('pg', n), { body: Buffer.from('x'), storageClass: 'STANDARD' })
      const first = (await admin.get(`/api/backup-destinations/${id}/backups`)).json()
      expect(first.items.map((i: { key: string }) => i.key)).toEqual([3, 2, 1].map((n) => keyOf('pg', n)))
      expect(first.cursor).toBeNull()
      const huge = await admin.get(`/api/backup-destinations/${id}/backups?cursor=${'A'.repeat(9000)}`)
      expect(huge.statusCode).toBe(400)
      const garbage = await admin.get(`/api/backup-destinations/${id}/backups?cursor=%00%FF!!`)
      expect([garbage.statusCode, garbage.json().details?.reason]).toEqual([400, 'cursor'])
    } finally {
      await h.t.close()
      await paged.close()
    }
  })

  it('says why a listing failed instead of answering 500', async () => {
    const nonsense = await startHttpsServer((_req, res) => {
      res.statusCode = 200
      res.setHeader('content-type', 'application/xml')
      res.end('<ListBucketResult><Contents><Key>unclosed')
    })
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const broken = (
        await admin.call(
          'POST',
          '/api/backup-destinations',
          s3Body('Nonsense', 'ns', { endpoint: nonsense.url, caPem: nonsense.caPem }),
        )
      ).json().id
      const res = await admin.get(`/api/backup-destinations/${broken}/backups`)
      expect([res.statusCode, res.json().details?.reason]).toEqual([400, 'provider'])
      const wrong = (
        await admin.call('POST', '/api/backup-destinations', {
          ...s3Body('Wrong key', 'wk'),
          secrets: { ...s3.credentials, secretAccessKey: 'definitely-wrong-1' },
        })
      ).json().id
      const refused = await admin.get(`/api/backup-destinations/${wrong}/backups`)
      expect(refused.statusCode).toBe(400)
      expect(refused.json().details?.reason).toBe('auth')
      expect(refused.body).not.toContain('definitely-wrong-1')
    } finally {
      await h.t.close()
      await nonsense.close()
    }
  })
})

describe('fetching from a destination (plan ruling 2, D8, D14)', () => {
  it('refuses keys outside the layout and connections the user may not restore into', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const viewer = h.user({ on: { A: 'editor', B: 'viewer', A2: 'none' } })
      const id = (await admin.call('POST', '/api/backup-destinations', s3Body('Fetch', 'fe'))).json().id
      await grant(admin, id, [{ userId: viewer.id, level: 'browse' }])
      put(keyOf('fe', 1), 'abc')
      const fetch = (u: U, body: object) =>
        u.call('POST', `/api/backup-destinations/${id}/backups/fetch`, body)
      for (const key of [
        '../../etc/passwd',
        keyOf('other', 1),
        keyOf('', 1),
        `fe/mongo-manager/2026/10/../../../${keyOf('', 1)}`,
        `${keyOf('fe', 1)}.json`,
      ]) {
        const res = await fetch(admin, { connectionId: h.ids.B, key })
        expect([res.statusCode, res.json().details?.reason], key).toEqual([400, 'path'])
      }
      expect((await fetch(admin, { connectionId: h.ids.B, key: 'x'.repeat(2000) })).statusCode).toBe(400)
      expect(
        (await fetch(admin, { connectionId: 'no-such-connection', key: keyOf('fe', 1) })).statusCode,
      ).toBe(404)
      // A viewer on the target may not restore into it; a connection without a grant is not revealed.
      expect((await fetch(viewer, { connectionId: h.ids.B, key: keyOf('fe', 1) })).statusCode).toBe(403)
      expect((await fetch(viewer, { connectionId: h.ids.A2, key: keyOf('fe', 1) })).statusCode).toBe(404)
      expect(h.ctx.jobs.list({}).filter((j) => j.kind === 'backup.fetch')).toEqual([])
    } finally {
      await h.t.close()
    }
  })

  it('lets a send-level user fetch only a copy they sent, with its download checks', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const u = h.user({ on: { A: 'editor', B: 'editor' } })
      const id = (await admin.call('POST', '/api/backup-destinations', s3Body('Send', 'sl'))).json().id
      await grant(admin, id, [{ userId: u.id, level: 'send' }])
      put(keyOf('sl', 1), 'foreign')
      put(keyOf('sl', 2), 'admins')
      put(keyOf('sl', 3), 'nometa')
      copyOf(h, id, admin.id, keyOf('sl', 2), 6)
      // Their own copy, but with no record of what it holds: the access checks cannot run.
      copyOf(h, id, u.id, keyOf('sl', 3), 6)
      for (const n of [1, 2, 3]) {
        const res = await u.call('POST', `/api/backup-destinations/${id}/backups/fetch`, {
          connectionId: h.ids.B,
          key: keyOf('sl', n),
        })
        expect([res.statusCode, res.json().message], String(n)).toEqual([404, 'Backup not found'])
      }
    } finally {
      await h.t.close()
    }
  })

  it('stops a fetch that is gone, archived, or does not match its record', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const id = (await admin.call('POST', '/api/backup-destinations', s3Body('Checks', 'ck'))).json().id
      const fetch = (key: string) =>
        admin.call('POST', `/api/backup-destinations/${id}/backups/fetch`, { connectionId: h.ids.B, key })
      const gone = await fetch(keyOf('ck', 1))
      expect([gone.statusCode, gone.json().message]).toEqual([
        404,
        'The backup is no longer at the destination',
      ])
      put(keyOf('ck', 2), 'cold', 'DEEP_ARCHIVE')
      const cold = await fetch(keyOf('ck', 2))
      expect([cold.statusCode, cold.json().details?.reason]).toEqual([409, 'archived'])
      put(keyOf('ck', 3), 'twelve bytes')
      copyOf(h, id, admin.id, keyOf('ck', 3), 999)
      const lying = await fetch(keyOf('ck', 3))
      expect([lying.statusCode, lying.json().details?.reason]).toEqual([409, 'verify'])
      expect(h.ctx.jobs.list({}).filter((j) => j.kind === 'backup.fetch')).toEqual([])
    } finally {
      await h.t.close()
    }
  })

  it('starts a fetch into a held upload, verified when a manifest vouches for the file', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const id = (await admin.call('POST', '/api/backup-destinations', s3Body('Start', 'st'))).json().id
      put(keyOf('st', 1), 'vouched')
      put(`${keyOf('st', 1)}.json`, manifest(7))
      put(keyOf('st', 2), 'unvouched')
      // A manifest beyond the size limit is not trusted, however well formed.
      put(keyOf('st', 3), 'too big')
      put(`${keyOf('st', 3)}.json`, `${manifest(7)}${' '.repeat(70_000)}`)
      for (const n of [1, 2, 3]) {
        const res = await admin.call('POST', `/api/backup-destinations/${id}/backups/fetch`, {
          connectionId: h.ids.B,
          key: keyOf('st', n),
        })
        expect(res.statusCode, res.body).toBe(202)
        const { uploadId, job } = res.json()
        expect(typeof uploadId).toBe('string')
        expect(job).toMatchObject({ kind: 'backup.fetch', connectionId: h.ids.B })
        await waitJob(h.t, job.id, 30_000)
      }
      const started = audit(h, 'backup.fetch.start').map((r) => JSON.parse(r.details))
      expect(started.map((d) => [d.name, d.size, d.verified])).toEqual([
        [keyOf('', 1).split('/').at(-1), 7, true],
        [keyOf('', 2).split('/').at(-1), 9, false],
        [keyOf('', 3).split('/').at(-1), 7, false],
      ])
    } finally {
      await h.t.close()
    }
  }, 120_000)
})

describe('deleting a remote copy (spec §4.3)', () => {
  it('lets the sender or an administrator delete a complete copy, and nobody else', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const u = h.user({ on: { A: 'editor' } })
      const v = h.user({ on: { A: 'editor' } })
      const id = (await admin.call('POST', '/api/backup-destinations', s3Body('Remote', 'rm'))).json().id
      const elsewhere = (await admin.call('POST', '/api/backup-destinations', s3Body('Other', 'rm2'))).json()
        .id
      await grant(admin, id, [
        { userId: u.id, level: 'send' },
        { userId: v.id, level: 'browse' },
      ])
      for (const n of [1, 2, 3]) {
        put(keyOf('rm', n), `body-${n}`)
        put(`${keyOf('rm', n)}.json`, manifest(6))
      }
      const usCopy = copyOf(h, id, u.id, keyOf('rm', 1), 6)
      const adminsCopy = copyOf(h, id, admin.id, keyOf('rm', 2), 6)
      const sending = copyOf(h, id, u.id, keyOf('rm', 3), 6, 'sending')
      const del = (who: U, dest: string, copyId: string) =>
        who.call('DELETE', `/api/backup-destinations/${dest}/backups/${copyId}`)
      // Another user, even with browse rights, may not delete someone else's copy.
      expect((await del(v, id, usCopy.id)).statusCode).toBe(404)
      expect((await del(u, id, adminsCopy.id)).statusCode).toBe(404)
      // A copy is addressed through its own destination only.
      expect((await del(admin, elsewhere, usCopy.id)).statusCode).toBe(404)
      const unfinished = await del(u, id, sending.id)
      expect([unfinished.statusCode, unfinished.json().details?.reason]).toEqual([409, 'copy_incomplete'])
      expect(s3.objects.has(keyOf('rm', 1))).toBe(true)

      expect((await del(u, id, usCopy.id)).statusCode).toBe(204)
      expect(s3.objects.has(keyOf('rm', 1))).toBe(false)
      expect(s3.objects.has(`${keyOf('rm', 1)}.json`)).toBe(false)
      expect(h.ctx.backup.copies.get(usCopy.id)).toBeUndefined()
      expect((await del(u, id, usCopy.id)).statusCode).toBe(404)

      // The provider refusing the delete keeps the record, and says why.
      s3.failNext(1, 500)
      const refused = await del(admin, id, adminsCopy.id)
      expect(refused.statusCode).toBe(400)
      expect(refused.json().details?.reason).toBeTruthy()
      expect(h.ctx.backup.copies.get(adminsCopy.id)).toBeDefined()
      expect((await del(admin, id, adminsCopy.id)).statusCode).toBe(204)
      expect(s3.objects.has(keyOf('rm', 2))).toBe(false)
      expect(audit(h, 'backup.remote.delete').filter((r) => r.outcome === 'success')).toHaveLength(2)
    } finally {
      await h.t.close()
    }
  })
})

describe('retrying and discarding a copy (spec §4.2)', () => {
  async function sentCopy(h: H, u: U, dest: string) {
    const body = { scope: { kind: 'database', db: 'shop' }, format: 'mmbak', destinations: [dest] }
    const plan = (await u.call('POST', `/api/connections/${h.ids.A}/backup/plan`, body)).json()
    const res = await u.call('POST', `/api/connections/${h.ids.A}/backup`, {
      ...body,
      planHash: plan.planHash,
      password: 'correct horse battery',
    })
    expect(res.statusCode, res.body).toBe(202)
    await waitJob(h.t, res.json().job.id, 60_000)
    const report = (await u.get(`/api/transfer/jobs/${res.json().job.id}/report`)).json()
    expect((await waitJob(h.t, report.sendJobId, 60_000)).state).toBe('done')
    return h.ctx.backup.copies.byBackup(report.backupId)[0]!
  }

  it('retries only a failed copy of a backup still on the server, for its sender only', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const u = h.user({ on: { A: 'editor' } })
      const other = h.user({ on: { A: 'editor' } })
      const dir = join(base, 'root', 'retry')
      const id = (
        await admin.call('POST', '/api/backup-destinations', {
          type: 'folder',
          name: 'Retry',
          config: { path: dir },
        })
      ).json().id
      await grant(admin, id, [
        { userId: u.id, level: 'send' },
        { userId: other.id, level: 'send' },
      ])
      const copy = await sentCopy(h, u, id)
      const retry = (who: U, copyId: string) => who.call('POST', `/api/backup-copies/${copyId}/retry`)
      const done = await retry(u, copy.id)
      expect([done.statusCode, done.json().details?.reason]).toEqual([409, 'copy_not_failed'])
      // The send failed and its file is gone from the destination.
      h.ctx.backup.copies.fail(copy.id, 'network')
      rmSync(join(dir, ...copy.remoteKey.split('/')))
      expect((await retry(other, copy.id)).statusCode).toBe(404)
      expect((await retry(admin, copy.id)).statusCode).toBe(404)
      expect((await retry(u, nowhere())).statusCode).toBe(404)
      expect((await retry(u, 'not-a-uuid')).statusCode).toBe(400)
      const started = await retry(u, copy.id)
      expect(started.statusCode, started.body).toBe(202)
      expect((await waitJob(h.t, started.json().job.id, 60_000)).state).toBe('done')
      expect(h.ctx.backup.copies.get(copy.id)!.state).toBe('complete')
      expect(existsSync(join(dir, ...copy.remoteKey.split('/')))).toBe(true)
      // Without a grant on the destination the copy is no longer the user's to retry.
      h.ctx.backup.copies.fail(copy.id, 'again')
      await grant(admin, id, [{ userId: other.id, level: 'send' }])
      expect((await retry(u, copy.id)).statusCode).toBe(404)
      // A failed copy whose local backup is gone cannot be retried.
      const orphan = copyOf(h, id, other.id, keyOf('', 9), 1, 'failed')
      const gone = await retry(other, orphan.id)
      expect([gone.statusCode, gone.json().details?.reason]).toEqual([409, 'local_gone'])
    } finally {
      await h.t.close()
    }
  }, 240_000)

  it('discards only an unfinished copy of the caller, abandoning its partial upload', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const second = h.user({ role: 'admin' })
      const dir = join(base, 'root', 'discard')
      const id = (
        await admin.call('POST', '/api/backup-destinations', {
          type: 'folder',
          name: 'Discard',
          config: { path: dir },
        })
      ).json().id
      const discard = (who: U, copyId: string) => who.call('DELETE', `/api/backup-copies/${copyId}`)
      const complete = copyOf(h, id, admin.id, keyOf('', 1), 1)
      const res1 = await discard(admin, complete.id)
      expect([res1.statusCode, res1.json().details?.reason]).toEqual([409, 'copy_complete'])
      const sending = copyOf(h, id, admin.id, keyOf('', 2), 1, 'sending')
      const res2 = await discard(admin, sending.id)
      expect([res2.statusCode, res2.json().details?.reason]).toEqual([409, 'copy_sending'])

      const failed = copyOf(h, id, admin.id, keyOf('', 3), 1, 'failed')
      const partial = `${join(dir, ...keyOf('', 3).split('/'))}.partial`
      mkdirSync(dirname(partial), { recursive: true })
      writeFileSync(partial, 'half')
      h.ctx.backup.copies.setResume(failed.id, { key: keyOf('', 3) })
      // Even another administrator cannot discard someone else's copy.
      expect((await discard(second, failed.id)).statusCode).toBe(404)
      expect(existsSync(partial)).toBe(true)
      expect((await discard(admin, failed.id)).statusCode).toBe(204)
      expect(existsSync(partial)).toBe(false)
      expect(h.ctx.backup.copies.get(failed.id)).toBeUndefined()
      // Without a resume state there is nothing to abandon; the record still goes.
      const plain = copyOf(h, id, admin.id, keyOf('', 4), 1, 'failed')
      expect((await discard(admin, plain.id)).statusCode).toBe(204)
      expect(h.ctx.backup.copies.get(plain.id)).toBeUndefined()
      expect(audit(h, 'backup.copy.discard').filter((r) => r.outcome === 'success')).toHaveLength(2)
    } finally {
      await h.t.close()
    }
  })

  it('discards a failed copy even when the provider refuses to abort its upload', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const id = (await admin.call('POST', '/api/backup-destinations', s3Body('Abort', 'ab'))).json().id
      const uploadId = randomUUID()
      s3.uploads.set(uploadId, new Map())
      const failed = copyOf(h, id, admin.id, keyOf('ab', 1), 10, 'failed')
      h.ctx.backup.copies.setResume(failed.id, { uploadId, key: failed.remoteKey, parts: [] })
      s3.failNext(1, 500)
      expect((await admin.call('DELETE', `/api/backup-copies/${failed.id}`)).statusCode).toBe(204)
      expect(h.ctx.backup.copies.get(failed.id)).toBeUndefined()
      // The provider's own expiry of unfinished uploads applies to what could not be aborted.
      expect(s3.uploads.has(uploadId)).toBe(true)
      s3.uploads.delete(uploadId)
    } finally {
      await h.t.close()
    }
  })
})

describe('single-user mode (no sign-in)', () => {
  it('runs every destination route as the local owner, with no user id recorded anywhere', async () => {
    const h = await backupHarness(a, b, {
      auth: false,
      backup: { folderRoots: [join(base, 'root')], privateNetworks: ['127.0.0.1/32'] },
    } as never)
    h.ctx.backup.googleHosts = g.hosts
    try {
      const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
        h.t.app.inject({
          method,
          url,
          headers: { ...H, 'x-csrf-token': h.ctx.localCsrfToken },
          ...(payload ? { payload } : {}),
        })
      const created = await call('POST', '/api/backup-destinations', {
        ...s3Body('Local', 'lo'),
        policy: { encryptedOnly: false },
      })
      expect(created.statusCode, created.body).toBe(201)
      const id = created.json().id
      expect(h.ctx.backup.destinations.get(id)!.createdBy).toBeNull()
      expect(audit(h, 'backup.destination.policy')).toEqual([
        { outcome: 'success', details: JSON.stringify({ destination: id, encryptedOnly: false }) },
      ])
      put(keyOf('lo', 1), 'local copy')
      const copy = copyOf(h, id, 'local', keyOf('lo', 1), 10)
      const listed = (await call('GET', `/api/backup-destinations/${id}/backups`)).json().items
      expect(listed).toEqual([expect.objectContaining({ copyId: copy.id, mine: true, sender: 'local' })])
      const fetched = await call('POST', `/api/backup-destinations/${id}/backups/fetch`, {
        connectionId: h.ids.B,
        key: keyOf('lo', 1),
      })
      expect(fetched.statusCode, fetched.body).toBe(202)
      const job = await waitJob(h.t, fetched.json().job.id, 30_000)
      expect(job.userId).toBeNull()
      const start = await call('POST', '/api/backup-destinations/google/device', {
        clientId: CLIENT,
        clientSecret: 'client-secret-1',
      })
      g.device.answers.push('approved')
      expect(
        (await call('GET', `/api/backup-destinations/google/device/${start.json().flowId}`)).json(),
      ).toEqual({
        state: 'approved',
        account: 'ops@example.com',
      })
      const connect = h.ctx.store.db
        .prepare("SELECT user_id FROM audit_log WHERE action = 'backup.destination.connect'")
        .all() as Array<{ user_id: string | null }>
      expect(connect).toEqual([{ user_id: null }])
      expect((await call('DELETE', `/api/backup-destinations/${id}/backups/${copy.id}`)).statusCode).toBe(204)
      expect(s3.objects.has(keyOf('lo', 1))).toBe(false)
    } finally {
      await h.t.close()
    }
  }, 60_000)
})
