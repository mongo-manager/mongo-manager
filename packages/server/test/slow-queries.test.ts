import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { MongoClient } from 'mongodb'
import { ConnectionSettingsSchema, type Role } from '@mongo-manager/shared'
import {
  commandText,
  fromProfile,
  isOwnCommand,
  parseSlowLog,
  MAX_LOG_LINES,
} from '../src/monitor/slow-queries'
import { startMongo, type TestMongo } from './support/mongo'
import { H, makeApp, type TestApp } from './helpers'
import { slow } from './support/slowness'

/**
 * Phase 3b spec §3.2: slow operations from system.profile and the server log, merged, with the
 * command redacted for everyone and masked for a restricted user.
 */
describe('the server log parser (phase 3b §3.2)', () => {
  const line = (attr: object, id = 51803) =>
    JSON.stringify({ t: { $date: '2026-09-30T10:00:00.000+03:00' }, id, msg: 'Slow query', attr })

  it('knows our own reads by the comment of the command that opened a cursor (final review M8)', () => {
    const [log] = parseSlowLog([
      line({
        ns: 'crm.system.profile',
        type: 'command',
        command: { getMore: 1, collection: 'system.profile' },
        originatingCommand: { find: 'system.profile', comment: 'mm-monitor' },
        durationMillis: 5,
      }),
    ])
    expect(log!.own).toBe(true)
    const profiled = fromProfile({
      ns: 'crm.system.profile',
      op: 'getmore',
      millis: 5,
      command: { getMore: 1, collection: 'system.profile' },
      originatingCommand: { find: 'system.profile', comment: 'mm-monitor' },
    })
    expect(profiled.own).toBe(true)
    expect(
      fromProfile({ ns: 'crm.users', op: 'query', millis: 5, command: { find: 'users', comment: 'mm:r1' } })
        .own,
    ).toBe(false)
  })

  it('treats every monitoring comment as our own, and a request through the app as the user work (final review M7)', () => {
    expect(isOwnCommand({ comment: 'mm-monitor' })).toBe(true)
    expect(isOwnCommand({ comment: 'mm-monitor:ops' })).toBe(true)
    expect(isOwnCommand({ comment: 'mm:req-1' })).toBe(false)
    expect(isOwnCommand({ comment: 'mm-job:1' })).toBe(false)
    expect(isOwnCommand({ comment: 'mm-monitoring' })).toBe(false)
  })

  it('keeps slow queries, skips other ids, bad JSON and over-long lines', () => {
    const entries = parseSlowLog([
      line({
        ns: 'crm.users',
        type: 'command',
        command: { find: 'users', filter: { email: 'a@x' } },
        durationMillis: 250,
        planSummary: 'COLLSCAN',
        docsExamined: 1000,
        nreturned: 1,
      }),
      line({ ns: 'x.y' }, 12345),
      '{not json',
      line({ ns: 'crm.users', command: { find: 'users', pad: 'x'.repeat(70 * 1024) }, durationMillis: 1 }),
    ])
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      source: 'log',
      ts: '2026-09-30T07:00:00.000Z',
      ns: 'crm.users',
      op: 'query',
      durationMs: 250,
      planSummary: 'COLLSCAN',
      docsExamined: 1000,
      nreturned: 1,
    })
  })

  it('keeps an entry whose command holds a value JavaScript cannot represent', () => {
    const [entry] = parseSlowLog([
      line({
        ns: 'crm.users',
        command: { find: 'users', filter: { d: { $date: 'not a date' } } },
        durationMillis: 3,
      }),
    ])
    expect(entry).toMatchObject({ ns: 'crm.users', durationMs: 3 })
    // Shown without failing the list.
    expect(() => commandText(entry!.command)).not.toThrow()
    expect(commandText(entry!.command)).toContain('"find":"users"')
  })

  it('takes the kind of an update or a delete from the line (final review I2)', () => {
    const [update] = parseSlowLog([
      line({ ns: 'a.b', type: 'update', command: { q: { x: 1 }, u: { $set: { y: 1 } } }, durationMillis: 1 }),
    ])
    const [remove] = parseSlowLog([
      line({ ns: 'a.b', type: 'remove', command: { q: { x: 1 }, limit: 1 }, durationMillis: 1 }),
    ])
    expect(update!.op).toBe('update')
    expect(remove!.op).toBe('remove')
  })

  it('names operations as the profiler does', () => {
    const op = (command: object) => parseSlowLog([line({ ns: 'a.b', command, durationMillis: 1 })])[0]!.op
    expect(op({ find: 'b' })).toBe('query')
    expect(op({ delete: 'b' })).toBe('remove')
    expect(op({ getMore: 1 })).toBe('getmore')
    expect(op({ aggregate: 'b' })).toBe('command')
  })

  it(`reads at most ${MAX_LOG_LINES} lines and survives a non-array`, () => {
    expect(parseSlowLog('nope')).toEqual([])
    const many = Array.from({ length: 2000 }, () =>
      line({ ns: 'a.b', command: { find: 'b' }, durationMillis: 5 }),
    )
    expect(parseSlowLog(many)).toHaveLength(MAX_LOG_LINES)
  })
})

