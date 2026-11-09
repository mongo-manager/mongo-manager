// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { permissionsFor, type Permission } from '@mongo-manager/shared'
import { ConnectionSettingsSchema } from '@mongo-manager/shared'
import { H, makeApp, type TestApp } from './helpers'
import { startMongo, type TestMongo } from './support/mongo'

let mongo: TestMongo
let t: TestApp
let connectionId: string
beforeAll(async () => {
  mongo = await startMongo()
  t = await makeApp({ auth: true })
  connectionId = t.app.ctx.connections.create(
    {
      name: 'M',
      favorite: false,
      readOnly: false,
      settings: ConnectionSettingsSchema.parse({ hosts: [{ host: '127.0.0.1', port: mongo.port }] }),
    },
    null,
  ).id
})
afterAll(async () => {
  await t?.close()
  await mongo?.stop()
})

const ns = '/databases/perm/collections/items'
const ROUTES: Array<
  [
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    permission: Permission,
    payload?: object,
  ]
> = [
  ['GET', '/databases', 'databases:read'],
  ['POST', '/databases', 'databases:write', { name: 'perm2', collection: 'c' }],
  ['GET', '/databases/perm/stats', 'databases:read'],
  ['DELETE', '/databases/perm-none', 'databases:write', { confirm: 'x' }],
  ['GET', '/databases/perm/collections', 'databases:read'],
  ['POST', '/databases/perm/collections', 'databases:write', { kind: 'collection', name: 'c2' }],
  ['POST', `${ns}/rename`, 'databases:write', { to: 'z' }],
  ['GET', `${ns}/stats`, 'databases:read'],
  ['DELETE', ns, 'databases:write', { confirm: 'x' }],
  // W2.2, W2.4: a view's pipeline and a collection's pre/post images.
  ['GET', `${ns}/view`, 'databases:read'],
  [
    'PUT',
    `${ns}/view`,
    'databases:write',
    {
      viewOn: 'other',
      pipeline: [],
      confirm: 'items',
      base: { viewOn: 'other', pipeline: [] },
    },
  ],
  ['PATCH', `${ns}/options`, 'databases:write', { changeStreamPreAndPostImages: true, confirm: 'items' }],
  ['POST', `${ns}/find`, 'documents:read', {}],
  ['POST', `${ns}/count`, 'documents:read', {}],
  ['POST', `${ns}/documents/get`, 'documents:read', { _id: 1 }],
  ['POST', `${ns}/documents`, 'documents:write', { documents: [{}] }],
  ['POST', `${ns}/documents/update`, 'documents:write', { _id: 1, set: { a: 1 }, hash: '0'.repeat(64) }],
  ['POST', `${ns}/documents/replace`, 'documents:write', { _id: 1, document: {}, hash: '0'.repeat(64) }],
  ['POST', `${ns}/documents/delete`, 'documents:write', { _id: 1 }],
  ['POST', `${ns}/bulk/preview`, 'documents:read', { filter: {}, operation: 'delete' }],
  ['POST', `${ns}/bulk/execute`, 'documents:write', { filter: {}, operation: 'delete', filterHash: 'x' }],
  ['POST', `${ns}/duplicate`, 'databases:write', { to: 'copy' }],
  ['GET', `${ns}/indexes`, 'databases:read'],
  ['POST', `${ns}/indexes`, 'indexes:write', { key: { a: 1 } }],
  ['PATCH', `${ns}/indexes/a_1`, 'indexes:write', { hidden: true }],
  ['DELETE', `${ns}/indexes/a_1`, 'indexes:write'],
  // W2.6: search indexes.
  ['GET', `${ns}/search-indexes`, 'databases:read'],
  ['POST', `${ns}/search-indexes`, 'indexes:write', { name: 'x', type: 'search', definition: {} }],
  ['PATCH', `${ns}/search-indexes/x`, 'indexes:write', { definition: {} }],
  ['DELETE', `${ns}/search-indexes/x`, 'indexes:write'],
]

describe('data permission matrix (S12)', () => {
  for (const role of ['viewer', 'editor', 'admin'] as const) {
    it(`enforces ${role} permissions on every data route`, async () => {
      const user = t.app.ctx.users.create({ username: `m-${role}`, passwordHash: 'x', role })
      const { sessionId, session } = t.app.ctx.sessions.create(user.id, {})
      const allowed = permissionsFor(role)
      for (const [method, path, permission, payload] of ROUTES) {
        const res = await t.app.inject({
          method,
          url: `/api/connections/${connectionId}${path}`,
          headers: { ...H, 'x-csrf-token': session.csrfToken },
          cookies: { mm_sid: sessionId },
          ...(payload ? { payload } : {}),
        })
        const label = `${role} ${method} ${path} → ${res.statusCode}`
        if (allowed.has(permission)) expect(res.statusCode, label).not.toBe(403)
        else expect([res.statusCode, res.json().code], label).toEqual([403, 'FORBIDDEN'])
      }
    })
  }
})
