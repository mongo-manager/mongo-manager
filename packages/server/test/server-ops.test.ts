// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MongoClient } from 'mongodb'
import { ConnectionSettingsSchema, type Role } from '@mongo-manager/shared'
import { startMongo, type TestMongo } from './support/mongo'
import { H, makeApp, type TestApp } from './helpers'
import { SPARE_MS } from './support/wait-budget'

let mongo: TestMongo
let other: MongoClient
beforeAll(async () => {
  mongo = await startMongo({ args: ['--setParameter', 'enableTestCommands=1'] })
  other = await new MongoClient(`mongodb://127.0.0.1:${mongo.port}`).connect()
})
afterAll(async () => {
  await other?.close()
  await mongo?.stop()
})
const apps: TestApp[] = []
/**
 * Review of the slow-find waits (important): what the helpers below wait for, together, ends
 * SPARE_MS (wait-budget.ts) short of the test's limit, so a wait that runs out says why before the
 * limit does.
 */
let deadline = 0
beforeEach(({ task }) => {
  deadline = Date.now() + (task.timeout ?? 20_000) - SPARE_MS
})
afterEach(async () => {
  try {
    await stopSlow(Date.now() + 15_000)
  } finally {
    for (const t of apps.splice(0)) await t.close()
  }
})

async function setup(overrides: object = {}) {
  const t = await makeApp({ auth: true, ...overrides })
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
  const as = (role: Role) => {
    const user = ctx.users.create({ username: `u-${role}-${Math.random()}`, passwordHash: 'x', role })
    const { sessionId, session } = ctx.sessions.create(user.id, {})
    return (method: 'GET' | 'POST', path: string, payload?: object) =>
      t.app.inject({
        method,
        url: `/api/connections/${connectionId}/server/${path}`,
        headers: { ...H, 'x-csrf-token': session.csrfToken },
        cookies: { mm_sid: sessionId },
        ...(payload ? { payload } : {}),
      })
  }
  return { t, ctx, connectionId, as }
}

type Op = {
  opid: string
  op: string
  ns: string
  secsRunning: number
  command?: unknown
  client?: unknown
  startedAt: number
  member: string
}

/**
 * Kills the slow finds this file started (they would otherwise run their full 10 s), until none is
 * left, and says how many its first look found that no kill had reached. CI 2026-10-21 (MongoDB
 * 9.0, Ubuntu): one test ran to its 20 s limit where it takes 0.5 to 1.9 s and the file's other
 * tests took 0.1 to 0.3 s, as a find that outlived its kill would (each sleeps 10 s per document).
 * One that outlives a kill is killed again and said once, with what MongoDB says of it (whether the
 * kill reached it); one still there at `until` fails the test by name.
 */
async function stopSlow(until = deadline): Promise<number> {
  const said = new Set<string>()
  let first = 0
  for (let round = 0; ; round++) {
    const ops = (
      await other
        .db('admin')
        .aggregate([{ $currentOp: { allUsers: true } }])
        .toArray()
    ).filter((o) => o.command?.filter?.$where)
    // Not one a kill already reached (killPending until it ends).
    if (round === 0) first = ops.filter((o) => !o.killPending).length
    if (!ops.length) return first
    const left = (o: (typeof ops)[number]) =>
      `${o.ns} (${o.command?.comment}, opid ${o.opid}, killPending ${o.killPending ?? false}, ` +
      `${o.secs_running ?? 0} s${o.msg ? `, ${o.msg}` : ''})`
    for (const o of ops)
      if (round > 0 && !said.has(String(o.opid))) {
        said.add(String(o.opid))
        console.warn(
          `server-ops: ${o.killPending ? 'still ending after' : 'still running despite'} a kill: ${left(o)}`,
        )
      }
    if (Date.now() > until)
      throw new Error(
        `${round ? 'slow finds outlived their kills' : 'no time left to kill slow finds'}: ${ops.map(left).join('; ')}`,
      )
    for (const op of ops)
      await other
        .db('admin')
        .command({ killOp: 1, op: op.opid })
        .catch(() => undefined)
    await new Promise((r) => setTimeout(r, 100))
  }
}

/**
 * A find that runs for a few seconds (server-side JavaScript that MongoDB can interrupt), over the
 * one document it leaves in its collection: a find that outlives its kill costs 10 s, not 10 s for
 * each document earlier tests left (review of the slow-find waits, important).
 */
