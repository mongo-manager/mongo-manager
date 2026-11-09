// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { MAX_LIBRARY_PINS, type LibraryItem } from '@mongo-manager/shared'
import { startMongo, type TestMongo } from './support/mongo'
import { dataHarness, teamHarness } from './support/data'

/**
 * W1 (completion §2): saved queries pinned by a user — first in the Queries page and on Home.
 * A pin is the user's own (kept with their preferences), and only what they may see can be pinned.
 */
let mongo: TestMongo
beforeAll(async () => {
  mongo = await startMongo()
})
afterAll(async () => {
  await mongo?.stop()
})
const closers: Array<{ close(): Promise<void> }> = []
afterEach(async () => {
  for (const c of closers.splice(0)) await c.close()
})

type Ctx = Awaited<ReturnType<typeof dataHarness>>['t']['app']['ctx']
function favourite(
  ctx: Ctx,
  connectionId: string,
  over: { ownerId?: string | null; shared?: boolean; name?: string; coll?: string; db?: string } = {},
) {
  return ctx.favourites.create({
    ownerId: over.ownerId ?? null,
    connectionId,
    db: over.db ?? 'shop',
    coll: over.coll ?? 'orders',
    name: over.name ?? 'Big orders',
    tags: [],
    text: JSON.stringify({ filter: { total: { $gt: 100 } } }),
    shared: over.shared ?? false,
  })
}