let mongo: TestMongo
let client: MongoClient
beforeAll(async () => {
  mongo = await startMongo()
  client = await new MongoClient(`mongodb://127.0.0.1:${mongo.port}`).connect()
  const users = client.db('crm').collection('users')
  await users.insertMany(Array.from({ length: 50 }, (_, i) => ({ email: `u${i}@x`, n: i })))
  // Level 2 with slowms 0: every operation is profiled on crm, and every one is logged.
  await client.db('crm').command({ profile: 2, slowms: 0 })
  await users.find({ email: 'secret@x' }).toArray()
  // The shapes the final review found leaking (C1, C2, C6, I1): as MongoDB really reports them.
  await users.updateOne({ email: 'upd@x' }, { $set: { n: 1 } })
  await users.deleteOne({ email: 'del@x' })
  const many = Array.from({ length: 3000 }, (_, i) => `trunc${i}@x.example`)
  await users.find({ email: { $in: many } }).toArray()
  await client
    .db('crm')
    .collection('orders')
    .aggregate([
      { $lookup: { from: 'users', localField: 'u', foreignField: '_id', as: 'u' } },
      { $match: { 'u.email': 'join@x' } },
    ])
    .toArray()
  await users.find({ username: 'bob', password: 'hunter2' }).toArray()
}, slow(120_000))
afterAll(async () => {
  await client?.db('crm').command({ profile: 0, slowms: 100 })
  await client?.close()
  await mongo?.stop()
})
const apps: TestApp[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})

async function setup() {
  const t = await makeApp({ auth: true })
  apps.push(t)
  const { ctx } = t.app
  const connectionId = ctx.connections.create(
    {
      name: 'M',
      favorite: false,
      readOnly: false,
      settings: ConnectionSettingsSchema.parse({ hosts: [{ host: '127.0.0.1', port: mongo.port }] }),
    },
    null,
  ).id
  ctx.personalFields.set(connectionId, [{ db: 'crm', coll: 'users', field: 'email' }])
  const as = (role: Role, masked = false) => {
    const user = ctx.users.create({ username: `u-${Math.random()}`, passwordHash: 'x', role })
    ctx.grants.set(connectionId, user.id, role)
    if (masked) ctx.grants.setMasked(connectionId, user.id, true)
    const s = ctx.sessions.create(user.id, {})
    return (path: string) =>
      t.app.inject({
        method: 'GET',
        url: `/api/connections/${connectionId}/server/${path}`,
        headers: { ...H, 'x-csrf-token': s.session.csrfToken },
        cookies: { mm_sid: s.sessionId },
      })
  }
  return { as }
}

type Entry = { source: string; ns: string; op: string; command: string; origin?: unknown; ts: string }

