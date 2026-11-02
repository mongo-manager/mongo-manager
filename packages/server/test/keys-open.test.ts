import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createZstdCompress } from 'node:zlib'
import { MongoClient } from 'mongodb'
import { ConnectionSettingsSchema } from '@mongo-manager/shared'
import { encryptMmbak } from '../src/backup/mmbak'
import { confirmedKey, teamApp, type Caller } from './support/schedules'
import { backupHarness } from './support/backup'
import { startMongo, type TestMongo } from './support/mongo'
import { waitJob } from './support/jobs'
import { slow } from './support/slowness'

const ARCHIVE = readFileSync(join(__dirname, 'fixtures/backup/shop.archive'))
const PW = 'correct horse battery staple'
async function mmbak(opts: {
  password?: string
  serverKey?: { keyId: string; key: Buffer }
}): Promise<Buffer> {
  const parts: Buffer[] = []
  const z = Readable.from([ARCHIVE]).pipe(createZstdCompress())
  for await (const p of encryptMmbak(z as AsyncIterable<Buffer>, {
    ...opts,
    chunkBytes: 64 * 1024,
    tool: { name: 'mongo-manager', version: 'test' },
    now: 1,
  }))
    parts.push(p)
  return Buffer.concat(parts)
}
async function upload(u: Pick<Caller, 'call' | 'raw'>, file: Buffer): Promise<string> {
  const created = await u.call('POST', '/api/backups/uploads', { name: 'nightly.mmbak', size: file.length })
  if (created.statusCode !== 201) throw new Error(created.body)
  const id = created.json().uploadId as string
  const put = await u.raw('PUT', `/api/backups/uploads/${id}?offset=0`, file)
  if (!put.json().complete) throw new Error(put.body)
  return id
}
const inspect = (u: Pick<Caller, 'call'>, uploadId: string, extra: object = {}) =>
  u.call('POST', '/api/backups/inspect', { source: { kind: 'upload', uploadId }, ...extra })

/** Uploads need documents:write on some connection (3d-3a plan ruling 4): one that is never reached. */
async function app() {
  const h = await teamApp()
  h.ctx.connections.create(
    {
      name: 'Somewhere',
      favorite: false,
      readOnly: false,
      settings: ConnectionSettingsSchema.parse({ hosts: [{ host: '127.0.0.1', port: 1 }] }),
    },
    null,
  )
  return h
}

