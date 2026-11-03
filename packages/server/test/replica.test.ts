import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Collection, Db, type Document } from 'mongodb'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { ConnectionSettingsSchema, parseConnectionUri, type Role } from '@mongo-manager/shared'
import { startMongo, type TestMongo } from './support/mongo'
import { H, makeApp, type TestApp } from './helpers'
import { slow, SET_START_MS } from './support/slowness'

let set: MongoMemoryReplSet
let standalone: TestMongo
beforeAll(async () => {
  ;[set, standalone] = await Promise.all([MongoMemoryReplSet.create({ replSet: { count: 3 } }), startMongo()])
}, slow(SET_START_MS))
afterAll(async () => {
  await Promise.all([set?.stop(), standalone?.stop()])
})
const apps: TestApp[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const t of apps.splice(0)) await t.close()
})

async function setup(settings: ReturnType<typeof parseConnectionUri>) {
  const t = await makeApp({ auth: true })
  apps.push(t)
  const { ctx } = t.app
  const connectionId = ctx.connections.create(
    { name: 'R', favorite: false, readOnly: false, settings },
    null,
  ).id
  const as = (role: Role) => {
    const user = ctx.users.create({ username: `u-${role}-${Math.random()}`, passwordHash: 'x', role })
    const { sessionId } = ctx.sessions.create(user.id, {})
    return () =>
      t.app.inject({
        method: 'GET',
        url: `/api/connections/${connectionId}/server/replica`,
        headers: H,
        cookies: { mm_sid: sessionId },
      })
  }
  return { as }
}

type Member = {
  name: string
  state: string
  healthy: boolean
  lagSeconds: number | null
  self: boolean
  priority: number | null
  votes: number | null
}

describe('replica set status (phase 1j spec §2)', () => {
  it('names the primary and lists every member, healthy and in sync, with its configuration', async () => {
    const { as } = await setup(parseConnectionUri(set.getUri()))
    const res = await as('editor')()
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toMatchObject({ mode: 'replicaSet', set: expect.any(String) })
    const members = body.members as Member[]
    expect(members).toHaveLength(3)
    expect(members.filter((m) => m.state === 'PRIMARY').map((m) => m.name)).toEqual([body.primary])
    expect(members.every((m) => m.healthy)).toBe(true)
    for (const m of members) {
      expect(m.lagSeconds).not.toBeNull()
      expect(m.lagSeconds!).toBeGreaterThanOrEqual(0)
      expect(Number.isNaN(m.lagSeconds)).toBe(false)
    }
    expect(members.every((m) => typeof m.priority === 'number' && typeof m.votes === 'number')).toBe(true)
    expect(body.majorityLagSeconds).toBeGreaterThanOrEqual(0)
    // Widgets wave 2: the oplog's use and the last election.
    expect(body.oplog).toMatchObject({ usedMb: expect.any(Number), maxMb: expect.any(Number) })
    expect(body.oplog.maxMb).toBeGreaterThan(0)
    expect(Date.parse(body.lastElection)).toBeGreaterThan(0)
    expect((await as('viewer')()).statusCode).toBe(403)
  })

  it('answers standalone for a single server', async () => {
    const { as } = await setup(
      ConnectionSettingsSchema.parse({ hosts: [{ host: '127.0.0.1', port: standalone.port }] }),
    )
    expect((await as('editor')()).json()).toEqual({ mode: 'standalone' })
  })

  it('degrades when the configuration or the oplog cannot be read, and names the role when status is refused (Review Focus 5)', async () => {
    const { as } = await setup(parseConnectionUri(set.getUri()))
    const original = Db.prototype.command
    let refuseStatus = false
    vi.spyOn(Db.prototype, 'command').mockImplementation(function (this: Db, cmd: Document, ...rest) {
      if ('replSetGetConfig' in cmd || ('replSetGetStatus' in cmd && refuseStatus))
        return Promise.reject(Object.assign(new Error('not authorized'), { code: 13 }))
      return original.call(this, cmd, ...(rest as []))
    } as typeof original)
    const partial = (await as('editor')()).json()
    expect((partial.members as Member[]).every((m) => m.priority === null && m.votes === null)).toBe(true)
    refuseStatus = true
    const refused = await as('editor')()
    expect([refused.statusCode, refused.json().details]).toEqual([403, { reason: 'mongo_not_permitted' }])
  })

  // This leaves one secondary stopped for the tests below: the set keeps its primary (2 of 3 up),
  // and the down member's heartbeat message exercises the UTF-8 path (final review 1j, Minor 15).
  it('shows a stopped member as down, with no lag computed for it (Review Focus 1)', async () => {
    const { as } = await setup(parseConnectionUri(set.getUri()))
    // The first answer can come while the client is still discovering the set: ask until it lists members.
    let before = (await as('editor')()).json()
    for (let i = 0; i < 20 && !before.members; i++) {
      await new Promise((r) => setTimeout(r, 250))
      before = (await as('editor')()).json()
    }
    const secondary = (before.members as Member[]).find((m) => m.state === 'SECONDARY')!
    const server = set.servers.find((s) => secondary.name.endsWith(`:${s.instanceInfo!.port}`))!
    await server.stop({ doCleanup: false })
    let down: Member | undefined
    const seen: string[] = []
    for (let i = 0; i < 60 && !down; i++) {
      await new Promise((r) => setTimeout(r, 500))
      const res = await as('editor')()
      // While the set notices, a request may fail over; only answers with members count.
      const members = (res.json().members ?? []) as Member[]
      if (!members.length) seen.push(`${res.statusCode} ${res.body.slice(0, 120)}`)
      down = members.find((m) => m.name === secondary.name && !m.healthy)
    }
    expect(down, seen.join(' | ')).toMatchObject({ healthy: false, lagSeconds: null })
    expect(down!.state).toMatch(/not reachable|unhealthy|UNKNOWN|DOWN/i)
  }, 60_000)
})

