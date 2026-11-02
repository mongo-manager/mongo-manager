import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { MongoClient } from 'mongodb'
import { startMongo, type TestMongo } from './support/mongo'
import { dataHarness, type DataHarness } from './support/data'
import { isRestricted, mayUseShell } from '../src/connections/access'
import { ownerPrincipal } from '../src/backup/schedules/policy'
import { aiRulesVersion, turnAccess } from '../src/ai/access'
import type { TestApp } from './helpers'
import { slow } from './support/slowness'

/**
 * User request 2026-10-13: "kişisel veri adına bir bilgiyi gizleme tespit edilemedi, yerel mod bile
 * olsa bu özellik aktif olmalı". In local mode, a connection's personal-data rules hide its values
 * from the local user too, with every guard a team member who may not see personal data has. User
 * request 2026-10-24: one person uses local mode, so there is no switch to show them: the rules hide.
 */
const S = 'L0C4LS3CR3T'
const NS = '/databases/crm/collections/people'
let mongo: TestMongo
beforeAll(async () => {
  mongo = await startMongo()
  const client = await new MongoClient(`mongodb://127.0.0.1:${mongo.port}`).connect()
  await client
    .db('crm')
    .collection('people')
    .insertOne({ email: `${S}@x`, name: 'Ali' })
  await client.close()
}, slow(120_000))
afterAll(async () => {
  await mongo?.stop()
})
const open: Array<DataHarness | TestApp> = []
afterEach(async () => {
  for (const h of open.splice(0)) await ('t' in h ? h.t : h).close()
})
const LOCAL = { kind: 'local', userId: 'local', username: 'owner', role: 'admin', csrfToken: 'x' } as const

async function local(rules = [{ db: 'crm', coll: 'people', field: 'email' }]) {
  const h = await dataHarness(mongo)
  open.push(h)
  h.t.app.ctx.personalFields.set(h.connectionId, rules)
  return h
}
const find = (h: DataHarness) => h.call('POST', `${NS}/find`, { filter: {}, limit: 5 })

describe('personal data in local mode', () => {
  it('hides the values the rules name from the local user', async () => {
    const h = await local()
    const res = await find(h)
    expect(res.statusCode).toBe(200)
    expect(res.body).not.toContain(S)
    expect(res.json().documents[0].document).toMatchObject({ email: '***', name: 'Ali' })
    const list = (await h.get('/api/connections')).json() as Array<{ id: string; restricted: boolean }>
    expect(list.find((c) => c.id === h.connectionId)!.restricted).toBe(true)
    // As for a team member who may not see personal data: no shell (its code could read anything).
    expect(isRestricted(h.t.app.ctx, LOCAL, h.connectionId)).toBe(true)
    expect(mayUseShell(h.t.app.ctx, LOCAL, h.connectionId)).toBe(false)
  })

  it('has no switch to show them: the old one is gone, and a choice stored by it shows nothing', async () => {
    const h = await local()
    expect((await h.call('PUT', '/personal-fields/local', { shown: true })).statusCode).toBe(404)
    expect((await h.call('PUT', '/personal-fields/self', { hidden: false })).statusCode).toBe(404)
    expect((await h.call('GET', '/personal-fields')).json()).toEqual({
      rules: [{ db: 'crm', coll: 'people', field: 'email' }],
    })
    // Said "show" before the switch went: the rules hide all the same.
    h.t.app.ctx.store.db
      .prepare('UPDATE personal_fields SET shown_locally = 1 WHERE connection_id = ?')
      .run(h.connectionId)
    expect((await find(h)).body).not.toContain(S)
    expect(isRestricted(h.t.app.ctx, LOCAL, h.connectionId)).toBe(true)
  })

  it('hides nothing where no rule names anything, and hides once a rule does', async () => {
    const h = await local([])
    expect((await find(h)).body).toContain(S)
    expect(isRestricted(h.t.app.ctx, LOCAL, h.connectionId)).toBe(false)
    await h.call('PUT', '/personal-fields', { rules: [{ db: 'crm', coll: 'people', field: 'email' }] })
    expect((await find(h)).body).not.toContain(S)
    await h.call('PUT', '/personal-fields', { rules: [{ db: 'crm', coll: 'people', field: 'name' }] })
    expect((await find(h)).body).toContain(S)
    expect((await find(h)).json().documents[0].document).toMatchObject({ name: '***' })
  })

  // Review of the rework (tests): a choice to show the values, stored by the switch that is gone,
  // is no longer followed.
  it('follows no choice to show the values made before the switch went', async () => {
    const h = await local()
    h.t.app.ctx.store.db
      .prepare('UPDATE personal_fields SET shown_locally = 1 WHERE connection_id = ?')
      .run(h.connectionId)
    expect((await find(h)).body).not.toContain(S)
    expect(isRestricted(h.t.app.ctx, LOCAL, h.connectionId)).toBe(true)
  })

  // Review I3 (2026-10-13), kept: an earlier chat turn travels under the hiding it was sent with.
  it('counts the hiding in the version earlier AI turns are checked against', async () => {
    const h = await local()
    const version = h.t.app.ctx.personalFields.get(h.connectionId).version
    expect(turnAccess(h.t.app.ctx, LOCAL)(h.connectionId)!.rulesVersion).toBe(-version - 1)
    // Work running on its own sees the values: its turns are not the hidden ones.
    const owner = ownerPrincipal(h.t.app.ctx, 'local')!
    expect(aiRulesVersion(h.t.app.ctx, owner, h.connectionId)).toBe(version)
    // No rule left: nothing hidden, the plain version.
    await h.call('PUT', '/personal-fields', { rules: [] })
    const none = h.t.app.ctx.personalFields.get(h.connectionId).version
    expect(turnAccess(h.t.app.ctx, LOCAL)(h.connectionId)!.rulesVersion).toBe(none)
  })

  // Review 2026-10-13 (C1): hiding is how the local user views data; work running on its own for
  // them (scheduled backups, retention, live syncs) never turned masked behind their back.
  it('leaves the work that runs on its own as it was', async () => {
    const h = await local()
    const owner = ownerPrincipal(h.t.app.ctx, 'local')!
    expect(isRestricted(h.t.app.ctx, owner, h.connectionId)).toBe(false)
    expect(isRestricted(h.t.app.ctx, LOCAL, h.connectionId)).toBe(true)
  })

  // Review M5: a shell opened while nothing was hidden closes once a rule hides values.
  it("closes the connection's shells when a rules save hides values", async () => {
    const h = await local([])
    const closed: Array<{ match: unknown; reason: string }> = []
    ;(h.t.app.ctx.shell as unknown as { closeFor: unknown }).closeFor = async (
      match: unknown,
      reason: string,
    ) => void closed.push({ match, reason })
    await h.call('PUT', '/personal-fields', { rules: [{ db: 'crm', coll: 'people', field: 'name' }] })
    expect(closed).toEqual([{ match: { connectionId: h.connectionId }, reason: 'access' }])
  })

  // Review M7: a rule list that does not open hid nothing — and broke the connection list (500).
  it('hides everything of a connection whose rules do not open, and lists it', async () => {
    const h = await local()
    h.t.app.ctx.store.db
      .prepare('UPDATE personal_fields SET rules = ?, updated_at = updated_at + 1 WHERE connection_id = ?')
      .run('not-sealed', h.connectionId)
    expect(isRestricted(h.t.app.ctx, LOCAL, h.connectionId)).toBe(true)
    expect((await h.get('/api/connections')).statusCode).toBe(200)
  })
})
