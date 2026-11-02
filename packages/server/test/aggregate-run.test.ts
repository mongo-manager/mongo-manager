import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Collection, type MongoClient } from 'mongodb'
import type { RunLine } from '@mongo-manager/shared'
import { startMongo, type TestMongo } from './support/mongo'
import { dataHarness, teamHarness, type DataHarness } from './support/data'
import { H } from './helpers'
import { slow } from './support/slowness'

let mongo: TestMongo
beforeAll(async () => {
  mongo = await startMongo({ args: ['--setParameter', 'enableTestCommands=1'] })
})
afterAll(async () => {
  await mongo?.stop()
})
const closers: Array<{ t: { close(): Promise<void> } }> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const h of closers.splice(0)) await h.t.close()
})

async function local(extra: Parameters<typeof dataHarness>[2] = {}): Promise<DataHarness> {
  const h = await dataHarness(mongo, {}, extra)
  closers.push(h)
  return h
}

async function seed(h: { client(): Promise<MongoClient> }, count = 50) {
  const db = `d${randomUUID().slice(0, 8)}`
  const client = await h.client()
  const docs = Array.from({ length: count }, (_, n) => ({ n, g: n % 3 }))
  for (let i = 0; i < docs.length; i += 10_000)
    await client
      .db(db)
      .collection('items')
      .insertMany(docs.slice(i, i + 10_000))
  return { db, client, base: `/databases/${db}/collections/items/aggregate` }
}

const lines = (body: string) =>
  body
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as RunLine)

describe('streamed run (phase 2a spec §3.2)', () => {
  it('streams one line per document, then the end, running the pipeline once', async () => {
    const h = await local()
    const { base } = await seed(h, 30)
    const original = Collection.prototype.aggregate
    const spy = vi.spyOn(Collection.prototype, 'aggregate').mockImplementation(function (
      this: Collection,
      ...args
    ) {
      return original.apply(this, args as never)
    } as typeof original)
    const res = await h.call('POST', `${base}/run`, { stages: [{ $sort: { n: 1 } }], limit: 10 })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.headers['content-type']).toMatch(/application\/x-ndjson/)
    expect(res.headers['cache-control']).toBe('no-store')
    const out = lines(res.body)
    expect(out).toHaveLength(11)
    expect(out.at(-1)).toMatchObject({ end: { count: 10, truncated: true } })
    expect(spy).toHaveBeenCalledTimes(1)
    const all = lines((await h.call('POST', `${base}/run`, { stages: [{ $match: {} }], limit: 100 })).body)
    expect(all.at(-1)).toMatchObject({ end: { count: 30, truncated: false } })
  })

  it('keeps BSON types exact on the wire, and the security headers on the stream', async () => {
    const h = await local()
    const { base } = await seed(h, 1)
    const res = await h.call('POST', `${base}/run`, {
      stages: [{ $project: { _id: 1, big: { $toLong: '$n' } } }],
    })
    const [first] = lines(res.body) as Array<{ document: Record<string, unknown> }>
    expect(first!.document).toMatchObject({ _id: { $oid: expect.any(String) }, big: { $numberLong: '0' } })
    expect(res.headers['content-security-policy']).toContain("default-src 'self'")
    expect(res.headers['x-frame-options']).toBe('DENY')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
  })

  it('stops at the output cap, saying so', async () => {
    const h = await local({ aggregation: { maxRunBytes: 1024 } })
    const { base } = await seed(h, 200)
    const out = lines((await h.call('POST', `${base}/run`, { stages: [{ $match: {} }] })).body)
    const end = out.at(-1) as { end: { count: number; truncated: boolean; bytes: number } }
    expect(end.end.truncated).toBe(true)
    expect(end.end.count).toBeLessThan(200)
    expect(end.end.bytes).toBeLessThanOrEqual(1024 + 200)
  })

  it('answers an error before the first document as an HTTP error', async () => {
    const h = await local()
    const { base } = await seed(h, 3)
    const res = await h.call('POST', `${base}/run`, { stages: [{ $project: { a: { $bogus: 1 } } }] })
    expect(res.statusCode).toBeGreaterThanOrEqual(400)
    expect(res.json().message).toContain('$bogus')
  })

  it('ends with an error line when MongoDB fails in the middle of the stream', async () => {
    const h = await local()
    const { base, client, db } = await seed(h, 0)
    await client
      .db(db)
      .collection('items')
      .insertMany([...Array.from({ length: 4 }, (_, n) => ({ n, v: String(n) })), { n: 9, v: 'x' }])
    const res = await h.call('POST', `${base}/run`, {
      stages: [{ $sort: { n: 1 } }, { $project: { i: { $toInt: '$v' } } }],
      batchSize: 1,
    })
    const out = lines(res.body)
    expect(out.filter((l) => 'document' in l)).toHaveLength(4)
    expect(out.at(-1)).toMatchObject({ error: { code: expect.any(String) } })
  })

  it('refuses a write pipeline: that is the write route', async () => {
    const h = await local()
    const { base } = await seed(h, 1)
    expect((await h.call('POST', `${base}/run`, { stages: [{ $out: 'x' }] })).statusCode).toBe(400)
  })
})

