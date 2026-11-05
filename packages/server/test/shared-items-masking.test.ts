// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { startMongo, type TestMongo } from './support/mongo'
import { restrictedApp } from './support/restricted'
import { HIDDEN_JOB_ERROR, toView } from '../src/jobs/visibility'
import type { TestApp } from './helpers'
import { slow } from './support/slowness'
import { Double, Int32 } from 'mongodb'
import { compileRules } from '../src/masking/match'
import { maskFindDef } from '../src/masking/definitions'

/** Phase 3c §4.6-4.7: other users' shared items, and job errors, for a restricted viewer. */
const S = 'S3NT1N3L'
const RULES = [{ db: 'crm', coll: 'users', field: 'email' }]
const USERS = '/databases/crm/collections/users'
let mongo: TestMongo
beforeAll(async () => {
  mongo = await startMongo()
}, slow(120_000))
afterAll(async () => {
  await mongo?.stop()
})
const apps: TestApp[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})
async function setup() {
  const r = await restrictedApp(mongo, RULES)
  apps.push(r.t)
  return r
}

describe('shared items and job errors (phase 3c §4.6-4.7)', () => {
  it('shows another user’s shared literals at personal paths as ***, and searches the masked text', async () => {
    const { as } = await setup()
    const admin = as('admin')
    const fav = await admin('POST', `${USERS}/favourites`, {
      name: 'vip',
      tags: [],
      shared: true,
      query: { filter: { email: `${S}@x`, name: 'Ali' } },
    })
    expect(fav.statusCode).toBe(201)
    const pipe = await admin('POST', `${USERS}/pipelines`, {
      name: 'p',
      tags: [],
      shared: true,
      stages: [{ $match: { email: `${S}@x` } }],
    })
    expect(pipe.statusCode).toBe(201)
    const user = as('editor', true)
    const favs = await user('GET', `${USERS}/favourites`)
    expect(favs.statusCode).toBe(200)
    expect(favs.body).not.toContain(S)
    expect(favs.body).toContain('Ali')
    const pipes = await user('GET', `${USERS}/pipelines`)
    expect(pipes.statusCode).toBe(200)
    expect(pipes.body).not.toContain(S)
    const library = await user('GET', '/library')
    expect(library.statusCode).toBe(200)
    expect(library.body).not.toContain(S)
    expect(library.json().items.length).toBeGreaterThan(0)
    expect((await user('GET', `/library?q=${S}`)).json().items).toHaveLength(0)
    expect((await admin('GET', `/library?q=${S}`)).json().items.length).toBeGreaterThan(0)
  })

  // Query parameters (spec 2026-10-28): a shared template's defaults are literals like any other in
  // it — gone for a restricted viewer, whose template keeps its parameters, at personal paths too.
  it('drops another user’s parameter defaults for a restricted viewer, keeping the parameters', async () => {
    const { as } = await setup()
    const admin = as('admin')
    const fav = await admin('POST', `${USERS}/favourites`, {
      name: 'by email',
      tags: [],
      shared: true,
      query: {
        filter: { email: { $$param: 'email' }, name: { $in: [{ $$param: 'name' }, 'Ali'] } },
        params: { email: `${S}@x`, name: 'Bea' },
      },
    })
    expect(fav.statusCode, fav.body).toBe(201)
    expect(fav.json().query.params).toEqual({ email: `${S}@x`, name: 'Bea' })
    const user = as('editor', true)
    const favs = await user('GET', `${USERS}/favourites`)
    expect(favs.statusCode).toBe(200)
    expect(favs.body).not.toContain(S)
    expect(favs.body).not.toContain('Bea')
    const [query] = (favs.json() as { favourites: Array<{ query: Record<string, unknown> }> }).favourites.map(
      (f) => f.query,
    )
    expect(query).toEqual({
      filter: { email: { $$param: 'email' }, name: { $in: [{ $$param: 'name' }, 'Ali'] } },
    })
    const library = await user('GET', '/library?type=favourite')
    expect(library.body).not.toContain(S)
    expect(library.body).not.toContain('Bea')
    const [item] = library.json().items as Array<{ preview: string; body: unknown }>
    expect(item!.preview).toBe('{ filter: { email: {{email}}, name: { $in: [{{name}}, "Ali"] } } }')
    expect(item!.body).toEqual(query)
    // The owner, and anyone who may see the data, keeps them.
    const own = await admin('GET', '/library?type=favourite')
    // A preview shows the query, never its defaults.
    expect((own.json().items as Array<{ preview: string }>)[0]!.preview).toBe(item!.preview)
    expect((own.json().items as Array<{ body: { params?: unknown } }>)[0]!.body.params).toEqual({
      email: `${S}@x`,
      name: 'Bea',
    })
  })

  it('refuses parameter defaults not shaped as parameters are', async () => {
    const { as } = await setup()
    const admin = as('admin')
    for (const params of [
      { '1x': 'a' },
      { a: 5 },
      { a: 'x'.repeat(64 * 1024 + 1) },
      Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`p${i}`, 'v'])),
    ]) {
      const res = await admin('POST', `${USERS}/favourites`, {
        name: 'bad',
        tags: [],
        query: { filter: {}, params },
      })
      expect(res.statusCode, JSON.stringify(params).slice(0, 40)).toBe(400)
    }
  })

  // Final review of the query parameters (Minor 9): a local-mode favourite or pipeline a connection
  // admin sees masked keeps its stored values through a rename; a change of its query is refused.
  it('keeps what a restricted admin was shown masked as stored, and refuses a changed query', async () => {
    const { as, ctx, connectionId } = await setup()
    const stored = { filter: { email: `${S}@x`, name: 'Ali' }, params: { e: `${S}@y` } }
    const fav = ctx.favourites.create({
      ownerId: null,
      connectionId,
      db: 'crm',
      coll: 'users',
      name: 'old',
      text: JSON.stringify(stored),
      shared: false,
    })
    const pipe = ctx.savedPipelines.create({
      ownerId: null,
      connectionId,
      db: 'crm',
      coll: 'users',
      name: 'old',
      text: JSON.stringify([{ $match: { email: `${S}@x` } }]),
      shared: false,
    })
    // An admin is restricted only by their own "hide from me".
    const admin = as('admin')
    ctx.personalFields.setHiddenFromSelf(connectionId, admin.id, true)
    const shownFav = (await admin('GET', `${USERS}/favourites`)).json().favourites[0]
    expect(JSON.stringify(shownFav)).not.toContain(S)
    const renamed = await admin('PUT', `${USERS}/favourites/${fav.id}`, {
      name: 'new',
      shared: false,
      query: shownFav.query,
    })
    expect(renamed.statusCode, renamed.body).toBe(200)
    expect(ctx.favourites.get(fav.id)!.name).toBe('new')
    expect(JSON.parse(ctx.favourites.get(fav.id)!.text)).toEqual(stored)
    const changed = await admin('PUT', `${USERS}/favourites/${fav.id}`, {
      name: 'new',
      shared: false,
      query: { ...shownFav.query, filter: { ...shownFav.query.filter, name: 'Bea' } },
    })
    expect([changed.statusCode, changed.json().details?.reason]).toEqual([403, 'masked_definition'])
    expect(JSON.parse(ctx.favourites.get(fav.id)!.text)).toEqual(stored)

    const shownPipe = (await admin('GET', `${USERS}/pipelines`)).json().pipelines[0]
    expect(JSON.stringify(shownPipe)).not.toContain(S)
    const kept = await admin('PUT', `${USERS}/pipelines/${pipe.id}`, {
      name: 'p2',
      shared: false,
      stages: shownPipe.stages,
    })
    expect(kept.statusCode, kept.body).toBe(200)
    expect(JSON.stringify(ctx.savedPipelines.get(pipe.id)!)).toContain(S)
    const refused = await admin('PUT', `${USERS}/pipelines/${pipe.id}`, {
      name: 'p2',
      shared: false,
      stages: [{ $match: { name: 'x' } }],
    })
    expect(refused.statusCode).toBe(403)
    // Someone who sees everything replaces it as before.
    const open = as('admin')
    const replaced = await open('PUT', `${USERS}/favourites/${fav.id}`, {
      name: 'new',
      shared: false,
      query: { filter: { name: 'Bea' } },
    })
    expect(replaced.statusCode).toBe(200)
    expect(JSON.parse(ctx.favourites.get(fav.id)!.text)).toEqual({ filter: { name: 'Bea' } })
  })

  it('keeps the typed values of a template a restricted viewer is shown', () => {
    const masker = compileRules([{ db: 'crm', coll: 'users', field: 'email' }])
    const query = {
      filter: { email: { $$param: 'e' }, qty: { $gt: new Double(1.5) }, n: new Int32(3) },
      sort: { qty: new Int32(-1) },
    }
    const shown = maskFindDef(query, 'crm', 'users', masker) as typeof query
    expect(shown.filter.email).toEqual({ $$param: 'e' })
    expect(shown.filter.qty.$gt).toBeInstanceOf(Double)
    expect(shown.filter.n).toBeInstanceOf(Int32)
    expect(shown.sort.qty).toBeInstanceOf(Int32)
  })

  it('lets a restricted admin change a local-mode favourite nothing of which is hidden', async () => {
    const { as, ctx, connectionId } = await setup()
    const fav = ctx.favourites.create({
      ownerId: null,
      connectionId,
      db: 'crm',
      coll: 'users',
      name: 'open',
      text: JSON.stringify({ filter: { name: 'Ali' } }),
      shared: false,
    })
    const admin = as('admin')
    ctx.personalFields.setHiddenFromSelf(connectionId, admin.id, true)
    const res = await admin('PUT', `${USERS}/favourites/${fav.id}`, {
      name: 'open',
      shared: false,
      query: { filter: { name: 'Bea' } },
    })
    expect(res.statusCode, res.body).toBe(200)
    expect(JSON.parse(ctx.favourites.get(fav.id)!.text)).toEqual({ filter: { name: 'Bea' } })
  })

  it('hides a job’s error from a restricted viewer', async () => {
    const { ctx, connectionId } = await setup()
    const user = ctx.users.create({ username: 'jv', passwordHash: 'x', role: 'editor' })
    ctx.grants.set(connectionId, user.id, 'editor')
    ctx.grants.setMasked(connectionId, user.id, true)
    const job = {
      id: 'j',
      kind: 'index.create' as const,
      userId: null,
      connectionId,
      targetConnectionId: null,
      stagingConnectionId: null,
      stagingDb: null,
      db: 'crm',
      coll: 'users',
      target: 'i',
      state: 'failed' as const,
      progress: null,
      estimate: null,
      error: `dup ${S}`,
      staging: null,
      startedAt: 0,
      finishedAt: 1,
    }
    const principal = { kind: 'user' as const, userId: user.id, username: 'jv', role: 'editor' as const }
    expect(toView(ctx, principal as never, job).error).toBe(HIDDEN_JOB_ERROR)
    const other = ctx.users.create({ username: 'jw', passwordHash: 'x', role: 'editor' })
    ctx.grants.set(connectionId, other.id, 'editor')
    const unmasked = { kind: 'user' as const, userId: other.id, username: 'jw', role: 'editor' as const }
    expect(toView(ctx, unmasked as never, job).error).toBe(`dup ${S}`)
  })
})
