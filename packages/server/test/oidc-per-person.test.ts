// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it } from 'vitest'
import { ConnectionSettingsSchema } from '@mongo-manager/shared'
import { H, makeApp, type TestApp } from './helpers'
import { HealthCache } from '../src/connections/health'
import { ConnectionError, OIDC_PER_PERSON } from '../src/connections/errors'
import type { ConnectionManager } from '../src/connections/manager'

/**
 * W7, security review Minor 4: in team mode a per-person OIDC connection has no client of the
 * server's own. What runs on its own — the profiler's revert, health, history — cannot act on it,
 * and says so instead of failing in silence (or leaving the profiler at level 2 for good).
 */
const apps: TestApp[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})

const oidc = ConnectionSettingsSchema.parse({
  hosts: [{ host: 'localhost', port: 27017 }],
  auth: { mechanism: 'MONGODB-OIDC' },
})

describe('W7 (security review Minor 4): per-person OIDC connections in team mode', () => {
  // Abuse case: level 2 records every command with its values; its revert runs with no person
  // behind it, so it could never switch it off again.
  it('refuses profiler level 2, whose revert would have no one to sign in as', async () => {
    const t = await makeApp({ auth: true })
    apps.push(t)
    const { ctx } = t.app
    const conn = ctx.connections.create({ name: 'o', favorite: false, readOnly: false, settings: oidc }, null)
    const admin = ctx.users.create({ username: 'root', passwordHash: 'x', role: 'admin' })
    const s = ctx.sessions.create(admin.id, {})
    const res = await t.app.inject({
      method: 'PUT',
      url: `/api/connections/${conn.id}/server/profiler/shop`,
      headers: { ...H, 'x-csrf-token': s.session.csrfToken },
      cookies: { mm_sid: s.sessionId },
      payload: { level: 2, slowms: 100, sampleRate: 1, confirm: true },
    })
    expect(res.statusCode).toBe(409)
    // Sixth review of the open's stop (nit 3): its own reason, so its own words (level 1 instead).
    expect(res.json().details).toMatchObject({ reason: 'oidc_level2' })
  })

  it('shows its health as needing each person’s sign-in, not as down', async () => {
    const manager = {
      hold: () => () => undefined,
      getClient: async () => {
        throw new ConnectionError('oidc', OIDC_PER_PERSON)
      },
      isOpen: () => true,
      version: async () => null,
    } as unknown as ConnectionManager
    const cache = new HealthCache({ manager, now: () => 0 })
    expect((await cache.get('c1', true)).state).toBe('per_person')
  })
})
