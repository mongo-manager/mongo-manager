// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { MongoClient } from 'mongodb'
import { startMongo, type TestMongo } from './support/mongo'
import { dataHarness, teamHarness, type DataHarness } from './support/data'
import { isRestricted, mayUseShell, viewing } from '../src/connections/access'
import { ownerPrincipal } from '../src/backup/schedules/policy'
import { aiRulesVersion, turnAccess } from '../src/ai/access'
import type { Principal } from '../src/http/context'
import type { Role } from '@mongo-manager/shared'
import type { TestApp } from './helpers'
import { slow } from './support/slowness'

/**
 * User request 2026-10-24: in team mode a connection's administrator may hide its personal data from
 * themselves too ("hide from me"), with every guard of a team member who may not see it; local mode
 * has no such switch (one person: the rules always hide from them).
 */
const S = 'S3LFH1DD3N'
const NS = '/databases/crm/collections/people'
const RULES = [{ db: 'crm', coll: 'people', field: 'email' }]
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
const open: Array<TestApp | DataHarness> = []
afterEach(async () => {
  for (const h of open.splice(0)) await ('t' in h ? h.t : h).close()
})

async function team(rules = RULES) {
  const h = await teamHarness(mongo)
  open.push(h.t)
  h.t.app.ctx.personalFields.set(h.connectionId, rules)
  return h
}
type Team = Awaited<ReturnType<typeof team>>
const find = (u: ReturnType<Team['user']>) => u.call('POST', `${NS}/find`, { filter: {}, limit: 5 })
const principal = (userId: string, role: Role = 'admin'): Principal => ({
  kind: 'user',
  userId,
  username: 'x',
  role,
  csrfToken: '',
  sessionId: '',
  sessionIdHash: '',
})
const hide = (u: ReturnType<Team['user']>, hidden: boolean) =>
  u.call('PUT', '/personal-fields/self', { hidden })
function shellCloses(h: Team) {
  const closed: Array<{ match: unknown; reason: string }> = []
  ;(h.t.app.ctx.shell as unknown as { closeFor: unknown }).closeFor = async (
    match: unknown,
    reason: string,
  ) => void closed.push({ match, reason })
  return closed
}

describe('hide from me, reviewed (2026-10-24)', () => {
  // I4: an administrator hid, then was made an editor: they could no more undo it, and stayed masked.
  it('holds only while its user administers the connection', async () => {
    const h = await team()
    const admin = h.user('admin')
    expect((await hide(admin, true)).statusCode).toBe(200)
    expect((await find(admin)).body).not.toContain(S)
    // The same person as an editor of it (their grant changed): no longer theirs to hide.
    const editor = principal(admin.id, 'editor')
    const version = h.t.app.ctx.personalFields.get(h.connectionId).version
    expect(isRestricted(h.t.app.ctx, editor, h.connectionId)).toBe(false)
    expect(aiRulesVersion(h.t.app.ctx, editor, h.connectionId)).toBe(version)
    // As its administrator: their choice holds.
    expect(isRestricted(h.t.app.ctx, principal(admin.id), h.connectionId)).toBe(true)
    expect(aiRulesVersion(h.t.app.ctx, principal(admin.id), h.connectionId)).toBe(-version - 1)
  })

  // Minor 10: a schedule's history kept MongoDB's words (which can quote values) from a restricted
  // owner; one who hides from themselves read them all the same.
  it("keeps MongoDB's words from the history of an owner who hides the values from themselves", async () => {
    const h = await team()
    const admin = h.user('admin')
    await hide(admin, true)
    const owner = ownerPrincipal(h.t.app.ctx, admin.id)!
    expect(isRestricted(h.t.app.ctx, owner, h.connectionId)).toBe(false)
    expect(isRestricted(h.t.app.ctx, viewing(owner), h.connectionId)).toBe(true)
  })
})