async function slowFind(ns: string, comment: string) {
  const [db, coll] = [ns.slice(0, ns.indexOf('.')), ns.slice(ns.indexOf('.') + 1)]
  await other.db(db).collection(coll).deleteMany({})
  await other.db(db).collection(coll).insertOne({ secret: 'hunter2' })
  return other
    .db(db)
    .collection(coll)
    .find({ $where: 'sleep(10000) || this.secret === "hunter2"' }, { comment })
    .toArray()
    .catch((e: Error) => e)
}

async function listed(
  call: ReturnType<Awaited<ReturnType<typeof setup>>['as']>,
  ns: string,
  path = 'operations',
): Promise<Op> {
  // Bounded by the test's deadline, and saying which (CI 2026-10-21, as stopSlow).
  while (Date.now() < deadline) {
    const res = await call('GET', path)
    if (res.statusCode !== 200) throw new Error(`listing the operations answered ${res.statusCode}`)
    const ops = res.json().operations as Op[]
    // The slow find, not the insert that seeded its collection a moment before.
    const found = ops.find((o) => o.ns === ns && o.op === 'query')
    if (found) return found
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`the find on ${ns} was not listed before the test's deadline`)
}

describe('slowest operations (phase 1i spec §4, Review Focus 1)', () => {
  it('lists running operations without the client, with the command for every monitor (phase 3b §2.4)', async () => {
    const { as } = await setup()
    const running = slowFind('shop.orders', 'user-query')
    const editor = as('editor')
    const op = await listed(editor, 'shop.orders')
    expect(op).toMatchObject({ op: 'query', ns: 'shop.orders' })
    expect(typeof op.opid).toBe('string')
    expect(op.secsRunning).toBeGreaterThanOrEqual(0)
    expect(op).not.toHaveProperty('client')
    // Phase 3b: the command is shown to monitors; personal values are hidden by rules, not by role.
    expect(JSON.stringify(op.command)).toContain('hunter2')
    const adminOp = await listed(as('admin'), 'shop.orders')
    expect(JSON.stringify(adminOp.command)).toContain('hunter2')
    expect(adminOp).not.toHaveProperty('client')
    expect((await as('viewer')('GET', 'operations')).statusCode).toBe(403)
    await stopSlow()
    await running
  })

  it('lets a connection admin kill a listed operation, audited, and refuses everything else', async () => {
    const { ctx, as } = await setup()
    const running = slowFind('shop.orders', 'user-query')
    const admin = as('admin')
    const op = await listed(admin, 'shop.orders')
    expect((await as('editor')('POST', `operations/${op.opid}/kill`)).statusCode).toBe(403)
    expect(
      (await admin('POST', 'operations/999999999/kill', { ns: 'shop.orders', op: 'query' })).statusCode,
    ).toBe(404)
    // Third review of B3 (M2): what was seen is required — a kill saying nothing stops nothing.
    expect((await admin('POST', `operations/${op.opid}/kill`)).statusCode).toBe(400)
    // Fifth review of B3 (nit 7): what the operation says of itself (start, member) is required too.
    const unsaid = await admin('POST', `operations/${op.opid}/kill`, { ns: op.ns, op: op.op })
    expect([unsaid.statusCode, unsaid.json().details?.reason]).toEqual([409, 'operation_unconfirmed'])
    // Each on its own: its start given, its member not — refused too.
    const noMember = await admin('POST', `operations/${op.opid}/kill`, {
      ns: op.ns,
      op: op.op,
      startedAt: op.startedAt,
    })
    expect([noMember.statusCode, noMember.json().details?.reason]).toEqual([409, 'operation_unconfirmed'])
    // M8: one operation asked for by its opid, however many run.
    const one = (await admin('GET', `operations?opid=${op.opid}`)).json() as { operations: Op[] }
    expect(one.operations.map((o) => o.opid)).toEqual([op.opid])
    // Review of B3 (I1): what was asked to stop is checked against what runs under that opid now.
    const changed = await admin('POST', `operations/${op.opid}/kill`, {
      ns: 'shop.other',
      op: 'query',
      startedAt: op.startedAt,
      member: op.member,
    })
    expect([changed.statusCode, changed.json().details?.reason]).toEqual([409, 'operation_changed'])
    // Re-review of B3 (M-2): its kind, when it started and the member it runs on are what was seen too.
    expect(op).toMatchObject({ startedAt: expect.any(Number), member: expect.any(String) })
    for (const other of [
      { ns: 'shop.orders', op: 'update', startedAt: op.startedAt, member: op.member },
      { ns: 'shop.orders', op: 'query', startedAt: op.startedAt - 60_000, member: op.member },
      { ns: 'shop.orders', op: 'query', startedAt: op.startedAt, member: 'another-member' },
    ]) {
      const refused = await admin('POST', `operations/${op.opid}/kill`, other)
      expect([refused.statusCode, refused.json().details?.reason], JSON.stringify(other)).toEqual([
        409,
        'operation_changed',
      ])
    }
    const [conflict] = ctx.audit.list({ action: 'server.killOp', limit: 1 })
    expect(conflict).toMatchObject({ details: { expected: { ns: 'shop.orders', member: 'another-member' } } })
    // M-1: what has finished is said as such.
    const gone = await admin('POST', 'operations/999999998/kill', { ns: 'shop.orders', op: 'query' })
    expect(gone.json().details?.reason).toBe('operation_finished')
    // M5: a moment past the slack — when it started is when it started, not when it was read.
    await new Promise((r) => setTimeout(r, 2_500))
    const res = await admin('POST', `operations/${op.opid}/kill`, {
      ns: op.ns,
      op: op.op,
      startedAt: op.startedAt,
      member: op.member,
    })
    expect(res.statusCode).toBe(200)
    expect(await running).toBeInstanceOf(Error)
    const [row] = ctx.audit.list({ action: 'server.killOp', limit: 5 })
    expect(row).toMatchObject({ outcome: 'success', details: { op: 'query', ns: 'shop.orders' } })
    expect(JSON.stringify(row!.details)).not.toContain('hunter2')
  })

  it('never kills system or mongo-manager operations, and nothing in read-only mode', async () => {
    const { as } = await setup()
    const admin = as('admin')
    const job = slowFind('shop.jobs', 'mm-job:1234')
    // Phase 3b-2: a job's operation is the user's work and is listed by default; only
    // mongo-manager's monitoring reads are left out unless asked for.
    const jobOp = await listed(admin, 'shop.jobs')
    const refused = await admin('POST', `operations/${jobOp.opid}/kill`, { ns: jobOp.ns, op: jobOp.op })
    expect([refused.statusCode, refused.json().message]).toEqual([
      403,
      'Operations of mongo-manager itself are stopped from the jobs tray',
    ])
    // Refused, so still running (review of the slow-find waits, minor).
    expect(await stopSlow()).toBe(1)
    await job
    const system = slowFind('admin.things', 'user-query')
    const sysOp = await listed(admin, 'admin.things')
    expect(
      (await admin('POST', `operations/${sysOp.opid}/kill`, { ns: sysOp.ns, op: sysOp.op })).statusCode,
    ).toBe(403)
    expect(await stopSlow()).toBe(1)
    await system

    const ro = await setup({ readOnly: true })
    const roAdmin = ro.as('admin')
    const running = slowFind('shop.orders', 'user-query')
    const op = await listed(roAdmin, 'shop.orders')
    const res = await roAdmin('POST', `operations/${op.opid}/kill`, { ns: op.ns, op: op.op })
    expect([res.statusCode, res.json().code]).toEqual([403, 'READ_ONLY'])
    expect(await stopSlow()).toBe(1)
    await running
  })
})

