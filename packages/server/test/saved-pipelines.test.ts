// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SavedPipelineView } from '@mongo-manager/shared'
import { dataHarness, teamHarness } from './support/data'
import type { TestMongo } from './support/mongo'
import { openStore } from '../src/store/db'
import { createSecretBox, loadOrCreateKey } from '../src/crypto/secret-box'
import { ConnectionRepo } from '../src/connections/repo'
import { packPipeline, SavedPipelineRepo } from '../src/aggregation/saved'
import { rotateSecretKey } from '../src/crypto/rotate'

/** Saved pipelines never talk to MongoDB: the connection only has to exist. */
const NO_MONGO = { port: 1 } as TestMongo
const closers: Array<{ t: { close(): Promise<void> } }> = []
const dirs: string[] = []
afterEach(async () => {
  for (const h of closers.splice(0)) await h.t.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const BASE = '/databases/shop/collections/orders/pipelines'
const stages = [{ $match: { total: { $numberLong: '9007199254740993' } } }, { $limit: { $numberInt: '5' } }]

async function team() {
  const h = await teamHarness(NO_MONGO)
  closers.push(h)
  return h
}

describe('saved pipelines (phase 2a spec §3.2)', () => {
  it('saves, lists, updates and deletes, keeping the EJSON types exact', async () => {
    const h = await dataHarness(NO_MONGO)
    closers.push(h)
    const created = await h.call('POST', BASE, { name: 'Big orders', stages, shared: false })
    expect(created.statusCode, created.body).toBe(201)
    const view = created.json() as SavedPipelineView
    expect(view).toMatchObject({ name: 'Big orders', stages, shared: false, mine: true })
    const list = (await h.call('GET', BASE)).json() as { pipelines: SavedPipelineView[] }
    expect(list.pipelines.map((p) => p.stages)).toEqual([stages])
    const updated = await h.call('PUT', `${BASE}/${view.id}`, { name: 'Renamed', stages: [], shared: false })
    expect(updated.json()).toMatchObject({ name: 'Renamed', stages: [] })
    expect((await h.call('DELETE', `${BASE}/${view.id}`)).statusCode).toBe(204)
    expect((await h.call('GET', BASE)).json()).toEqual({ pipelines: [] })
  })

  it('keeps the pipeline sealed at rest', async () => {
    const h = await dataHarness(NO_MONGO)
    closers.push(h)
    await h.call('POST', BASE, { name: 'secretive', stages: [{ $match: { ssn: '123-45-6789' } }] })
    const rows = h.t.app.ctx.store.db.prepare('SELECT * FROM saved_pipelines').all()
    expect(JSON.stringify(rows)).not.toContain('123-45-6789')
    expect(JSON.stringify(rows)).toContain('secretive')
  })

  it('does not open a sealed pipeline moved to another row, and still lists the rest', async () => {
    const h = await dataHarness(NO_MONGO)
    closers.push(h)
    const a = (await h.call('POST', BASE, { name: 'a', stages })).json() as SavedPipelineView
    const b = (await h.call('POST', BASE, { name: 'b', stages: [] })).json() as SavedPipelineView
    const db = h.t.app.ctx.store.db
    const sealed = (
      db.prepare('SELECT pipeline FROM saved_pipelines WHERE id = ?').get(a.id) as { pipeline: string }
    ).pipeline
    db.prepare('UPDATE saved_pipelines SET pipeline = ? WHERE id = ?').run(sealed, b.id)
    const res = await h.call('GET', BASE)
    expect(res.statusCode).toBe(200)
    expect((res.json() as { pipelines: SavedPipelineView[] }).pipelines.map((p) => p.name)).toEqual(['a'])
  })

  it('refuses a name too long, a pipeline too large, and a 201st pipeline in one collection', async () => {
    const h = await dataHarness(NO_MONGO)
    closers.push(h)
    expect((await h.call('POST', BASE, { name: 'x'.repeat(101), stages: [] })).statusCode).toBe(400)
    const big = [{ $match: { a: 'x'.repeat(300 * 1024) } }]
    expect((await h.call('POST', BASE, { name: 'big', stages: big })).statusCode).toBe(400)
    const repo = h.t.app.ctx.savedPipelines
    for (let i = 0; i < 200; i++)
      repo.create({
        ownerId: null,
        connectionId: h.connectionId,
        db: 'shop',
        coll: 'orders',
        name: `p${i}`,
        text: '[]',
        shared: false,
      })
    const over = await h.call('POST', BASE, { name: 'one more', stages: [] })
    expect([over.statusCode, over.json().code]).toEqual([409, 'CONFLICT'])
  })

  it('shows private pipelines to their owner only, and shared ones to everyone with access', async () => {
    const h = await team()
    const [ada, bob] = [h.user('editor'), h.user('viewer')]
    const mine = (await ada.call('POST', BASE, { name: 'private', stages })).json() as SavedPipelineView
    const shared = (
      await ada.call('POST', BASE, { name: 'team', stages, shared: true })
    ).json() as SavedPipelineView
    const seen = (await bob.call('GET', BASE)).json() as { pipelines: SavedPipelineView[] }
    expect(seen.pipelines.map((p) => [p.name, p.mine, p.owner])).toEqual([
      ['team', false, expect.stringMatching(/^u-editor-/)],
    ])
    // Bob can neither change nor delete Ada's pipelines, shared or not.
    expect((await bob.call('PUT', `${BASE}/${shared.id}`, { name: 'x', stages: [] })).statusCode).toBe(403)
    expect((await bob.call('DELETE', `${BASE}/${shared.id}`)).statusCode).toBe(403)
    expect((await bob.call('DELETE', `${BASE}/${mine.id}`)).statusCode).toBe(404)
    // A connection admin may delete a shared pipeline, not read a private one.
    const admin = h.user('admin')
    expect(((await admin.call('GET', BASE)).json() as { pipelines: unknown[] }).pipelines).toHaveLength(1)
    expect((await admin.call('DELETE', `${BASE}/${shared.id}`)).statusCode).toBe(204)
  })

  it('refuses a user without a grant on the connection', async () => {
    const h = await team()
    const outsider = h.user('editor')
    h.t.app.ctx.grants.set(h.connectionId, outsider.id, 'none')
    expect((await outsider.call('GET', BASE)).statusCode).toBe(404)
  })

  it('audits saves and deletes by name, never with the pipeline', async () => {
    const h = await dataHarness(NO_MONGO)
    closers.push(h)
    const view = (
      await h.call('POST', BASE, { name: 'audited', stages: [{ $match: { card: 'qz-card-4111' } }] })
    ).json()
    await h.call('DELETE', `${BASE}/${view.id}`)
    const rows = h.t.app.ctx.audit.list({ limit: 10 }).filter((r) => r.action.startsWith('pipelines.'))
    expect(rows.map((r) => r.action).sort()).toEqual(['pipelines.delete', 'pipelines.save'])
    expect(rows.find((r) => r.action === 'pipelines.save')!.details).toMatchObject({ name: 'audited' })
    expect(JSON.stringify(rows)).not.toContain('qz-card-4111')
  })

  it('goes with its connection', async () => {
    const h = await dataHarness(NO_MONGO)
    closers.push(h)
    await h.call('POST', BASE, { name: 'gone', stages })
    h.t.app.ctx.connections.delete(h.connectionId)
    expect(h.t.app.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM saved_pipelines').get()).toEqual({ n: 0 })
  })
})

describe('saved pipelines and rotate-key', () => {
  it('are re-sealed with the new key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-pipelines-'))
    dirs.push(dir)
    const box = createSecretBox(loadOrCreateKey({ dataDir: dir }))
    let store = await openStore(dir)
    const conn = new ConnectionRepo(store.db, box, Date.now).create(
      { name: 'P', settings: { hosts: [{ host: 'h' }] } } as never,
      null,
    )
    new SavedPipelineRepo(store.db, box, Date.now).create({
      ownerId: null,
      connectionId: conn.id,
      db: 'shop',
      coll: 'orders',
      name: 'kept',
      text: '[{"$limit":{"$numberInt":"1"}}]',
      shared: false,
    })
    store.close()
    const result = await rotateSecretKey({ dataDir: dir })
    expect(result.savedPipelines).toBe(1)
    store = await openStore(dir)
    const fresh = createSecretBox(loadOrCreateKey({ dataDir: dir }))
    const rows = new SavedPipelineRepo(store.db, fresh, Date.now).list({
      ownerId: null,
      connectionId: conn.id,
      db: 'shop',
      coll: 'orders',
    })
    expect(rows.map((r) => r.text)).toEqual(['[{"$limit":{"$numberInt":"1"}}]'])
    store.close()
  })
})

