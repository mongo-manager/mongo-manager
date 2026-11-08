// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { randomUUID } from 'node:crypto'
import { ConnectionSettingsSchema, type PersonalRule, type Role } from '@mongo-manager/shared'
import type { PartialConfig } from '../../src/config'
import { H, makeApp } from '../helpers'
import type { TestMongo } from './mongo'

export type Conn = 'A' | 'B' | 'A2'
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/**
 * Phase 3d-2: team mode with three connections — A and B on two different mongods, and A2 on A's
 * mongod reached as "localhost" (the same deployment under another name). Users get a role and
 * the masked flag per connection; calls take absolute /api/... URLs.
 */
export async function transferHarness(
  a: TestMongo,
  b: TestMongo,
  overrides: PartialConfig = {},
  /** Phase 3d-3b: app options (a logger for the D4 sweep). */
  extra: Parameters<typeof makeApp>[1] = {},
) {
  const t = await makeApp({ auth: true, ...overrides }, extra)
  const { ctx } = t.app
  const make = (name: string, host: string, port: number) =>
    ctx.connections.create(
      {
        name,
        favorite: false,
        readOnly: false,
        settings: ConnectionSettingsSchema.parse({
          hosts: [{ host, port }],
          serverSelectionTimeoutMS: 3_000,
        }),
      },
      null,
    ).id
  const ids: Record<Conn, string> = {
    A: make('A', '127.0.0.1', a.port),
    B: make('B', '127.0.0.1', b.port),
    A2: make('A2', 'localhost', a.port),
  }
  const user = (spec: { role?: Role; on?: Partial<Record<Conn, Role | 'none'>>; masked?: Conn[] } = {}) => {
    const role = spec.role ?? 'editor'
    const u = ctx.users.create({ username: `u-${randomUUID()}`, passwordHash: 'x', role })
    for (const c of Object.keys(ids) as Conn[]) {
      const grant = spec.on?.[c] ?? (spec.masked?.includes(c) ? role : undefined)
      if (grant) ctx.grants.set(ids[c], u.id, grant)
    }
    for (const c of spec.masked ?? []) ctx.grants.setMasked(ids[c], u.id, true)
    const s = ctx.sessions.create(u.id, {})
    const headers = { ...H, 'x-csrf-token': s.session.csrfToken }
    const cookies = { mm_sid: s.sessionId }
    const call = (method: Method, url: string, payload?: unknown) =>
      t.app.inject({
        method,
        url,
        headers,
        cookies,
        ...(payload === undefined ? {} : { payload: payload as object }),
      })
    /** Phase 3d-3a: raw bytes (octet-stream), for resumable uploads. */
    const raw = (method: Method, url: string, body: Buffer) =>
      t.app.inject({
        method,
        url,
        headers: { ...headers, 'content-type': 'application/octet-stream' },
        cookies,
        payload: body,
      })
    return { id: u.id, call, get: (url: string) => call('GET', url), raw }
  }
  const rules = (c: Conn, list: PersonalRule[]) => ctx.personalFields.set(ids[c], list)
  return { t, ctx, ids, user, rules }
}
