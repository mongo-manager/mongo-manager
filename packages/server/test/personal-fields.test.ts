// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it } from 'vitest'
import { ConnectionSettingsSchema } from '@mongo-manager/shared'
import { H, makeApp, type TestApp } from './helpers'

/**
 * Phase 3b spec §2.1-2.2: a connection admin lists the fields that hold personal data; a user
 * granted "cannot see personal data" is restricted, and never gets the shell.
 */
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
      settings: ConnectionSettingsSchema.parse({ hosts: [{ host: '127.0.0.1' }] }),
    },
    null,
  ).id
  const as = (role: 'admin' | 'editor' | 'viewer', grant?: 'admin' | 'editor' | 'viewer') => {
    const user = ctx.users.create({ username: `u-${role}-${Math.random()}`, passwordHash: 'x', role })
    if (grant) ctx.grants.set(connectionId, user.id, grant)
    const s = ctx.sessions.create(user.id, {})
    const call = (method: 'GET' | 'PUT', url: string, payload?: object) =>
      t.app.inject({
        method,
        url: `/api${url}`,
        headers: { ...H, 'x-csrf-token': s.session.csrfToken },
        cookies: { mm_sid: s.sessionId },
        ...(payload ? { payload } : {}),
      })
    return { id: user.id, call }
  }
  const audit = (action: string) =>
    ctx.store.db.prepare('SELECT details FROM audit_log WHERE action = ?').all(action) as Array<{
      details: string
    }>
  return { t, ctx, connectionId, as, audit }
}

const rules = [{ db: 'crm', coll: 'users', field: 'email' }]

describe('personal-field rules routes (phase 3b §2.1)', () => {
  it('gives a restricted user the rules that hide values from them, names only (phase 3c §7)', async () => {
    const { ctx, connectionId, as } = await setup()
    ctx.personalFields.set(connectionId, rules)
    const masked = as('editor', 'editor')
    ctx.grants.setMasked(connectionId, masked.id, true)
    const plain = as('editor', 'editor')
    const url = `/connections/${connectionId}/personal-fields/applied`
    // User report 2026-10-27: and whether values are hidden from them there (the connection, here).
    expect((await masked.call('GET', url)).json()).toEqual({ rules, reaches: true })
    expect((await plain.call('GET', url)).json()).toEqual({ rules: [], reaches: false })
  })

  it('let a connection admin read and replace the rules, audited with counts only', async () => {
    const { connectionId, as, audit } = await setup()
    const admin = as('editor', 'admin')
    const url = `/connections/${connectionId}/personal-fields`
    expect((await admin.call('GET', url)).json()).toEqual({ rules: [], hiddenFromMe: false })
    const put = await admin.call('PUT', url, { rules })
    expect(put.statusCode).toBe(200)
    expect((await admin.call('GET', url)).json()).toEqual({ rules, hiddenFromMe: false })
    const row = audit('connections.personalFields')[0]!
    expect(JSON.parse(row.details)).toMatchObject({ before: 0, after: 1 })
    expect(row.details).not.toContain('email')
  })

  it('are closed to editors and viewers, and refuse an invalid list', async () => {
    const { connectionId, as } = await setup()
    const url = `/connections/${connectionId}/personal-fields`
    for (const u of [as('editor', 'editor'), as('viewer', 'viewer')]) {
      expect((await u.call('GET', url)).statusCode).toBe(403)
      expect((await u.call('PUT', url, { rules })).statusCode).toBe(403)
    }
    const bad = await as('admin').call('PUT', url, { rules: [{ db: 'crm', coll: 'users', field: '*' }] })
    expect(bad.statusCode).toBe(400)
  })

  it('refuse a change made on rules that changed meanwhile, and keep them (user request 2026-10-24)', async () => {
    const { ctx, connectionId, as, audit } = await setup()
    ctx.personalFields.set(connectionId, rules)
    const admin = as('admin')
    const url = `/connections/${connectionId}/personal-fields`
    const phone = { db: 'crm', coll: 'users', field: 'phone' }
    // Read before another admin added `card`: the change made on what was read is refused.
    ctx.personalFields.set(connectionId, [...rules, { db: 'crm', coll: 'users', field: 'card' }])
    const stale = await admin.call('PUT', url, { rules: [...rules, phone], base: rules })
    expect(stale.statusCode).toBe(409)
    expect(stale.json().code).toBe('CONFLICT')
    expect(ctx.personalFields.stored(connectionId).rules).toHaveLength(2)
    // Audited as refused, with no rule in it.
    const [refused] = audit('connections.personalFields')
    expect(JSON.parse(refused!.details)).toMatchObject({ status: 409 })
    expect(refused!.details).not.toMatch(/phone|card|email/)
    // On the rules as they are, it is saved.
    const fresh = ctx.personalFields.stored(connectionId).rules
    const ok = await admin.call('PUT', url, { rules: [...fresh, phone], base: fresh })
    expect(ok.statusCode).toBe(200)
    expect(ctx.personalFields.stored(connectionId).rules).toEqual([...fresh, phone])
    // A base is a list of rules like any other, and nothing else is taken.
    const bad = await admin.call('PUT', url, {
      rules: fresh,
      base: [{ db: 'crm', coll: 'users', field: '*' }],
    })
    expect(bad.statusCode).toBe(400)
    expect((await admin.call('PUT', url, { rules: fresh, other: 1 })).statusCode).toBe(400)
  })

  // Fourth review (n4): the page takes the answer as the rules stored. The store leaves a restore
  // drill's scratch rules out; a rule naming a scratch database never reaches it, refused first.
  it("refuses a rule naming a drill's scratch database, so what it answers is what it stored", async () => {
    const { ctx, connectionId, as } = await setup()
    ctx.personalFields.set(connectionId, rules)
    const put = await as('admin').call('PUT', `/connections/${connectionId}/personal-fields`, {
      rules: [...rules, { db: 'mm_drill_1', coll: 'users', field: 'email' }],
    })
    expect(put.statusCode).toBe(403)
    expect(ctx.personalFields.stored(connectionId).rules).toEqual(rules)
  })

  it('store the rules sealed', async () => {
    const { ctx, connectionId, as } = await setup()
    await as('admin').call('PUT', `/connections/${connectionId}/personal-fields`, { rules })
    const raw = ctx.store.db.prepare('SELECT rules FROM personal_fields').get() as { rules: string }
    expect(raw.rules).not.toContain('email')
  })
})