describe('saved pipelines: final review 2a', () => {
  it('shows pipelines saved in local mode only to connection admins once team mode starts (I8)', async () => {
    const h = await team()
    h.t.app.ctx.savedPipelines.create({
      ownerId: null,
      connectionId: h.connectionId,
      db: 'shop',
      coll: 'orders',
      name: 'from local mode',
      text: '[]',
      shared: false,
    })
    const names = async (role: 'admin' | 'editor' | 'viewer') =>
      ((await h.user(role).call('GET', BASE)).json() as { pipelines: SavedPipelineView[] }).pipelines.map(
        (p) => p.name,
      )
    expect(await names('viewer')).toEqual([])
    expect(await names('editor')).toEqual([])
    expect(await names('admin')).toEqual(['from local mode'])
  })

  it('keeps shared pipelines when their author is deleted, and drops the private ones (Minor 10)', async () => {
    const h = await team()
    const ada = h.user('editor')
    await ada.call('POST', BASE, { name: 'private', stages })
    await ada.call('POST', BASE, { name: 'team', stages, shared: true })
    h.t.app.ctx.users.delete(ada.id)
    const rows = h.t.app.ctx.store.db.prepare('SELECT name, owner_id FROM saved_pipelines').all()
    expect(rows).toEqual([{ name: 'team', owner_id: null }])
    const seen = (await h.user('viewer').call('GET', BASE)).json() as { pipelines: SavedPipelineView[] }
    expect(seen.pipelines.map((p) => p.name)).toEqual(['team'])
  })
})