describe('hottest collections (phase 1i spec §4)', () => {
  it('lists user namespaces by total time, at most 15', async () => {
    const { as } = await setup()
    for (let i = 0; i < 20; i++) await other.db('hot').collection(`c${i}`).insertOne({ i })
    await other
      .db('hot')
      .collection('busy')
      .insertMany(Array.from({ length: 200 }, (_, i) => ({ i })))
    const res = await as('editor')('GET', 'top')
    expect(res.statusCode).toBe(200)
    const top = res.json().collections as Array<{ ns: string; totalMs: number; count: number }>
    expect(top.length).toBeLessThanOrEqual(15)
    expect(top.every((c) => !/^(admin|local|config)\./.test(c.ns))).toBe(true)
    expect(top.map((c) => c.totalMs)).toEqual([...top.map((c) => c.totalMs)].sort((a, b) => b - a))
    expect((await as('viewer')('GET', 'top')).statusCode).toBe(403)
  })
})

// Fifth review of B3 (I1): an opid as MongoDB writes it — a number, or a shard's, hyphens and all.
describe('an opid', () => {
  it('takes a number, a negative one, and a shard’s with hyphens in its name', async () => {
    const { OperationsQuerySchema } = await import('@mongo-manager/shared')
    for (const opid of ['12345', '-5', 'atlas-abc12-shard-0:12345', 'shard:-5'])
      expect(OperationsQuerySchema.safeParse({ opid }).success, opid).toBe(true)
    for (const opid of ['12 3', 'a:b', '--1', 'x'.repeat(70) + ':1'])
      expect(OperationsQuerySchema.safeParse({ opid }).success, opid).toBe(false)
  })
})