describe('pinning saved queries', () => {
  it('lists a pinned query first and says so, and unpins it', async () => {
    const h = await dataHarness(mongo)
    closers.push(h.t)
    const { ctx } = h.t.app
    const old = favourite(ctx, h.connectionId, { name: 'Old one' })
    h.t.clock.now += 1000
    favourite(ctx, h.connectionId, { name: 'New one' })
    const names = async () =>
      ((await h.call('GET', '/library?type=favourite')).json() as { items: LibraryItem[] }).items.map((i) => [
        i.name,
        i.pinned ?? false,
      ])
    expect(await names()).toEqual([
      ['New one', false],
      ['Old one', false],
    ])
    const pin = await h.call('PUT', '/library/pins', { type: 'favourite', id: old.id, pinned: true })
    expect(pin.statusCode).toBe(200)
    expect(pin.json()).toEqual({ pinned: true })
    expect(await names()).toEqual([
      ['Old one', true],
      ['New one', false],
    ])
    await h.call('PUT', '/library/pins', { type: 'favourite', id: old.id, pinned: false })
    expect((await names())[0]).toEqual(['New one', false])
  })

  it('pins a saved pipeline too, but never a history entry or a snippet', async () => {
    const h = await dataHarness(mongo)
    closers.push(h.t)
    const p = h.t.app.ctx.savedPipelines.create({
      ownerId: null,
      connectionId: h.connectionId,
      db: 'shop',
      coll: 'items',
      name: 'Report',
      tags: [],
      text: JSON.stringify([{ $limit: 1 }]),
      shared: false,
    })
    expect(
      (await h.call('PUT', '/library/pins', { type: 'pipeline', id: p.id, pinned: true })).statusCode,
    ).toBe(200)
    const items = ((await h.call('GET', '/library')).json() as { items: LibraryItem[] }).items
    expect(items.find((i) => i.id === p.id)!.pinned).toBe(true)
    for (const type of ['history', 'snippet'])
      expect(
        (await h.call('PUT', '/library/pins', { type, id: randomUUID(), pinned: true })).statusCode,
      ).toBe(400)
  })

  it('refuses what the user cannot see: another user’s private query, another connection’s, a missing one', async () => {
    const h = await teamHarness(mongo)
    closers.push(h.t)
    const { ctx } = h.t.app
    const alice = h.user('editor')
    const bob = h.user('editor')
    const mine = favourite(ctx, h.connectionId, { ownerId: alice.id })
    const shared = favourite(ctx, h.connectionId, { ownerId: alice.id, shared: true, name: 'Shared' })
    const other = ctx.connections.create(
      {
        name: 'Other',
        favorite: false,
        readOnly: false,
        settings: ctx.connections.get(h.connectionId)!.settings,
      },
      null,
    )
    const elsewhere = favourite(ctx, other.id, { ownerId: bob.id })
    const pin = (who: typeof bob, id: string, pinned = true) =>
      who.call('PUT', '/library/pins', { type: 'favourite', id, pinned })
    expect((await pin(bob, mine.id)).statusCode).toBe(404)
    expect((await pin(bob, elsewhere.id)).statusCode).toBe(404)
    expect((await pin(bob, randomUUID())).statusCode).toBe(404)
    expect((await pin(bob, shared.id)).statusCode).toBe(200)
    // Pins are each user's own: Alice sees nothing pinned.
    const list = async (who: typeof bob) =>
      ((await who.call('GET', '/library?type=favourite')).json() as { items: LibraryItem[] }).items
    expect((await list(bob)).find((i) => i.id === shared.id)!.pinned).toBe(true)
    expect((await list(alice)).every((i) => !i.pinned)).toBe(true)
    // Unshared, the pin no longer shows Bob anything.
    ctx.favourites.update(shared.id, { name: 'Shared', text: shared.text, shared: false })
    expect((await list(bob)).some((i) => i.id === shared.id)).toBe(false)
    // Unpinning is always allowed (it only changes the user's own list).
    expect((await pin(bob, mine.id, false)).statusCode).toBe(200)
  })

  it('refuses a credential collection’s saved query to one who may not read it (admin-only namespaces)', async () => {
    const h = await teamHarness(mongo)
    closers.push(h.t)
    const admin = h.user('admin')
    const viewer = h.user('viewer')
    const users = favourite(h.t.app.ctx, h.connectionId, {
      db: 'admin',
      coll: 'system.users',
      shared: true,
      ownerId: admin.id,
    })
    expect(
      (await viewer.call('PUT', '/library/pins', { type: 'favourite', id: users.id, pinned: true }))
        .statusCode,
    ).toBe(404)
  })

  it('holds a bounded number of pins, forgetting those of deleted queries', async () => {
    const h = await dataHarness(mongo)
    closers.push(h.t)
    const { ctx } = h.t.app
    const ids = Array.from(
      { length: MAX_LIBRARY_PINS + 1 },
      (_, i) => favourite(ctx, h.connectionId, { name: `q${i}`, coll: `c${i}` }).id,
    )
    for (const id of ids.slice(0, MAX_LIBRARY_PINS))
      expect((await h.call('PUT', '/library/pins', { type: 'favourite', id, pinned: true })).statusCode).toBe(
        200,
      )
    const over = await h.call('PUT', '/library/pins', { type: 'favourite', id: ids.at(-1), pinned: true })
    expect(over.statusCode).toBe(409)
    expect(over.json()).toMatchObject({ details: { reason: 'limit', max: MAX_LIBRARY_PINS } })
    ctx.favourites.delete(ids[0]!)
    expect(
      (await h.call('PUT', '/library/pins', { type: 'favourite', id: ids.at(-1), pinned: true })).statusCode,
    ).toBe(200)
  })

  // W1 review (minor 1): a pin the user can no longer see holds no place, so they never get stuck.
  it('counts only the pins the user can still see toward the limit', async () => {
    const h = await teamHarness(mongo)
    closers.push(h.t)
    const { ctx } = h.t.app
    const alice = h.user('editor')
    const bob = h.user('editor')
    const shared = Array.from({ length: MAX_LIBRARY_PINS }, (_, i) =>
      favourite(ctx, h.connectionId, { ownerId: alice.id, shared: true, name: `s${i}`, coll: `c${i}` }),
    )
    for (const f of shared)
      expect(
        (await bob.call('PUT', '/library/pins', { type: 'favourite', id: f.id, pinned: true })).statusCode,
      ).toBe(200)
    const extra = favourite(ctx, h.connectionId, { ownerId: bob.id, name: 'mine' })
    const pinExtra = () => bob.call('PUT', '/library/pins', { type: 'favourite', id: extra.id, pinned: true })
    expect((await pinExtra()).statusCode).toBe(409)
    // Alice stops sharing one: Bob no longer sees it, and its pin no longer counts.
    ctx.favourites.update(shared[0]!.id, { name: 's0', text: shared[0]!.text, shared: false })
    expect((await pinExtra()).statusCode).toBe(200)
  })

  // W1 review (minor 2): a connection's pins go with it, every user's.
  it('forgets every user’s pins of a deleted connection', async () => {
    const h = await teamHarness(mongo)
    closers.push(h.t)
    const { ctx } = h.t.app
    const admin = h.user('admin')
    const bob = h.user('editor')
    const f = favourite(ctx, h.connectionId, { ownerId: bob.id })
    expect(
      (await bob.call('PUT', '/library/pins', { type: 'favourite', id: f.id, pinned: true })).statusCode,
    ).toBe(200)
    expect(ctx.preferences.get(bob.id, `library-pins:${h.connectionId}`)).not.toBeNull()
    const gone = await admin.call('DELETE', '')
    expect(gone.statusCode, gone.body).toBe(204)
    expect(ctx.preferences.get(bob.id, `library-pins:${h.connectionId}`)).toBeNull()
  })

  it('refuses a malformed pin', async () => {
    const h = await dataHarness(mongo)
    closers.push(h.t)
    for (const body of [
      {},
      { type: 'favourite', id: 'not-a-uuid', pinned: true },
      { type: 'favourite', id: randomUUID() },
    ])
      expect((await h.call('PUT', '/library/pins', body)).statusCode).toBe(400)
  })
})
