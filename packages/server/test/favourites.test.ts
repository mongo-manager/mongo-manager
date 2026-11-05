// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FavouriteView, SavedPipelineView } from '@mongo-manager/shared'
import { TagsSchema } from '@mongo-manager/shared'
import { dataHarness, teamHarness } from './support/data'
import type { TestMongo } from './support/mongo'
import { openStore } from '../src/store/db'
import { createSecretBox, loadOrCreateKey } from '../src/crypto/secret-box'
import { ConnectionRepo } from '../src/connections/repo'
import { FavouriteRepo } from '../src/queries/favourites'
import { rotateSecretKey } from '../src/crypto/rotate'

/** Favourites never talk to MongoDB: the connection only has to exist. */
const NO_MONGO = { port: 1 } as TestMongo
const closers: Array<{ t: { close(): Promise<void> } }> = []
const dirs: string[] = []
afterEach(async () => {
  for (const h of closers.splice(0)) await h.t.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const BASE = '/databases/shop/collections/orders/favourites'
const query = {
  filter: { total: { $gt: { $numberLong: '100' } } },
  sort: { at: { $numberInt: '-1' } },
}

async function local() {
  const h = await dataHarness(NO_MONGO)
  closers.push(h)
  return h
}

describe('tags (phase 2c spec §2.1, Review Focus 5)', () => {
  it('trims, lower-cases and removes duplicates, and refuses other characters', () => {
    expect(TagsSchema.parse([' Hot ', 'hot', 'Q3'])).toEqual(['hot', 'q3'])
    // A leading # is dropped (final review 2c, I3): the Library shows tags as #tag.
    expect(TagsSchema.parse(['#x'])).toEqual(['x'])
    expect(TagsSchema.safeParse(['has space']).success).toBe(false)
    expect(TagsSchema.safeParse(Array.from({ length: 11 }, (_, i) => `t${i}`)).success).toBe(false)
    expect(TagsSchema.safeParse(['x'.repeat(31)]).success).toBe(false)
  })
})

describe('favourites (phase 2c spec §2.2)', () => {
  it('saves, lists, updates and deletes a find, keeping its EJSON types and tags', async () => {
    const h = await local()
    const created = await h.call('POST', BASE, { name: 'Big orders', tags: ['Sales', 'q3'], query })
    expect(created.statusCode, created.body).toBe(201)
    const fav = created.json() as FavouriteView
    expect(fav).toMatchObject({ name: 'Big orders', tags: ['sales', 'q3'], query, shared: false, mine: true })
    expect(((await h.call('GET', BASE)).json() as { favourites: FavouriteView[] }).favourites).toHaveLength(1)
    const updated = await h.call('PUT', `${BASE}/${fav.id}`, {
      name: 'Renamed',
      tags: [],
      query: { filter: {} },
    })
    expect(updated.json()).toMatchObject({ name: 'Renamed', tags: [] })
    expect((await h.call('DELETE', `${BASE}/${fav.id}`)).statusCode).toBe(204)
  })

  it('refuses a tag with other characters, naming the allowed ones', async () => {
    const h = await local()
    const res = await h.call('POST', BASE, { name: 'x', tags: ['satış'], query })
    expect(res.statusCode).toBe(400)
    expect(JSON.stringify(res.json())).toMatch(/a-z/)
  })

  it('keeps the query sealed at rest, and a moved seal does not open', async () => {
    const h = await local()
    const a = (await h.call('POST', BASE, { name: 'a', query: { filter: { ssn: '123-45-6789' } } })).json()
    const b = (await h.call('POST', BASE, { name: 'b', query: { filter: {} } })).json()
    const db = h.t.app.ctx.store.db
    expect(JSON.stringify(db.prepare('SELECT * FROM saved_queries').all())).not.toContain('123-45-6789')
    const sealed = (db.prepare('SELECT query FROM saved_queries WHERE id = ?').get(a.id) as { query: string })
      .query
    db.prepare('UPDATE saved_queries SET query = ? WHERE id = ?').run(sealed, b.id)
    const names = ((await h.call('GET', BASE)).json() as { favourites: FavouriteView[] }).favourites.map(
      (f) => f.name,
    )
    expect(names).toEqual(['a'])
  })

  it('refuses a query too large, a name too long, and a 201st favourite of one collection', async () => {
    const h = await local()
    expect((await h.call('POST', BASE, { name: 'x'.repeat(101), query })).statusCode).toBe(400)
    const big = { filter: { a: 'x'.repeat(70 * 1024) } }
    expect((await h.call('POST', BASE, { name: 'big', query: big })).statusCode).toBe(400)
    for (let i = 0; i < 200; i++)
      h.t.app.ctx.favourites.create({
        ownerId: null,
        connectionId: h.connectionId,
        db: 'shop',
        coll: 'orders',
        name: `f${i}`,
        text: '{"filter":{}}',
        shared: false,
      })
    expect((await h.call('POST', BASE, { name: 'more', query })).json().code).toBe('CONFLICT')
  })

  it('shows private favourites to their owner, shared ones to all, ownerless ones to admins only', async () => {
    const h = await teamHarness(NO_MONGO)
    closers.push(h)
    const [ada, bob] = [h.user('editor'), h.user('viewer')]
    const mine = (await ada.call('POST', BASE, { name: 'private', query })).json() as FavouriteView
    const team = (await ada.call('POST', BASE, { name: 'team', query, shared: true })).json() as FavouriteView
    h.t.app.ctx.favourites.create({
      ownerId: null,
      connectionId: h.connectionId,
      db: 'shop',
      coll: 'orders',
      name: 'from local mode',
      text: '{"filter":{}}',
      shared: false,
    })
    const names = async (u: ReturnType<typeof h.user>) =>
      ((await u.call('GET', BASE)).json() as { favourites: FavouriteView[] }).favourites.map((f) => f.name)
    expect(await names(bob)).toEqual(['team'])
    expect((await bob.call('PUT', `${BASE}/${team.id}`, { name: 'x', query })).statusCode).toBe(403)
    expect((await bob.call('DELETE', `${BASE}/${mine.id}`)).statusCode).toBe(404)
    const admin = h.user('admin')
    expect((await names(admin)).sort()).toEqual(['from local mode', 'team'])
    expect((await admin.call('DELETE', `${BASE}/${team.id}`)).statusCode).toBe(204)
  })

  it("keeps a deleted user's shared favourites, without an owner, and drops the private ones", async () => {
    const h = await teamHarness(NO_MONGO)
    closers.push(h)
    const ada = h.user('editor')
    await ada.call('POST', BASE, { name: 'private', query })
    await ada.call('POST', BASE, { name: 'team', query, shared: true })
    h.t.app.ctx.users.delete(ada.id)
    expect(h.t.app.ctx.store.db.prepare('SELECT name, owner_id FROM saved_queries').all()).toEqual([
      { name: 'team', owner_id: null },
    ])
  })

  it('audits saves and deletes by name and tags, never with the query', async () => {
    const h = await local()
    const fav = (
      await h.call('POST', BASE, {
        name: 'audited',
        tags: ['x'],
        query: { filter: { card: 'qz-card-4111' } },
      })
    ).json()
    await h.call('DELETE', `${BASE}/${fav.id}`)
    const rows = h.t.app.ctx.audit.list({ limit: 10 }).filter((r) => r.action.startsWith('favourites.'))
    expect(rows.map((r) => r.action).sort()).toEqual(['favourites.delete', 'favourites.save'])
    expect(rows.find((r) => r.action === 'favourites.save')!.details).toMatchObject({
      name: 'audited',
      tags: ['x'],
    })
    expect(JSON.stringify(rows)).not.toContain('qz-card-4111')
  })
})

describe('tags on saved pipelines (phase 2c spec §2.2)', () => {
  it('saves and answers tags; pipelines saved before answer none', async () => {
    const h = await local()
    const path = '/databases/shop/collections/orders/pipelines'
    const tagged = (
      await h.call('POST', path, { name: 'p', tags: ['Etl'], stages: [] })
    ).json() as SavedPipelineView
    expect(tagged.tags).toEqual(['etl'])
    h.t.app.ctx.store.db.prepare("UPDATE saved_pipelines SET tags = '[]'").run()
    const list = ((await h.call('GET', path)).json() as { pipelines: SavedPipelineView[] }).pipelines
    expect(list[0]!.tags).toEqual([])
  })
})

describe('favourites and rotate-key', () => {
  it('are re-sealed with the new key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-favourites-'))
    dirs.push(dir)
    const box = createSecretBox(loadOrCreateKey({ dataDir: dir }))
    let store = await openStore(dir)
    const conn = new ConnectionRepo(store.db, box, Date.now).create(
      { name: 'P', settings: { hosts: [{ host: 'h' }] } } as never,
      null,
    )
    new FavouriteRepo(store.db, box, Date.now).create({
      ownerId: null,
      connectionId: conn.id,
      db: 'shop',
      coll: 'orders',
      name: 'kept',
      text: '{"filter":{"a":1}}',
      shared: false,
    })
    store.close()
    const result = await rotateSecretKey({ dataDir: dir })
    expect(result.favourites).toBe(1)
    store = await openStore(dir)
    const fresh = createSecretBox(loadOrCreateKey({ dataDir: dir }))
    const rows = new FavouriteRepo(store.db, fresh, Date.now).list({ ownerId: null, connectionId: conn.id })
    expect(rows.map((r) => r.text)).toEqual(['{"filter":{"a":1}}'])
    store.close()
  })
})