describe('hide from me (team mode)', () => {
  it('hides the values from that administrator only, at their word, and shows them again, audited', async () => {
    const h = await team()
    const a = h.user('admin')
    const b = h.user('admin')
    expect((await a.call('GET', '/personal-fields')).json()).toEqual({ rules: RULES, hiddenFromMe: false })
    const res = await hide(a, true)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ hidden: true })
    const mine = await find(a)
    expect(mine.statusCode).toBe(200)
    expect(mine.body).not.toContain(S)
    expect(mine.json().documents[0].document).toMatchObject({ email: '***', name: 'Ali' })
    // Another administrator still sees them.
    expect((await find(b)).body).toContain(S)
    expect((await a.call('GET', '/personal-fields')).json()).toEqual({ rules: RULES, hiddenFromMe: true })
    expect((await b.call('GET', '/personal-fields')).json()).toEqual({ rules: RULES, hiddenFromMe: false })
    const restricted = async (u: ReturnType<Team['user']>) =>
      ((await u.get('/api/connections')).json() as Array<{ id: string; restricted: boolean }>).find(
        (c) => c.id === h.connectionId,
      )!.restricted
    expect(await restricted(a)).toBe(true)
    expect(await restricted(b)).toBe(false)
    expect((await hide(a, false)).json()).toEqual({ hidden: false })
    expect((await find(a)).body).toContain(S)
    expect(await restricted(a)).toBe(false)
    const rows = h.t.app.ctx.audit
      .list({ limit: 20 })
      .filter((r) => r.action === 'connections.personalFields.self')
    expect(rows.map((r) => r.details)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ hidden: true }),
        expect.objectContaining({ hidden: false }),
      ]),
    )
  })

  it('gives no shell while hidden, and closes the shells that one administrator has open', async () => {
    const h = await team()
    const a = h.user('admin')
    const closed = shellCloses(h)
    expect(mayUseShell(h.t.app.ctx, principal(a.id), h.connectionId)).toBe(true)
    await hide(a, true)
    expect(mayUseShell(h.t.app.ctx, principal(a.id), h.connectionId)).toBe(false)
    expect(closed).toEqual([{ match: { connectionId: h.connectionId, userId: a.id }, reason: 'access' }])
    closed.length = 0
    await hide(a, false)
    expect(closed).toEqual([])
  })

  it('closes the shells of those hiding it from themselves when a rules save hides values from them', async () => {
    const h = await team([])
    const a = h.user('admin')
    const b = h.user('admin')
    await hide(a, true)
    // No rule: nothing hidden, so a shell may be open.
    expect(mayUseShell(h.t.app.ctx, principal(a.id), h.connectionId)).toBe(true)
    const closed = shellCloses(h)
    expect((await b.call('PUT', '/personal-fields', { rules: RULES })).statusCode).toBe(200)
    expect(closed).toEqual([{ match: { connectionId: h.connectionId, userId: a.id }, reason: 'access' }])
    expect(mayUseShell(h.t.app.ctx, principal(a.id), h.connectionId)).toBe(false)
  })

  it('hides nothing where no rule names anything', async () => {
    const h = await team([])
    const a = h.user('admin')
    await hide(a, true)
    expect((await find(a)).body).toContain(S)
    expect(isRestricted(h.t.app.ctx, principal(a.id), h.connectionId)).toBe(false)
    await a.call('PUT', '/personal-fields', { rules: RULES })
    expect((await find(a)).body).not.toContain(S)
  })

  it('leaves the work that runs on its own for them as it was', async () => {
    const h = await team()
    const a = h.user('admin')
    await hide(a, true)
    expect(isRestricted(h.t.app.ctx, principal(a.id), h.connectionId)).toBe(true)
    const owner = ownerPrincipal(h.t.app.ctx, a.id)!
    expect(owner).toMatchObject({ kind: 'user', userId: a.id, unattended: true })
    expect(isRestricted(h.t.app.ctx, owner, h.connectionId)).toBe(false)
  })

  it('counts in the version earlier AI turns are checked against, and leaves the rules version alone', async () => {
    const h = await team()
    const a = h.user('admin')
    const rules = h.t.app.ctx.personalFields.get(h.connectionId).version
    const shown = turnAccess(h.t.app.ctx, principal(a.id))(h.connectionId)!.rulesVersion
    await hide(a, true)
    const hidden = turnAccess(h.t.app.ctx, principal(a.id))(h.connectionId)!.rulesVersion
    expect(hidden).not.toBe(shown)
    // Work running on its own for them is not hidden by their choice: its turns keep the version.
    const owner = ownerPrincipal(h.t.app.ctx, a.id)!
    expect(turnAccess(h.t.app.ctx, owner)(h.connectionId)!.rulesVersion).toBe(shown)
    await hide(a, false)
    expect(turnAccess(h.t.app.ctx, principal(a.id))(h.connectionId)!.rulesVersion).toBe(shown)
    expect(h.t.app.ctx.personalFields.get(h.connectionId).version).toBe(rules)
  })

  it('is closed to those who may not manage the connection, and takes nothing but a yes or no', async () => {
    const h = await team()
    const editor = h.user('editor')
    expect((await hide(editor, true)).statusCode).toBe(403)
    expect(isRestricted(h.t.app.ctx, principal(editor.id, 'editor'), h.connectionId)).toBe(false)
    const a = h.user('admin')
    expect((await a.call('PUT', '/personal-fields/self', { hidden: 'yes' })).statusCode).toBe(400)
    expect(
      (await a.call('PUT', '/personal-fields/self', { hidden: true, userId: editor.id })).statusCode,
    ).toBe(400)
    expect((await a.call('PUT', '/personal-fields/self', {})).statusCode).toBe(400)
    expect(h.t.app.ctx.personalFields.usersHidingFromSelf(h.connectionId)).toEqual([])
  })

  it('is no switch of the local user (404), whose rules always hide', async () => {
    const h = await dataHarness(mongo)
    open.push(h)
    h.t.app.ctx.personalFields.set(h.connectionId, RULES)
    expect((await h.call('PUT', '/personal-fields/self', { hidden: false })).statusCode).toBe(404)
    expect((await h.call('GET', '/personal-fields')).json()).toEqual({ rules: RULES })
    expect((await h.call('POST', `${NS}/find`, { filter: {}, limit: 5 })).body).not.toContain(S)
  })
})