describe('replica set status: unexpected failures (final review 1j, Important 4)', () => {
  it('lets a programming error surface as a bug (500), not as a MongoDB problem', async () => {
    const { as } = await setup(parseConnectionUri(set.getUri()))
    const original = Db.prototype.command
    vi.spyOn(Db.prototype, 'command').mockImplementation(function (this: Db, cmd: Document, ...rest) {
      if ('replSetGetStatus' in cmd)
        return Promise.resolve({
          members: [
            {
              get name(): string {
                throw new TypeError('boom')
              },
            },
          ],
        })
      return original.call(this, cmd, ...(rest as []))
    } as typeof original)
    const res = await as('editor')()
    expect([res.statusCode, res.json().code]).toEqual([500, 'INTERNAL'])
  })

  it('answers 502 when the driver cannot decode an answer', async () => {
    const { as } = await setup(parseConnectionUri(set.getUri()))
    const original = Db.prototype.command
    vi.spyOn(Db.prototype, 'command').mockImplementation(function (this: Db, cmd: Document, ...rest) {
      if ('replSetGetStatus' in cmd)
        return Promise.reject(Object.assign(new Error('Invalid UTF-8'), { name: 'BSONError' }))
      return original.call(this, cmd, ...(rest as []))
    } as typeof original)
    const res = await as('editor')()
    expect([res.statusCode, res.json().code]).toEqual([502, 'MONGO_ERROR'])
  })
})