describe('final review 2c: saving favourites and pipelines', () => {
  const PIPELINES = '/databases/shop/collections/orders/pipelines'

  it('keeps the tags a change does not name (Minor 6)', async () => {
    const h = await local()
    const fav = (await h.call('POST', BASE, { name: 'f', tags: ['keep'], query })).json() as FavouriteView
    const changed = await h.call('PUT', `${BASE}/${fav.id}`, { name: 'g', query })
    expect(changed.json()).toMatchObject({ name: 'g', tags: ['keep'] })
    const pipeline = (
      await h.call('POST', PIPELINES, { name: 'p', tags: ['keep'], stages: [] })
    ).json() as SavedPipelineView
    const again = await h.call('PUT', `${PIPELINES}/${pipeline.id}`, { name: 'q', stages: [] })
    expect(again.json()).toMatchObject({ name: 'q', tags: ['keep'] })
    const cleared = await h.call('PUT', `${PIPELINES}/${pipeline.id}`, { name: 'q', stages: [], tags: [] })
    expect(cleared.json()).toMatchObject({ tags: [] })
  })

  it('audits sharing and tags of favourites and pipelines (Minor 12)', async () => {
    const h = await local()
    await h.call('POST', BASE, { name: 'f', tags: ['x'], query, shared: true })
    await h.call('POST', PIPELINES, { name: 'p', tags: ['y'], stages: [], shared: true })
    const details = (action: string) =>
      h.t.app.ctx.audit.list({ limit: 10 }).find((r) => r.action === action)!.details
    expect(details('favourites.save')).toMatchObject({ name: 'f', tags: ['x'], shared: true })
    expect(details('pipelines.save')).toMatchObject({ name: 'p', tags: ['y'], shared: true })
  })

  it('says why a 201st favourite or pipeline is refused (Minor 12)', async () => {
    const h = await local()
    for (const repo of [h.t.app.ctx.favourites, h.t.app.ctx.savedPipelines])
      for (let i = 0; i < 200; i++)
        repo.create({
          ownerId: null,
          connectionId: h.connectionId,
          db: 'shop',
          coll: 'orders',
          name: `n${i}`,
          text: repo === h.t.app.ctx.favourites ? '{"filter":{}}' : '[]',
          shared: false,
        })
    const favourite = await h.call('POST', BASE, { name: 'one more', query })
    expect([favourite.statusCode, favourite.json().details]).toEqual([409, { reason: 'limit', max: 200 }])
    const pipeline = await h.call('POST', PIPELINES, { name: 'one more', stages: [] })
    expect([pipeline.statusCode, pipeline.json().details]).toEqual([409, { reason: 'limit', max: 200 }])
  })
})