describe('opening backup-key files (phase 3d-3c spec §1.1, §2, D3)', () => {
  it('opens a file made with one of the caller’s keys without a password, and says with which', async () => {
    const { t, user } = await app()
    try {
      const u = user()
      const k = await confirmedKey(u)
      const id = await upload(u, await mmbak({ serverKey: { keyId: k.id, key: k.key } }))
      const res = await inspect(u, id)
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json()).toMatchObject({
        state: 'ready',
        openedWith: { kind: 'key', fingerprint: k.fingerprint, name: 'Key 1' },
        summary: { container: 'mmbak' },
      })
      expect(JSON.stringify(res.json().summary.namespaces)).toContain('orders')
    } finally {
      await t.close()
    }
  })

  it('opens a backup made with a retired key, and refuses another key’s kit (D3)', async () => {
    const { t, user } = await app()
    try {
      const u = user()
      const first = await confirmedKey(u)
      const file = await mmbak({ serverKey: { keyId: first.id, key: first.key } })
      const second = await confirmedKey(u)
      const id = await upload(u, file)
      expect((await inspect(u, id)).json()).toMatchObject({ state: 'ready', openedWith: { name: 'Key 1' } })
      // Elsewhere (another account), the right kit opens it and the other key's kit does not.
      const other = user()
      const there = await upload(other, file)
      const wrong = await inspect(other, there, { kit: second.kit })
      expect(wrong.statusCode).toBe(400)
      expect(wrong.json().details.reason).toBe('backup_key')
      expect((await inspect(other, there, { kit: first.kit })).json()).toMatchObject({
        state: 'ready',
        openedWith: { kind: 'kit', fingerprint: first.fingerprint },
      })
    } finally {
      await t.close()
    }
  })

  it('asks anyone else for the kit, never trying their own keys on it — administrators included (D3)', async () => {
    const { t, user } = await app()
    try {
      const owner = user()
      const k = await confirmedKey(owner)
      const file = await mmbak({ serverKey: { keyId: k.id, key: k.key } })
      for (const someone of [user(), user('admin')]) {
        await confirmedKey(someone)
        const id = await upload(someone, file)
        expect((await inspect(someone, id)).json()).toEqual({
          state: 'key',
          fingerprint: k.fingerprint,
          password: false,
        })
      }
    } finally {
      await t.close()
    }
  })

  it('asks for the password or the kit of a file with both slots, and refuses a malformed kit in words', async () => {
    const { t, user } = await app()
    try {
      const owner = user()
      const k = await confirmedKey(owner)
      const other = user()
      const id = await upload(other, await mmbak({ password: PW, serverKey: { keyId: k.id, key: k.key } }))
      expect((await inspect(other, id)).json()).toEqual({
        state: 'key',
        fingerprint: k.fingerprint,
        password: true,
      })
      expect((await inspect(other, id, { password: PW })).json()).toMatchObject({
        state: 'ready',
        openedWith: { kind: 'password' },
      })
      const bad = await inspect(other, id, { kit: 'MMKEY1-AAAA' })
      expect(bad.statusCode).toBe(400)
      expect(bad.json().details.reason).toBe('kit_format')
    } finally {
      await t.close()
    }
  })
})

describe('restoring a backup-key file (phase 3d-3c spec §5)', () => {
  let a: TestMongo
  let b: TestMongo
  let cb: MongoClient
  beforeAll(async () => {
    ;[a, b] = await Promise.all([startMongo(), startMongo()])
    cb = await new MongoClient(`mongodb://127.0.0.1:${b.port}`).connect()
  }, slow(180_000))
  afterAll(async () => {
    await cb?.close()
    await Promise.all([a?.stop(), b?.stop()])
  })

  it('restores with the caller’s key, and on another account with the kit', async () => {
    const h = await backupHarness(a, b)
    try {
      const u = h.user({ on: { B: 'editor' } })
      const k = await confirmedKey(u)
      const file = await mmbak({ serverKey: { keyId: k.id, key: k.key } })
      const restore = async (caller: typeof u, db: string, extra: object) => {
        const id = await upload(caller, file)
        const body = {
          source: { kind: 'upload', uploadId: id },
          mapping: [{ from: { db: 'shop', coll: 'orders' }, to: { db, coll: 'orders' } }],
          // The harness's shop.orders has a TTL index: a restore confirms it (3d-3a U7).
          confirmTtl: true,
          ...extra,
        }
        const plan = await caller.call('POST', `/api/connections/${h.ids.B}/restore/plan`, body)
        if (plan.statusCode !== 200) return plan
        const start = await caller.call('POST', `/api/connections/${h.ids.B}/restore`, {
          ...body,
          planHash: plan.json().planHash,
        })
        expect(start.statusCode, start.body).toBe(202)
        expect((await waitJob(h.t, start.json().job.id, 60_000)).state).toBe('done')
        return start
      }
      await restore(u, 'shop_key', {})
      expect(await cb.db('shop_key').collection('orders').countDocuments()).toBeGreaterThan(0)
      const other = h.user({ on: { B: 'editor' } })
      const refused = await restore(other, 'shop_kit', {})
      expect(refused.statusCode).toBe(400)
      expect(refused.json().details).toMatchObject({
        reason: 'backup_key_needed',
        fingerprint: k.fingerprint,
      })
      await restore(other, 'shop_kit', { kit: k.kit })
      expect(await cb.db('shop_kit').collection('orders').countDocuments()).toBeGreaterThan(0)
    } finally {
      await h.t.close()
    }
  }, 180_000)
})