describe('the assistant’s steps saved with a pipeline (UI redesign R1 review)', () => {
  const assistant = {
    steps: [
      {
        prompt: 'shipped orders with customers',
        reply: 'Joined the customers.',
        stages: [stages[0]],
        changes: [{ kind: 'added', operator: '$match', n: 1 }],
      },
      {
        prompt: 'only name and sku of the products',
        reply: 'Kept two product fields.',
        stages,
        changes: [{ kind: 'added', operator: '$limit', n: 2 }],
      },
    ],
  }

  it('keeps the steps with the pipeline, sealed, and gives them back to its owner', async () => {
    const h = await dataHarness(NO_MONGO)
    closers.push(h)
    const created = (
      await h.call('POST', BASE, { name: 'With steps', stages, assistant })
    ).json() as SavedPipelineView
    expect(created.stages).toEqual(stages)
    expect(created.assistant).toEqual(assistant)
    const listed = ((await h.call('GET', BASE)).json() as { pipelines: SavedPipelineView[] }).pipelines[0]!
    expect(listed.assistant?.steps.map((s) => s.prompt)).toEqual([
      'shipped orders with customers',
      'only name and sku of the products',
    ])
    const rows = h.t.app.ctx.store.db.prepare('SELECT * FROM saved_pipelines').all()
    expect(JSON.stringify(rows)).not.toContain('shipped orders with customers')
    // A pipeline saved without steps has none (and an older pipeline without them still opens).
    const plain = (await h.call('POST', BASE, { name: 'Plain', stages })).json() as SavedPipelineView
    expect(plain.assistant).toBeUndefined()
    expect(plain.stages).toEqual(stages)
  })

  it('shows the steps to no one but the owner (they are the owner’s own words)', async () => {
    const h = await team()
    const [ada, bob] = [h.user('editor'), h.user('viewer')]
    await ada.call('POST', BASE, { name: 'team', stages, shared: true, assistant })
    const seen = ((await bob.call('GET', BASE)).json() as { pipelines: SavedPipelineView[] }).pipelines[0]!
    expect(seen.stages).toEqual(stages)
    expect(seen.assistant).toBeUndefined()
    expect(JSON.stringify(seen)).not.toContain('shipped orders')
  })

  it('bounds the steps', async () => {
    const h = await dataHarness(NO_MONGO)
    closers.push(h)
    const many = { steps: Array.from({ length: 9 }, () => assistant.steps[0]) }
    expect((await h.call('POST', BASE, { name: 'x', stages, assistant: many })).statusCode).toBe(400)
    const long = { steps: [{ ...assistant.steps[0], prompt: 'x'.repeat(2001) }] }
    expect((await h.call('POST', BASE, { name: 'x', stages, assistant: long })).statusCode).toBe(400)
  })
})