describe('a stream the client leaves (Review Focus 3)', () => {
  async function open(h: DataHarness, path: string, body: object, controller: AbortController) {
    const { port } = h.t.app.server.address() as { port: number }
    return fetch(`http://127.0.0.1:${port}/api/connections/${h.connectionId}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': h.t.app.ctx.localCsrfToken,
        cookie: H.cookie,
        'x-mm-local': H['x-mm-local'],
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  }

  it('closes the cursor and frees the run slot when the client goes away', async () => {
    const h = await local()
    const { base, client } = await seed(h, 20_000)
    await h.t.app.listen({ port: 0, host: '127.0.0.1' })
    const marker = randomUUID()
    const body = { stages: [{ $match: { marker: { $ne: marker } } }], limit: 10_000, batchSize: 1 }
    const controller = new AbortController()
    const res = await open(h, `${base}/run`, body, controller)
    expect(res.status).toBe(200)
    const reader = res.body!.getReader()
    await reader.read()
    controller.abort()
    const cursors = () =>
      client
        .db('admin')
        .aggregate([
          { $currentOp: { allUsers: true, idleCursors: true } },
          { $match: { 'cursor.originatingCommand.pipeline.0.$match.marker.$ne': marker } },
        ])
        .toArray()
    await vi.waitFor(async () => expect(await cursors()).toEqual([]), { timeout: 5_000 })
    // Both slots are free again: two more runs by the same user are admitted.
    for (let i = 0; i < 2; i++) {
      const again = await h.call('POST', `${base}/run`, { stages: [{ $limit: 1 }] })
      expect(again.statusCode).toBe(200)
    }
  })

  it(
    'frees the run slot when the client leaves before the first document (final review 2a, C1)',
    async () => {
      const h = await local()
      const { base, client } = await seed(h, 10)
      await h.t.app.listen({ port: 0, host: '127.0.0.1' })
      const admin = client.db('admin')
      // Every aggregate waits 1.5 s before answering (the kill's $currentOp too): the client leaves
      // while the first read waits.
      await admin.command({
        configureFailPoint: 'failCommand',
        mode: 'alwaysOn',
        data: { failCommands: ['aggregate'], blockConnection: true, blockTimeMS: 1_500 },
      })
      try {
        for (let i = 0; i < 2; i++) {
          const controller = new AbortController()
          const pending = open(h, `${base}/run`, { stages: [{ $match: {} }] }, controller).catch(
            () => 'aborted',
          )
          await new Promise((r) => setTimeout(r, 300))
          controller.abort()
          expect(await pending).toBe('aborted')
        }
        // Independent review of the security pass (I2): an abandoned run keeps its slot until its
        // read really ended, so a third one meanwhile is refused — never a run with no slot.
        expect((await h.call('POST', `${base}/run`, { stages: [{ $limit: 1 }] })).statusCode).toBe(429)
        await new Promise((r) => setTimeout(r, 2_000))
      } finally {
        await admin.command({ configureFailPoint: 'failCommand', mode: 'off' })
      }
      // Three abandoned runs: without the fix, the 2 slots were gone for good.
      for (let i = 0; i < 2; i++) {
        const again = await h.call('POST', `${base}/run`, { stages: [{ $limit: 1 }] })
        expect(again.statusCode).toBe(200)
      }
    },
    slow(20_000),
  )

  it('admits at most 2 runs at a time per user', async () => {
    const h = await local()
    const { base } = await seed(h, 20_000)
    await h.t.app.listen({ port: 0, host: '127.0.0.1' })
    const body = { stages: [{ $match: {} }], limit: 10_000, batchSize: 1 }
    const controllers = [new AbortController(), new AbortController()]
    try {
      const held = await Promise.all(controllers.map((c) => open(h, `${base}/run`, body, c)))
      expect(held.map((r) => r.status)).toEqual([200, 200])
      const third = await h.call('POST', `${base}/run`, body)
      expect(third.statusCode).toBe(429)
    } finally {
      for (const c of controllers) c.abort()
    }
  })
})

describe('count (phase 2a spec §3.2)', () => {
  it('counts the pipeline output on demand, and refuses a write pipeline', async () => {
    const h = await local()
    const { base } = await seed(h)
    const res = await h.call('POST', `${base}/count`, { stages: [{ $match: { g: 1 } }] })
    expect(res.json()).toEqual({ count: 17 })
    expect((await h.call('POST', `${base}/count`, { stages: [{ $match: { g: 7 } }] })).json()).toEqual({
      count: 0,
    })
    expect((await h.call('POST', `${base}/count`, { stages: [{ $out: 'x' }] })).statusCode).toBe(400)
  })
})

describe('$out and $merge (phase 2a spec §3.2)', () => {
  it('writes once after a preview, and audits the target', async () => {
    const h = await local()
    const { base, client, db } = await seed(h)
    const stages = [{ $match: { g: 1 } }, { $out: 'copy' }]
    const preview = await h.call('POST', `${base}/write-preview`, { stages })
    expect(preview.statusCode, preview.body).toBe(200)
    expect(preview.json()).toMatchObject({
      target: { db, coll: 'copy' },
      stage: '$out',
      exists: false,
      estimatedCount: null,
      confirmRequired: false,
    })
    const res = await h.call('POST', `${base}/write`, { stages, token: preview.json().token })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toEqual({ ok: true, target: { db, coll: 'copy' } })
    expect(await client.db(db).collection('copy').countDocuments()).toBe(17)
    const [row] = h.t.app.ctx.audit.list({ limit: 5 }).filter((r) => r.action === 'aggregation.write')
    expect(row).toMatchObject({ outcome: 'success', namespace: `${db}.items` })
    expect(row!.details).toMatchObject({ target: `${db}.copy`, stage: '$out' })
  })

  it('runs a write with a 30-minute limit, not tied to the page that asked (final review 2a, I7)', async () => {
    const h = await local()
    const { base } = await seed(h)
    const stages = [{ $match: {} }, { $merge: { into: 'merged' } }]
    const { token } = (await h.call('POST', `${base}/write-preview`, { stages })).json()
    const original = Collection.prototype.aggregate
    const options: unknown[] = []
    vi.spyOn(Collection.prototype, 'aggregate').mockImplementation(function (this: Collection, ...args) {
      options.push(args[1])
      return original.apply(this, args as never)
    } as typeof original)
    expect((await h.call('POST', `${base}/write`, { stages, token })).statusCode).toBe(200)
    // A comment the disconnect kill (mm:<request id>) never matches: a stopped $merge leaves a
    // partly merged target, so a closed tab must not stop it.
    expect(options.at(-1)).toMatchObject({
      maxTimeMS: 1_800_000,
      comment: expect.stringMatching(/^mm-write:/),
    })
  })

  it('asks for the target name before $out replaces a collection', async () => {
    const h = await local()
    const { base, client, db } = await seed(h)
    await client.db(db).collection('copy').insertOne({ old: true })
    const stages = [{ $match: {} }, { $out: 'copy' }]
    const preview = (await h.call('POST', `${base}/write-preview`, { stages })).json()
    expect(preview).toMatchObject({ exists: true, estimatedCount: 1, confirmRequired: true })
    const without = await h.call('POST', `${base}/write`, { stages, token: preview.token })
    expect(without.statusCode).toBe(400)
    expect(await client.db(db).collection('copy').countDocuments({ old: true })).toBe(1)
    const typed = await h.call('POST', `${base}/write`, { stages, token: preview.token, confirm: 'copy' })
    expect(typed.statusCode).toBe(200)
    expect(await client.db(db).collection('copy').countDocuments()).toBe(50)
  })

  it('refuses a token for another pipeline, another user, an old one, or none', async () => {
    const h = await teamHarness(mongo)
    closers.push(h)
    const { base } = await seed(h)
    const [a, b] = [h.user('editor'), h.user('editor')]
    const stages = [{ $match: {} }, { $merge: { into: 'm' } }]
    const { token } = (await a.call('POST', `${base}/write-preview`, { stages })).json()
    const changed = await a.call('POST', `${base}/write`, { stages: [{ $limit: 1 }, stages[1]], token })
    expect([changed.statusCode, changed.json().details?.reason]).toEqual([409, 'preview_changed'])
    const other = await b.call('POST', `${base}/write`, { stages, token })
    expect([other.statusCode, other.json().details?.reason]).toEqual([409, 'preview_changed'])
    expect((await a.call('POST', `${base}/write`, { stages })).statusCode).toBe(400)
    expect((await a.call('POST', `${base}/write`, { stages, token: 'forged.token' })).statusCode).toBe(409)
    h.t.clock.now += 10 * 60_000 + 1
    const old = await a.call('POST', `${base}/write`, { stages, token })
    expect([old.statusCode, old.json().details?.reason]).toEqual([409, 'preview_expired'])
  })

  it('keeps writes from viewers and read-only connections; viewers still run reads', async () => {
    const h = await teamHarness(mongo)
    closers.push(h)
    const { base } = await seed(h)
    const viewer = h.user('viewer')
    const stages = [{ $out: 'copy' }]
    expect((await viewer.call('POST', `${base}/write-preview`, { stages })).statusCode).toBe(403)
    expect((await viewer.call('POST', `${base}/run`, { stages: [{ $limit: 1 }] })).statusCode).toBe(200)
    const ro = await teamHarness(mongo, {}, { readOnly: true })
    closers.push(ro)
    const { base: roBase } = await seed(ro)
    const editor = ro.user('editor')
    const refused = await editor.call('POST', `${roBase}/write-preview`, { stages })
    expect([refused.statusCode, refused.json().code]).toEqual([403, 'READ_ONLY'])
    const write = await editor.call('POST', `${roBase}/write`, { stages, token: 'x.y' })
    expect([write.statusCode, write.json().code]).toEqual([403, 'READ_ONLY'])
  })

  it('never takes a bulk preview token for a write, nor the other way round', async () => {
    const h = await local()
    const { base, db } = await seed(h)
    const coll = `/databases/${db}/collections/items`
    const bulk = (
      await h.call('POST', `${coll}/bulk/preview`, { operation: 'delete', filter: { g: 1 } })
    ).json()
    const stages = [{ $out: 'copy' }]
    const res = await h.call('POST', `${base}/write`, { stages, token: bulk.filterHash })
    expect([res.statusCode, res.json().details?.reason]).toEqual([409, 'preview_invalid'])
    const { token } = (await h.call('POST', `${base}/write-preview`, { stages })).json()
    const back = await h.call('POST', `${coll}/bulk/execute`, {
      operation: 'delete',
      filter: { g: 1 },
      filterHash: token,
    })
    expect([back.statusCode, back.json().details?.reason]).toEqual([409, 'preview_invalid'])
  })

  it('refuses a read pipeline on the write routes', async () => {
    const h = await local()
    const { base } = await seed(h)
    expect((await h.call('POST', `${base}/write-preview`, { stages: [{ $match: {} }] })).statusCode).toBe(400)
  })
})
