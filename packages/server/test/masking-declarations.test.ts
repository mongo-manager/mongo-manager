// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startMongo, type TestMongo } from './support/mongo'
import { restrictedApp } from './support/restricted'
import { slow } from './support/slowness'

/** Phase 3c §6: every connection route says how it treats personal data, and the server enforces it. */
const MODES = new Set(['guarded', 'names-only', 'denied', 'denied-when-ruled'])
let mongo: TestMongo
beforeAll(async () => {
  mongo = await startMongo()
}, slow(120_000))
afterAll(async () => {
  await mongo?.stop()
})

describe('masking declarations (phase 3c §6)', () => {
  it('every connection route declares how it treats personal data', async () => {
    const { t } = await restrictedApp(mongo, [])
    try {
      const missing = [...t.app.routeMasking.entries()]
        .filter(([, mode]) => !mode || !MODES.has(mode))
        .map(([route]) => route)
      expect(missing).toEqual([])
      expect(t.app.routeMasking.size).toBeGreaterThan(40)
      // Every connection route of the inventory is in the declarations.
      const connectionRoutes = [...t.app.routeInventory].filter((r) =>
        /\/api\/connections\/:id(\/|$)/.test(r),
      )
      expect(connectionRoutes.sort()).toEqual([...t.app.routeMasking.keys()].sort())
    } finally {
      await t.close()
    }
  })

  it('lets a restricted user write a ruled namespace without personal values, and denies the moves that stay denied', async () => {
    const { t, as } = await restrictedApp(mongo, [{ db: 'crm', coll: 'users', field: 'email' }])
    try {
      const user = as('editor', true)
      // Phase 3c-2: a ruled namespace takes documents without personal values, and refuses the rest.
      const ruled = await user('POST', '/databases/crm/collections/users/documents', {
        documents: [{ name: 'x' }],
      })
      expect(ruled.statusCode).toBe(200)
      const personal = await user('POST', '/databases/crm/collections/users/documents', {
        documents: [{ email: 'x' }],
      })
      expect(personal.statusCode).toBe(403)
      expect(personal.json().details).toMatchObject({ reason: 'personal_write' })
      // Still denied where rules apply: duplicating a ruled collection.
      const duplicate = await user('POST', '/databases/crm/collections/users/duplicate', { to: 'copy' })
      expect(duplicate.json().details).toMatchObject({ reason: 'masking_unsupported' })
      const free = await user('POST', '/databases/crm/collections/notes/documents', {
        documents: [{ name: 'x' }],
      })
      expect(free.statusCode).toBe(200)
      const full = await as('editor')('POST', '/databases/crm/collections/users/documents', {
        documents: [{ name: 'y' }],
      })
      expect(full.statusCode).toBe(200)
      // A database where a rule applies: a new collection is fine, a view over ruled data is not (§5.3).
      const create = await user('POST', '/databases/crm/collections', { kind: 'collection', name: 'fresh' })
      expect(create.statusCode).toBe(201)
      const view = await user('POST', '/databases/crm/collections', {
        kind: 'view',
        name: 'v',
        viewOn: 'users',
        pipeline: [],
      })
      expect(view.statusCode).toBe(403)
    } finally {
      await t.close()
    }
  })
})