describe('the steps survive a rename or a share (final review I3)', () => {
  it('keeps the saved steps when a change leaves them out, and clears them when asked', async () => {
    const h = await dataHarness(NO_MONGO)
    closers.push(h)
    const assistant = { steps: [{ prompt: 'p', reply: 'r', stages, changes: [] }] }
    const created = (await h.call('POST', BASE, { name: 'a', stages, assistant })).json() as SavedPipelineView
    const renamed = (
      await h.call('PUT', `${BASE}/${created.id}`, { name: 'b', stages, shared: false })
    ).json() as SavedPipelineView
    expect(renamed.assistant).toEqual(assistant)
    const cleared = (
      await h.call('PUT', `${BASE}/${created.id}`, {
        name: 'b',
        stages,
        shared: false,
        assistant: { steps: [] },
      })
    ).json() as SavedPipelineView
    expect(cleared.assistant).toBeUndefined()
  })

  it('drops the oldest steps rather than refusing a pipeline that fits alone (final review Minor 5)', async () => {
    const h = await dataHarness(NO_MONGO)
    closers.push(h)
    const big = [{ $match: { a: 'x'.repeat(100 * 1024) } }]
    const assistant = {
      steps: [0, 1, 2].map((i) => ({ prompt: `p${i}`, reply: '', stages: big, changes: [] })),
    }
    const res = await h.call('POST', BASE, { name: 'big', stages: big, assistant })
    expect(res.statusCode).toBe(201)
    const view = res.json() as SavedPipelineView
    expect(view.stages).toEqual(big)
    expect(view.assistant?.steps.map((s) => s.prompt) ?? []).not.toContain('p0')
  })

  it('reads a stored object without stages as it is (it is not a packed pipeline)', async () => {
    const { SavedPipelineRepo } = await import('../src/aggregation/saved')
    expect(SavedPipelineRepo).toBeTruthy()
    const h = await dataHarness(NO_MONGO)
    closers.push(h)
    const repo = h.t.app.ctx.savedPipelines
    const row = repo.create({
      ownerId: null,
      connectionId: h.connectionId,
      db: 'shop',
      coll: 'orders',
      name: 'odd',
      text: '{"x":1}',
      shared: false,
    })
    expect(row.text).toBe('{"x":1}')
    expect((row as { assistant?: unknown }).assistant).toBeUndefined()
  })
})

describe('the assistant’s steps elsewhere (final review Minor 11)', () => {
  const assistant = {
    steps: [{ prompt: 'my own words about customers', reply: 'r', stages, changes: [] }],
  }

  it('are re-sealed with the pipeline when the server key rotates', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-pipelines-'))
    dirs.push(dir)
    const box = createSecretBox(loadOrCreateKey({ dataDir: dir }))
    let store = await openStore(dir)
    const conn = new ConnectionRepo(store.db, box, Date.now).create(
      { name: 'P', settings: { hosts: [{ host: 'h' }] } } as never,
      null,
    )
    const stagesText = '[{"$limit":{"$numberInt":"1"}}]'
    new SavedPipelineRepo(store.db, box, Date.now).create({
      ownerId: null,
      connectionId: conn.id,
      db: 'shop',
      coll: 'orders',
      name: 'packed',
      text: packPipeline(stagesText, assistant),
      shared: false,
    })
    store.close()
    await rotateSecretKey({ dataDir: dir })
    store = await openStore(dir)
    const fresh = createSecretBox(loadOrCreateKey({ dataDir: dir }))
    const [row] = new SavedPipelineRepo(store.db, fresh, Date.now).list({
      ownerId: null,
      connectionId: conn.id,
      db: 'shop',
      coll: 'orders',
    })
    expect(row!.text).toBe(stagesText)
    expect(row!.assistant).toEqual(assistant)
    store.close()
  })

  it('never reach the library search, which shows the stages only', async () => {
    const h = await dataHarness(NO_MONGO)
    closers.push(h)
    await h.call('POST', BASE, { name: 'With steps', stages, assistant })
    const res = await h.call('GET', '/library?type=pipeline')
    expect(res.statusCode).toBe(200)
    const items = (res.json() as { items: Array<{ name?: string; body?: unknown }> }).items
    expect(items).toHaveLength(1)
    expect(JSON.stringify(items)).not.toContain('my own words')
    expect(JSON.stringify(items)).not.toContain('assistant')
  })
})
