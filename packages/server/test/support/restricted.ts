import { randomUUID } from 'node:crypto'
import { ConnectionSettingsSchema, type PersonalRule, type Role } from '@mongo-manager/shared'
import { H, makeApp } from '../helpers'
import type { PartialConfig } from '../../src/config'
import type { TestMongo } from './mongo'

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/**
 * Phase 3c: an app with one connection to `mongo`, personal-field rules, and users with or without
 * the masked flag. `as(role, masked)` answers a caller for paths under /api/connections/:id.
 */
export async function restrictedApp(mongo: TestMongo, rules: PersonalRule[], overrides: PartialConfig = {}) {
  const t = await makeApp({ auth: true, ...overrides })
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
  ctx.personalFields.set(connectionId, rules)
  const as = (role: Role, masked = false) => {
    const user = ctx.users.create({ username: `u-${randomUUID()}`, passwordHash: 'x', role })
    ctx.grants.set(connectionId, user.id, role)
    if (masked) ctx.grants.setMasked(connectionId, user.id, true)
    const s = ctx.sessions.create(user.id, {})
    const headers = { ...H, 'x-csrf-token': s.session.csrfToken }
    const cookies = { mm_sid: s.sessionId }
    const call = (method: Method, path: string, payload?: unknown) =>
      t.app.inject({
        method,
        url: `/api/connections/${connectionId}${path}`,
        headers,
        cookies,
        ...(payload === undefined ? {} : { payload: payload as object }),
      })
    // Phase 3d-1: raw uploads, absolute /api URLs, and turning the masked flag on afterwards.
    return Object.assign(call, {
      id: user.id,
      raw: (method: Method, path: string, body: Buffer) =>
        t.app.inject({
          method,
          url: `/api/connections/${connectionId}${path}`,
          headers: { ...headers, 'content-type': 'application/octet-stream' },
          cookies,
          payload: body,
        }),
      get: (url: string) => t.app.inject({ method: 'GET', url, headers, cookies }),
      makeRestricted: () => ctx.grants.setMasked(connectionId, user.id, true),
    })
  }
  return { t, ctx, connectionId, as }
}
