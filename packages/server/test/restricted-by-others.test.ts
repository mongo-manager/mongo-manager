// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it } from 'vitest'
import { ConnectionSettingsSchema } from '@mongo-manager/shared'
import { makeApp, type TestApp } from './helpers'
import { isRestricted, restrictedByOthers } from '../src/connections/access'
import type { Principal } from '../src/http/context'

/**
 * User report 2026-10-30: an administrator who hid personal data from themselves could not manage
 * MongoDB's accounts (the agent was refused three times). Hiding values from oneself — or local
 * mode's one person, who edits the rules — is how values are shown, not what one may do: only a
 * member an administrator gave masked access is kept from accounts.
 */
const apps: TestApp[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})

async function setup(auth: boolean) {
  const t = await makeApp({ auth })
  apps.push(t)
  const { ctx } = t.app
  const id = ctx.connections.create(
    {
      name: 'M',
      favorite: false,
      readOnly: false,
      settings: ConnectionSettingsSchema.parse({ hosts: [{ host: '127.0.0.1' }] }),
    },
    null,
  ).id
  ctx.personalFields.set(id, [{ db: 'shop', coll: 'users', field: 'email' }])
  return { ctx, id }
}
const user = (userId: string, username: string, role: 'admin' | 'editor'): Principal =>
  ({ kind: 'user', userId, username, role, sessionId: 's', sessionIdHash: 'h' }) as unknown as Principal

describe('who is kept from MongoDB’s accounts', () => {
  it('a member an administrator gives masked access, not one who hides values from themselves', async () => {
    const { ctx, id } = await setup(true)
    const admin = ctx.users.create({ username: 'ada', passwordHash: 'x', role: 'admin' })
    ctx.personalFields.setHiddenFromSelf(id, admin.id, true)
    expect(isRestricted(ctx, user(admin.id, 'ada', 'admin'), id)).toBe(true)
    expect(restrictedByOthers(ctx, user(admin.id, 'ada', 'admin'), id)).toBe(false)

    const bob = ctx.users.create({ username: 'bob', passwordHash: 'x', role: 'editor' })
    ctx.grants.set(id, bob.id, 'editor')
    ctx.grants.setMasked(id, bob.id, true)
    expect(restrictedByOthers(ctx, user(bob.id, 'bob', 'editor'), id)).toBe(true)
    ctx.grants.setMasked(id, bob.id, false)
    expect(restrictedByOthers(ctx, user(bob.id, 'bob', 'editor'), id)).toBe(false)
  })

  it('never local mode’s one person, whom the rules hide values from', async () => {
    const { ctx, id } = await setup(false)
    const local = { kind: 'local', userId: null, username: 'local' } as unknown as Principal
    expect(isRestricted(ctx, local, id)).toBe(true)
    expect(restrictedByOthers(ctx, local, id)).toBe(false)
  })
})