describe('slow queries (phase 3b §3.2)', () => {
  it('lists profile entries with the command, and an origin to open', async () => {
    const { as } = await setup()
    const res = (await as('editor')('slow-queries?db=crm&source=profile&op=query')).json() as {
      entries: Entry[]
    }
    const hit = res.entries.find((e) => e.command.includes('secret@x'))!
    expect(hit).toMatchObject({ source: 'profile', ns: 'crm.users', op: 'query' })
    expect(hit.origin).toMatchObject({
      kind: 'find',
      db: 'crm',
      coll: 'users',
      filter: { email: 'secret@x' },
    })
    expect(Number.isNaN(Date.parse(hit.ts))).toBe(false)
  })

  it('merges the server log, newest first', async () => {
    const { as } = await setup()
    const res = (await as('editor')('slow-queries?db=crm&coll=users&source=both')).json() as {
      entries: Entry[]
    }
    expect(res.entries.some((e) => e.source === 'log' && e.command.includes('secret@x'))).toBe(true)
    const times = res.entries.map((e) => e.ts)
    expect([...times].sort().reverse()).toEqual(times)
  })

  it('a restricted user gets no origin and no value, in entries or errors (review focus 2)', async () => {
    const { as } = await setup()
    const res = await as('editor', true)('slow-queries?db=crm&source=both')
    expect(res.body).not.toContain('secret@x')
    const entries = res.json().entries as Entry[]
    expect(entries.some((e) => e.command.includes('***'))).toBe(true)
    expect(entries.every((e) => e.origin === undefined)).toBe(true)
  })

  // Index advice gaps (2026-10-27): each entry says its shape, with no value, the same for everyone.
  it('gives each entry its shape, without a value, alike for a restricted user', async () => {
    const { as } = await setup()
    const shapes = async (masked: boolean) =>
      (
        (await as('editor', masked)('slow-queries?db=crm&coll=users&source=profile&op=query')).json() as {
          entries: Array<Entry & { shape: string }>
        }
      ).entries.map((e) => e.shape)
    const plain = await shapes(false)
    expect(plain).toContain('find {"filter":{"email":"?"}}')
    expect(plain.join(' ')).not.toContain('secret@x')
    expect(await shapes(true)).toEqual(plain)
  })

  it('hides updates, deletes, truncated commands and joins from a restricted user (final review C1, C2, C6, I4)', async () => {
    const { as } = await setup()
    const full = await as('editor')('slow-queries?db=crm&source=both')
    // The shapes are really there for someone who may see them...
    for (const value of ['upd@x', 'del@x', 'join@x']) expect(full.body).toContain(value)
    const res = await as('editor', true)('slow-queries?db=crm&source=both')
    // ...and never reach a restricted user, from either source.
    for (const value of ['upd@x', 'del@x', 'trunc1@x.example', 'join@x'])
      expect(res.body).not.toContain(value)
  })

  it('never hands out a secret through the Explain origin (final review I1)', async () => {
    const { as } = await setup()
    const res = await as('editor')('slow-queries?db=crm&coll=users&source=profile')
    expect(res.body).not.toContain('hunter2')
    const entry = (res.json().entries as Entry[]).find((e) => e.command.includes('"username":"bob"'))!
    expect(entry.origin).toBeUndefined()
  })

  it("leaves Mongo Manager's own reads of the profiler out", async () => {
    const { as } = await setup()
    await as('editor')('slow-queries?db=crm&source=profile')
    const res = (await as('editor')('slow-queries?db=crm&source=both&limit=200')).json() as {
      entries: Entry[]
    }
    expect(res.entries.some((e) => e.ns === 'crm.system.profile' || e.command.includes('mm-monitor'))).toBe(
      false,
    )
  })

  it('reports a source it cannot read without hiding the other', async () => {
    const { as } = await setup()
    const res = (await as('editor')('slow-queries?source=both')).json() as {
      entries: Entry[]
      refused: Record<string, string>
    }
    // No db: the profile source cannot run; the log still answers.
    expect(res.refused.profile).toBe('no_db')
    expect(res.entries.length).toBeGreaterThan(0)
  })

  it('validates its query and hides credential collections from non-admins', async () => {
    const { as } = await setup()
    for (const bad of ['limit=500', 'db=a.b', 'op=eval', 'minMs=-1', 'source=disk'])
      expect((await as('editor')(`slow-queries?${bad}`)).statusCode, bad).toBe(400)
    await client.db('admin').command({ usersInfo: 1 })
    const res = (await as('editor')('slow-queries?source=log')).json() as { entries: Entry[] }
    expect(res.entries.every((e) => !/\.system\.(users|roles|keys)/.test(e.ns))).toBe(true)
    expect((await as('viewer')('slow-queries?source=log')).statusCode).toBe(403)
  })
})