describe('the restricted grant (phase 3b §2.2)', () => {
  it('is set with the grant, reported to the user, and excludes the shell', async () => {
    const { ctx, connectionId, as } = await setup()
    const admin = as('admin')
    const ed = as('editor')
    const put = (body: object) => admin.call('PUT', `/connections/${connectionId}/grants/${ed.id}`, body)
    expect((await put({ role: 'editor', masked: true })).statusCode).toBe(204)
    expect(ctx.grants.maskedGrant(connectionId, ed.id)).toBe(true)
    const list = (await ed.call('GET', '/connections')).json() as Array<{
      id: string
      restricted: boolean
      shell: boolean
    }>
    expect(list.find((c) => c.id === connectionId)).toMatchObject({ restricted: true, shell: false })
    expect((await put({ role: 'editor', shell: true })).statusCode).toBe(409)
    expect((await put({ role: 'editor', masked: true, shell: true })).statusCode).toBe(409)
    // A refused change leaves the stored grant as it was.
    expect(ctx.grants.shellGrant(connectionId, ed.id)).toBe(false)
    // The shell gate refuses a restricted user even if the flag was set by other means.
    ctx.grants.setShell(connectionId, ed.id, true)
    expect((await ed.call('GET', `/connections/${connectionId}/shell/history`)).statusCode).toBe(403)
    // Lifting the restriction and granting the shell together is allowed.
    expect((await put({ role: 'editor', masked: false, shell: true })).statusCode).toBe(204)
  })

  it('never restricts a connection admin', async () => {
    const { ctx, connectionId, as } = await setup()
    const a = as('editor', 'admin')
    ctx.grants.setMasked(connectionId, a.id, true)
    const list = (await a.call('GET', '/connections')).json() as Array<{ id: string; restricted: boolean }>
    expect(list.find((c) => c.id === connectionId)!.restricted).toBe(false)
  })
})
