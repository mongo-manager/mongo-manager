// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { MongoClient } from 'mongodb'
import { ConnectionSettingsSchema, type Role } from '@mongo-manager/shared'
import { startMongo, type TestMongo } from './support/mongo'
import { H, makeApp, type TestApp } from './helpers'
import { slow } from './support/slowness'

/** Phase 3b spec §4: the operations list takes validated filters and masks for restricted users. */
let mongo: TestMongo
let client: MongoClient
beforeAll(async () => {
  mongo = await startMongo()
  client = await new MongoClient(`mongodb://127.0.0.1:${mongo.port}`).connect()
  // The document the slow finds match, so their $where (and its sleep) runs whatever the plan order.
  await client.db('crm').collection('users').insertOne({ email: 'ada@x' })
}, slow(120_000))
afterAll(async () => {
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
  ctx.personalFields.set(connectionId, [{ db: 'crm', coll: 'users', field: 'email' }])
  return { as }
}

/** A find that sleeps in MongoDB, so it is listed while it runs. */
function slowFind(email: string) {
  return client
    .db('crm')
    .collection('users')
    .find({ email, $where: 'sleep(1500) || true' })
    .toArray()
    .catch(() => undefined)
}

type Listed = {
  operations: Array<{ ns: string; op: string; command?: string }>
  more: boolean
  scope: string
}

/** Polls until the slow find is listed (it may take a moment to start). */
async function waitListed(call: (p: string) => Promise<{ json(): unknown }>, path: string): Promise<Listed> {
  for (let i = 0; i < 40; i++) {
    const res = (await call(path)).json() as Listed
    if (res.operations.some((o) => o.ns === 'crm.users')) return res
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(
    `operation never listed: ${JSON.stringify(((await call(path)) as { json(): unknown }).json())}`,
  )
}

describe('filtered operations (phase 3b §4)', () => {
  it('filters by namespace prefix, kind and time, and says whether there are more', async () => {
    const { as } = await setup()
    const running = slowFind('ada@x')
    const editor = as('editor')
    const inCrm = await waitListed(editor, 'operations?ns=crm&op=query')
    expect(inCrm).toMatchObject({ more: false, scope: 'all' })
    expect(((await editor('operations?ns=shop')).json() as Listed).operations).toEqual([])
    expect(((await editor('operations?ns=crm&op=insert')).json() as Listed).operations).toEqual([])
    expect(((await editor('operations?ns=crm&minSecs=3600')).json() as Listed).operations).toEqual([])
    await running
  })

  it('shows the command to editors, masked for a restricted user', async () => {
    const { as } = await setup()
    const running = slowFind('ada@x')
    const full = (await waitListed(as('editor'), 'operations?ns=crm.users')).operations.find(
      (o) => o.ns === 'crm.users',
    )!
    expect(full.command).toContain('ada@x')
    const restricted = as('editor', true)
    await waitListed(restricted, 'operations?ns=crm.users')
    const res = await restricted('operations?ns=crm.users')
    expect(res.body).not.toContain('ada@x')
    expect(res.body).toContain('***')
    await running
  })

  it('masks a command MongoDB cut short for a restricted user (final review C2)', async () => {
    const { as } = await setup()
    // Over 1 KB, $currentOp reports the command as a { $truncated } string.
    const many = ['ada@x', ...Array.from({ length: 200 }, (_, i) => `long${i}@x.example`)]
    const running = client
      .db('crm')
      .collection('users')
      .find({ email: { $in: many }, $where: 'sleep(1500) || true' })
      .toArray()
      .catch(() => undefined)
    const full = await waitListed(as('editor'), 'operations?ns=crm.users')
    expect(JSON.stringify(full)).toContain('long1@x.example')
    const restricted = as('editor', true)
    await waitListed(restricted, 'operations?ns=crm.users')
    const res = await restricted('operations?ns=crm.users')
    expect(res.body).not.toContain('long1@x.example')
    await running
  })

  it('treats ns as a literal prefix, never as a pattern or operator (review focus 4)', async () => {
    const { as } = await setup()
    const running = slowFind('ada@x')
    const editor = as('editor')
    await waitListed(editor, 'operations?ns=crm')
    for (const ns of ['.*', 'crm|shop', 'c.m', '$where', '(a+)+$', 'cr'])
      expect(
        ((await editor(`operations?ns=${encodeURIComponent(ns)}`)).json() as Listed).operations,
        ns,
      ).toEqual([])
    expect((await editor('operations?ns=a%00b')).statusCode).toBe(400)
    await running
  })
})
