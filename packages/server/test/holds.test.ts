// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { requireConnection } from '../src/connections/access'
import { clientFor } from '../src/data/mongo-errors'
import { startMongo, type TestMongo } from './support/mongo'
import { dataHarness } from './support/data'

let mongo: TestMongo
beforeAll(async () => {
  mongo = await startMongo()
})
afterAll(async () => {
  await mongo?.stop()
})

const holdsOf = (manager: unknown) => (manager as { holds: Map<string, number> }).holds

describe('a request keeps its connection open until it answers (long operations)', () => {
  it('holds the client while the handler runs and releases it with the response', async () => {
    const h = await dataHarness(mongo)
    let finish: () => void = () => {}
    const gate = new Promise<void>((r) => (finish = r))
    h.t.app.get(
      '/api/connections/:id/t/slow',
      { preHandler: requireConnection('documents:read') },
      async (req) => {
        await clientFor(req)
        await gate
        return { ok: true }
      },
    )
    const holds = holdsOf(h.t.app.ctx.manager)
    const pending = h.call('GET', '/t/slow')
    await new Promise((r) => setTimeout(r, 50))
    expect(holds.get(h.connectionId)).toBe(1)
    finish()
    expect((await pending).statusCode).toBe(200)
    expect(holds.has(h.connectionId)).toBe(false)
    // An error answer releases too.
    const failed = await h.call('POST', '/databases/x/collections/y/find', { filter: { $where: '1' } })
    expect(failed.statusCode).toBeGreaterThanOrEqual(400)
    expect(holds.has(h.connectionId)).toBe(false)
    await h.t.close()
  })
})