describe('replica set status: reading options (final review 1j, Critical 1, Minor 14)', () => {
  it('asks any member, so a set without a primary still answers, and reads the oplog the same way', async () => {
    const { as } = await setup(parseConnectionUri(set.getUri()))
    const commands: Array<[string, unknown]> = []
    const original = Db.prototype.command
    vi.spyOn(Db.prototype, 'command').mockImplementation(function (
      this: Db,
      cmd: Document,
      options,
      ...rest
    ) {
      commands.push([Object.keys(cmd)[0]!, options])
      return original.call(this, cmd, options, ...(rest as []))
    } as typeof original)
    const finds: unknown[] = []
    const findOne = Collection.prototype.findOne
    vi.spyOn(Collection.prototype, 'findOne').mockImplementation(function (
      this: Collection,
      ...args: unknown[]
    ) {
      if (this.collectionName === 'oplog.rs') finds.push(args[1])
      return (findOne as (...a: unknown[]) => unknown).apply(this, args)
    } as never)
    await as('editor')()
    for (const name of ['hello', 'replSetGetStatus', 'replSetGetConfig'])
      expect(commands.find(([n]) => n === name)?.[1], name).toMatchObject({
        readPreference: 'primaryPreferred',
      })
    expect(finds).toHaveLength(2)
    for (const options of finds) expect(options).toMatchObject({ readPreference: 'primaryPreferred' })
  })

  it('leaves the oplog window empty when the oplog cannot be read', async () => {
    const { as } = await setup(parseConnectionUri(set.getUri()))
    vi.spyOn(Collection.prototype, 'findOne').mockImplementation(function (this: Collection) {
      return Promise.reject(Object.assign(new Error('not authorized'), { code: 13 }))
    } as never)
    const body = (await as('editor')()).json()
    expect(body.oplogWindowHours).toBeNull()
    expect(body.members.length).toBeGreaterThan(0)
  })

  it('leaves the oplog’s use empty when its stats cannot be read', async () => {
    const { as } = await setup(parseConnectionUri(set.getUri()))
    vi.spyOn(Collection.prototype, 'aggregate').mockImplementation(function (this: Collection) {
      throw Object.assign(new Error('not authorized'), { code: 13 })
    } as never)
    const body = (await as('editor')()).json()
    expect(body.oplog).toBeNull()
    expect(body.oplogWindowHours).not.toBeNull()
  })
})

describe('replica set status: text MongoDB could not encode (found under load)', () => {
  it('reads monitoring answers without failing on invalid UTF-8, as a down member’s OS message can be', async () => {
    const { as } = await setup(parseConnectionUri(set.getUri()))
    const seen: Array<[string, unknown]> = []
    const original = Db.prototype.command
    vi.spyOn(Db.prototype, 'command').mockImplementation(function (
      this: Db,
      cmd: Document,
      options,
      ...rest
    ) {
      const name = Object.keys(cmd)[0]!
      if (['replSetGetStatus', 'replSetGetConfig'].includes(name)) seen.push([name, options])
      return original.call(this, cmd, options, ...(rest as []))
    } as typeof original)
    await as('editor')()
    expect(seen.map(([n]) => n).sort()).toEqual(['replSetGetConfig', 'replSetGetStatus'])
    for (const [, options] of seen) expect(options).toMatchObject({ enableUtf8Validation: false })
  })
})

describe('a set that lost its primary (final review 1j, Critical 1)', () => {
  let lonely: MongoMemoryReplSet
  beforeAll(async () => {
    lonely = await MongoMemoryReplSet.create({ replSet: { count: 3 } })
  }, slow(SET_START_MS))
  afterAll(async () => {
    await lonely?.stop()
  })

  it('says there is no primary and shows the members that are down', async () => {
    const { as } = await setup(parseConnectionUri(lonely.getUri()))
    let body = (await as('editor')()).json()
    for (let i = 0; i < 20 && !body.members; i++) {
      await new Promise((r) => setTimeout(r, 250))
      body = (await as('editor')()).json()
    }
    const survivors = (body.members as Member[]).filter((m) => m.state !== 'PRIMARY').map((m) => m.name)
    // Stop the primary and one secondary: the last member cannot win an election alone.
    const primary = body.primary as string
    for (const name of [primary, survivors[0]!]) {
      const server = lonely.servers.find((s) => name.endsWith(`:${s.instanceInfo!.port}`))!
      await server.stop({ doCleanup: false })
    }
    let answer: { primary?: string | null; members?: Member[] } = {}
    for (let i = 0; i < 80; i++) {
      await new Promise((r) => setTimeout(r, 500))
      answer = (await as('editor')()).json()
      if (answer.members && answer.primary === null && answer.members.filter((m) => !m.healthy).length === 2)
        break
    }
    expect(answer.primary).toBeNull()
    expect(
      answer
        .members!.filter((m) => !m.healthy)
        .map((m) => m.name)
        .sort(),
    ).toEqual([primary, survivors[0]].sort())
    expect(answer.members!.every((m) => m.lagSeconds === null)).toBe(true)
  }, 90_000)
})
