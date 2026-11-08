// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { MongoClient } from 'mongodb'
import type { AiAgentStep, AiChatLine } from '@mongo-manager/shared'
import { startMongo, type TestMongo } from './support/mongo'
import { dataHarness } from './support/data'
import { startFakeAi, type FakeCall } from './support/fake-ai'
import { agentReply, agentTurn, conversationOf, namedConnection } from './support/agent'
import { waitJob } from './support/jobs'

/**
 * The AI database manager (design 2026-10-25, B2): a backup restored from the chat — through the
 * restore plan, on a destructive card naming the target, the target's name typed, an encrypted
 * backup's password given on the card; never into one of MongoDB's own namespaces.
 */
let mongo: TestMongo
let client: MongoClient
beforeAll(async () => {
  mongo = await startMongo()
  client = await new MongoClient(`mongodb://127.0.0.1:${mongo.port}`).connect()
})
afterAll(async () => {
  await client?.close()
  await mongo?.stop()
})
const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c()
})

const PASSWORD = 'correct-horse-battery-1'
const steps = (out: AiChatLine[]) =>
  out.flatMap((l) => (l.type === 'step' && l.step.state !== 'running' ? [l.step] : []))

async function restoring() {
  const fake = await startFakeAi()
  closers.push(fake.close)
  const h = await dataHarness(mongo)
  closers.push(h.t.close)
  const inject = (method: 'GET' | 'POST' | 'PUT', path: string, payload?: object) =>
    h.t.app.inject({ method, url: `/api/${path}`, headers: h.headers, ...(payload ? { payload } : {}) })
  expect(
    (
      await inject('POST', 'ai/providers', {
        name: 'Fake',
        kind: 'openai',
        baseUrl: `${fake.url}/v1`,
        model: 'm',
      })
    ).statusCode,
  ).toBeLessThan(300)
  await inject('PUT', 'me/ai-agent', { on: true })
  const db = `rs${randomUUID().slice(0, 8)}`
  await client
    .db(db)
    .collection('orders')
    .insertMany([{ n: 1 }, { n: 2 }])
  /** A backup of the database, made through the app's routes; its name as listed. */
  const backUp = async (
    format: 'gzip' | 'mmbak',
    scope: object = { kind: 'database', db },
    of = h.connectionId,
  ) => {
    const body = { scope, format }
    const plan = (await inject('POST', `connections/${of}/backup/plan`, body)).json()
    const res = await inject('POST', `connections/${of}/backup`, {
      ...body,
      planHash: plan.planHash,
      ...(format === 'mmbak' ? { password: PASSWORD } : {}),
    })
    expect(res.statusCode, res.body).toBe(202)
    const job = await waitJob(h.t, res.json().job.id, 60_000)
    expect(job.state, job.error ?? '').toBe('done')
    const id = (await inject('GET', `transfer/jobs/${job.id}/report`)).json().backupId as string
    const listed = (await inject('GET', 'backups')).json() as Array<{ id: string; name: string }>
    return listed.find((b) => b.id === id)!.name
  }
  const once = (calls: FakeCall[], text = 'ok') =>
    fake.reply(agentReply((c) => (c.results.length === 0 ? { calls } : { text })))
  const turn = async (message: string) =>
    (await inject('POST', 'ai/agent', { message })).payload
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as AiChatLine)
  const card = async (calls: FakeCall[]) => {
    once(calls)
    const stream = await agentTurn(h.t.app, h.headers, { message: 'restore it' })
    const awaiting = (await stream.waitFor((l) => l.type === 'step' && l.step.state === 'awaiting')) as {
      step: AiAgentStep
    }
    const run = (stream.lines.find((l) => l.type === 'chat') as { run: string }).run
    const decide = async (decision: 'confirm' | 'decline', extra: object = {}) => {
      const res = await inject('POST', `ai/agent/runs/${run}/decide`, {
        call: awaiting.step.id,
        decision,
        ...extra,
      })
      await stream.ended
      return { res, ended: steps(stream.lines).at(-1)! }
    }
    /** An answer the route refuses: the card still waits, so the turn goes on. */
    const attempt = (extra: object) =>
      inject('POST', `ai/agent/runs/${run}/decide`, { call: awaiting.step.id, decision: 'confirm', ...extra })
    return { step: awaiting.step, decide, attempt }
  }
  return { h, fake, db, inject, backUp, once, turn, card, client }
}

describe('a backup restored by the agent (B2)', () => {
  it('restores into a new database on a destructive card, the target typed, through a job', async () => {
    const { db, backUp, card, h } = await restoring()
    const name = await backUp('gzip')
    const target = `${db}_r`
    const asked = await card([
      { name: 'restore_backup', args: { backup: name, connection: 'Test', database: target } },
    ])
    expect(asked.step.place).toMatchObject({ connectionId: h.connectionId, db: target })
    expect(asked.step.proposal).toMatchObject({
      typed: target,
      destructive: true,
      payload: { restore: name, into: target, mode: 'insert' },
      preview: { namespaces: 1 },
    })
    expect(asked.step.proposal!.opening).toBeUndefined()
    // C4: nothing there yet, nothing to back up first.
    expect(asked.step.proposal!.backup).toBeUndefined()
    const { ended } = await asked.decide('confirm', { confirm: target })
    expect(ended).toMatchObject({ state: 'done', summary: { started: true } })
    const job = await waitJob(h.t, String(ended.summary!.job), 60_000)
    expect(job.state, job.error ?? '').toBe('done')
    expect(await client.db(target).collection('orders').countDocuments()).toBe(2)
  }, 150_000)

  it('says what a replace over documents loses, and changes nothing when declined', async () => {
    const { db, backUp, card } = await restoring()
    const name = await backUp('gzip')
    await client.db(db).collection('orders').insertOne({ n: 3 })
    const asked = await card([
      { name: 'restore_backup', args: { backup: name, connection: 'Test', mode: 'replace' } },
    ])
    expect(asked.step.proposal).toMatchObject({ typed: db, preview: { lost: 3 } })
    // C4: what it writes over, backed up first on asking.
    expect(asked.step.proposal!.backup).toEqual({ scope: 'database', db })
    const { ended } = await asked.decide('decline')
    expect(ended.state).toBe('declined')
    expect(await client.db(db).collection('orders').countDocuments()).toBe(3)
  }, 150_000)

  // Review of B2 (C1): a replace over documents, confirmed, runs — the names it overwrites those the
  // card said, sent with its plan and its start.
  it('replaces a collection that holds documents once its card is confirmed', async () => {
    const { db, backUp, card, h } = await restoring()
    const name = await backUp('gzip')
    await client.db(db).collection('orders').insertOne({ n: 3 })
    const asked = await card([
      { name: 'restore_backup', args: { backup: name, connection: 'Test', mode: 'replace' } },
    ])
    const { ended } = await asked.decide('confirm', { confirm: db })
    expect(ended).toMatchObject({ state: 'done', summary: { started: true } })
    expect((await waitJob(h.t, String(ended.summary!.job), 60_000)).state).toBe('done')
    expect(await client.db(db).collection('orders').countDocuments()).toBe(2)
  }, 150_000)

  it('asks an encrypted backup’s password on the card, and opens it with that password only', async () => {
    const { db, backUp, card, h, fake, inject } = await restoring()
    const name = await backUp('mmbak')
    const target = `${db}_e`
    const args = { backup: name, connection: 'Test', database: target }
    const wrong = await card([{ name: 'restore_backup', args }])
    expect(wrong.step.proposal).toMatchObject({ password: true, opening: true })
    const refused = await wrong.decide('confirm', { confirm: target, password: 'not-the-password' })
    expect(refused.ended).toMatchObject({ state: 'error', reason: 'backup_password' })
    const right = await card([{ name: 'restore_backup', args }])
    const { ended } = await right.decide('confirm', { confirm: target, password: PASSWORD })
    expect(ended).toMatchObject({ state: 'done' })
    expect((await waitJob(h.t, String(ended.summary!.job), 60_000)).state).toBe('done')
    expect(await client.db(target).collection('orders').countDocuments()).toBe(2)
    // The password went to the routes only: never to the provider, the audit log or the history.
    expect(JSON.stringify(fake.requests)).not.toContain(PASSWORD)
    expect((await inject('GET', 'audit')).payload).not.toContain(PASSWORD)
    const page = (await inject('GET', 'ai/history')).json() as { items: Array<{ id: string }> }
    for (const i of page.items)
      expect((await inject('GET', `ai/history/${i.id}`)).payload).not.toContain(PASSWORD)
  }, 150_000)

  it('starts nothing when the target changed after its card', async () => {
    const { db, backUp, card } = await restoring()
    const name = await backUp('gzip')
    const target = `${db}_c`
    const asked = await card([
      { name: 'restore_backup', args: { backup: name, connection: 'Test', database: target } },
    ])
    // The card said the target is new; it is not, by the time of the click.
    await client.db(target).collection('orders').insertOne({ n: 9 })
    const { ended } = await asked.decide('confirm', { confirm: target })
    expect(ended).toMatchObject({ state: 'error', reason: 'plan_changed' })
    expect(await client.db(target).collection('orders').countDocuments()).toBe(1)
  }, 150_000)

  // A new backup's password is checked for its length on the click (the decision takes any length,
  // for a password that opens a backup made before).
  it('refuses a new backup’s short password, and takes an old backup’s password as it was made', async () => {
    const { db, card } = await restoring()
    const asked = await card([{ name: 'run_backup', args: { connection: 'Test', database: db } }])
    expect(asked.step.proposal).toMatchObject({ password: true })
    expect(asked.step.proposal!.opening).toBeUndefined()
    const res = await asked.attempt({ password: 'short' })
    expect(res.statusCode).toBe(400)
    expect(res.json().details).toMatchObject({ reason: 'password_short' })
    // Still waiting: answered, it ends.
    expect((await asked.decide('decline')).ended.state).toBe('declined')
  }, 150_000)

  it('never restores into MongoDB’s own databases, and says a backup it does not know with the names', async () => {
    const { backUp, once, turn, fake } = await restoring()
    const name = await backUp('gzip')
    once([{ name: 'restore_backup', args: { backup: name, connection: 'Test', database: 'admin' } }])
    expect(steps(await turn('restore into admin'))[0]).toMatchObject({
      state: 'refused',
      reason: 'system_namespace',
    })
    once([{ name: 'restore_backup', args: { backup: 'nightly', connection: 'Test' } }])
    expect(steps(await turn('restore nightly'))[0]).toMatchObject({
      state: 'refused',
      reason: 'backup_unknown',
    })
    expect(conversationOf(fake.requests.at(-1)!.body).results.at(-1)).toContain(name)
  }, 150_000)

  // Review of B2 (I3): more than one collection, upsert, a backup of one collection, and a backup
  // whose dump report is gone (kept for a day; the backup for weeks).
  it('restores every collection of a database by upsert, its report gone', async () => {
    const { db, backUp, card, h } = await restoring()
    await client
      .db(db)
      .collection('items')
      .insertMany([{ k: 1 }, { k: 2 }, { k: 3 }])
    const name = await backUp('gzip')
    h.t.app.ctx.store.db.prepare('DELETE FROM transfer_reports').run()
    const target = `${db}_u`
    const asked = await card([
      {
        name: 'restore_backup',
        args: { backup: name, connection: 'Test', database: target, mode: 'upsert' },
      },
    ])
    expect(asked.step.proposal!.preview).toMatchObject({ namespaces: 2 })
    const { ended } = await asked.decide('confirm', { confirm: target })
    expect((await waitJob(h.t, String(ended.summary!.job), 60_000)).state).toBe('done')
    expect(await client.db(target).collection('orders').countDocuments()).toBe(2)
    expect(await client.db(target).collection('items').countDocuments()).toBe(3)
  }, 150_000)

  it('restores a backup of one collection into another, and never into one of MongoDB’s own', async () => {
    const { db, backUp, card, once, turn, h } = await restoring()
    const name = await backUp('gzip', { kind: 'collection', db, coll: 'orders' })
    once([{ name: 'restore_backup', args: { backup: name, connection: 'Test', collection: 'system.copy' } }])
    expect(steps(await turn('restore'))[0]).toMatchObject({ state: 'refused', reason: 'system_namespace' })
    const asked = await card([
      { name: 'restore_backup', args: { backup: name, connection: 'Test', collection: 'copy' } },
    ])
    expect(asked.step.proposal).toMatchObject({ typed: `${db}.copy` })
    const { ended } = await asked.decide('confirm', { confirm: `${db}.copy` })
    expect((await waitJob(h.t, String(ended.summary!.job), 60_000)).state).toBe('done')
    expect(await client.db(db).collection('copy').countDocuments()).toBe(2)
  }, 150_000)

  it('says a collection is for a backup of one, and that the agent may not change a connection', async () => {
    const { h, backUp, once, turn } = await restoring()
    const name = await backUp('gzip')
    once([{ name: 'restore_backup', args: { backup: name, connection: 'Test', collection: 'copy' } }])
    expect(steps(await turn('restore'))[0]).toMatchObject({ state: 'refused', reason: 'invalid_arguments' })
    h.t.app.ctx.connections.setAiAgentWrites(h.connectionId, false)
    once([{ name: 'restore_backup', args: { backup: name, connection: 'Test', database: 'elsewhere' } }])
    expect(steps(await turn('restore'))[0]).toMatchObject({ state: 'refused', reason: 'agent_writes_off' })
  }, 150_000)

  // Re-review of B2 (I1): a target the card left out — a view — that is a collection holding documents
  // by the click is a change: nothing starts, nothing is overwritten unseen.
  it('starts nothing when a target the card left out holds documents by the click', async () => {
    const { db, backUp, card } = await restoring()
    // Two collections: one restored, one left out by the card (its target a view).
    await client.db(db).collection('items').insertOne({ k: 1 })
    const name = await backUp('gzip')
    const target = `${db}_v`
    await client.db(target).collection('base').insertOne({ n: 0 })
    await client.db(target).createCollection('orders', { viewOn: 'base', pipeline: [] })
    const asked = await card([
      {
        name: 'restore_backup',
        args: { backup: name, connection: 'Test', database: target, mode: 'replace' },
      },
    ])
    expect(asked.step.proposal!.preview).toMatchObject({ skipped: 1 })
    await client.db(target).collection('orders').drop()
    await client
      .db(target)
      .collection('orders')
      .insertMany([{ n: 7 }, { n: 8 }])
    const { ended } = await asked.decide('confirm', { confirm: target })
    expect(ended).toMatchObject({ state: 'error', reason: 'plan_changed' })
    // Its own documents still there (the backup's are n: 1 and 2).
    expect(
      await client
        .db(target)
        .collection('orders')
        .countDocuments({ n: { $in: [7, 8] } }),
    ).toBe(2)
  }, 150_000)

  // I1, an encrypted backup: an empty target filled by the click is a change too; one full from the
  // start is overwritten once confirmed, its count said on the card.
  it('replaces with an encrypted backup what the card said, and stops when a target filled meanwhile', async () => {
    const { db, backUp, card, h } = await restoring()
    const name = await backUp('mmbak')
    await client.db(db).collection('orders').insertOne({ n: 3 })
    const args = { backup: name, connection: 'Test', mode: 'replace' }
    const full = await card([{ name: 'restore_backup', args }])
    expect(full.step.proposal).toMatchObject({ opening: true, preview: { lost: 3, warnings: ['source'] } })
    const done = await full.decide('confirm', { confirm: db, password: PASSWORD })
    expect(done.ended).toMatchObject({ state: 'done' })
    expect((await waitJob(h.t, String(done.ended.summary!.job), 60_000)).state).toBe('done')
    expect(await client.db(db).collection('orders').countDocuments()).toBe(2)
    const target = `${db}_f`
    const empty = await card([{ name: 'restore_backup', args: { ...args, database: target } }])
    await client.db(target).collection('orders').insertOne({ n: 9 })
    const stopped = await empty.decide('confirm', { confirm: target, password: PASSWORD })
    expect(stopped.ended).toMatchObject({ state: 'error', reason: 'plan_changed' })
    expect(await client.db(target).collection('orders').countDocuments()).toBe(1)
  }, 150_000)

  // An old backup whose list is not known: said so.
  it('says what a backup holds is not known when it kept no list and its report is gone', async () => {
    const { h, backUp, once, turn } = await restoring()
    const name = await backUp('gzip')
    const db = h.t.app.ctx.store.db
    for (const row of db.prepare('SELECT id, meta FROM backups WHERE meta IS NOT NULL').all() as Array<{
      id: string
      meta: string
    }>) {
      const meta = JSON.parse(row.meta) as Record<string, unknown>
      delete meta.included
      db.prepare('UPDATE backups SET meta = ? WHERE id = ?').run(JSON.stringify(meta), row.id)
    }
    db.prepare('DELETE FROM transfer_reports').run()
    once([{ name: 'restore_backup', args: { backup: name, connection: 'Test', database: 'elsewhere' } }])
    expect(steps(await turn('restore'))[0]).toMatchObject({
      state: 'refused',
      reason: 'restore_namespaces_unknown',
    })
  }, 150_000)

  // Third review of B2 (M3): a capped target the card did not name stops the click, whatever it
  // warned of besides.
  it('stops when a target turned capped after its card', async () => {
    const { db, backUp, card } = await restoring()
    await client.db(db).collection('items').insertOne({ k: 1 })
    const name = await backUp('gzip')
    const target = `${db}_k`
    // The card already warns of one capped target (items): another turning capped is still a change.
    await client.db(target).createCollection('items', { capped: true, size: 8192 })
    await client.db(target).collection('orders').insertOne({ n: 5 })
    const asked = await card([
      { name: 'restore_backup', args: { backup: name, connection: 'Test', database: target } },
    ])
    expect(asked.step.proposal!.preview?.warnings ?? []).toContain('capped')
    // Fourth review of B2 (I2): named, so what the click guards is what the person saw.
    expect(asked.step.proposal!.preview?.capped).toEqual([`${target}.items`])
    await client.db(target).collection('orders').drop()
    await client.db(target).createCollection('orders', { capped: true, size: 4096 })
    await client.db(target).collection('orders').insertOne({ n: 5 })
    const { ended } = await asked.decide('confirm', { confirm: target })
    expect(ended).toMatchObject({ state: 'error', reason: 'plan_changed' })
  }, 150_000)

  // M2: an encrypted backup into a view and a capped target: what the card can see, it says; it restores.
  it('restores an encrypted backup around a view, saying a capped target', async () => {
    const { db, backUp, card, h } = await restoring()
    await client.db(db).collection('items').insertOne({ k: 1 })
    const name = await backUp('mmbak')
    const target = `${db}_w`
    await client.db(target).collection('base').insertOne({ n: 0 })
    await client.db(target).createCollection('orders', { viewOn: 'base', pipeline: [] })
    await client.db(target).createCollection('items', { capped: true, size: 8192 })
    const asked = await card([
      { name: 'restore_backup', args: { backup: name, connection: 'Test', database: target } },
    ])
    expect(asked.step.proposal!.preview).toMatchObject({
      skipped: 1,
      warnings: ['capped', 'source'],
      capped: [`${target}.items`],
    })
    const { ended } = await asked.decide('confirm', { confirm: target, password: PASSWORD })
    expect(ended).toMatchObject({ state: 'done' })
    expect((await waitJob(h.t, String(ended.summary!.job), 60_000)).state).toBe('done')
    expect(await client.db(target).collection('items').countDocuments()).toBe(1)
  }, 150_000)

  // M4, N1: two backups of one name told apart by the connection they were made of, or by their id.
  it('tells two backups of one name apart by their connection or their id', async () => {
    const { h, db, inject, backUp, once, turn, card } = await restoring()
    const name = await backUp('gzip')
    const other = namedConnection(h.t.app, mongo.port, 'Other')
    const body = { scope: { kind: 'database', db }, format: 'gzip' }
    const plan = (await inject('POST', `connections/${other}/backup/plan`, body)).json()
    const res = await inject('POST', `connections/${other}/backup`, { ...body, planHash: plan.planHash })
    const job = await waitJob(h.t, res.json().job.id, 60_000)
    const otherId = (await inject('GET', `transfer/jobs/${job.id}/report`)).json().backupId as string
    h.t.app.ctx.store.db.prepare('UPDATE backups SET name = ? WHERE id = ?').run(name, otherId)
    once([{ name: 'restore_backup', args: { backup: name, connection: 'Test', database: `${db}_a` } }])
    expect(steps(await turn('restore'))[0]).toMatchObject({ state: 'refused', reason: 'backup_ambiguous' })
    const byFrom = await card([
      {
        name: 'restore_backup',
        args: { backup: name, from: 'Other', connection: 'Test', database: `${db}_a` },
      },
    ])
    expect(byFrom.step.proposal!.preview).toMatchObject({ from: 'Other' })
    const byFromMade = byFrom.step.proposal!.preview!.made
    await byFrom.decide('decline')
    const byId = await card([
      { name: 'restore_backup', args: { backup: otherId, connection: 'Test', database: `${db}_a` } },
    ])
    expect(byId.step.proposal!.preview).toMatchObject({ from: 'Other' })
    // Fourth review of B2 (I1): two of one name told apart on the card too, by when each was made.
    const listed = (await inject('GET', 'backups')).json() as Array<{ id: string; finishedAt: number }>
    expect(byId.step.proposal!.preview!.made).toBe(listed.find((b) => b.id === otherId)!.finishedAt)
    expect(byFromMade).toBe(listed.find((b) => b.id === otherId)!.finishedAt)
    await byId.decide('decline')
    once([{ name: 'restore_backup', args: { backup: name, from: 'Nowhere', connection: 'Test' } }])
    expect(steps(await turn('restore'))[0]).toMatchObject({ state: 'refused', reason: 'backup_from_unknown' })
  }, 150_000)

  // Fourth review of B2 (M1): a collection's name may hold ", ": capped targets kept by name, whole.
  it('restores into a capped target whose name holds a comma', async () => {
    const { db, backUp, card, h } = await restoring()
    await client.db(db).collection('a, b').insertOne({ k: 1 })
    const name = await backUp('mmbak')
    const target = `${db}_c`
    await client.db(target).createCollection('a, b', { capped: true, size: 8192 })
    const asked = await card([
      { name: 'restore_backup', args: { backup: name, connection: 'Test', database: target } },
    ])
    expect(asked.step.proposal!.preview?.capped).toEqual([`${target}.a, b`])
    const { ended } = await asked.decide('confirm', { confirm: target, password: PASSWORD })
    expect(ended).toMatchObject({ state: 'done' })
    expect((await waitJob(h.t, String(ended.summary!.job), 60_000)).state).toBe('done')
  }, 150_000)

  // M4: an encrypted backup of another connection to the same server says so on its card.
  it('says an encrypted backup of another connection to the same server writes over it', async () => {
    const { db, backUp, card, h } = await restoring()
    const other = namedConnection(h.t.app, mongo.port, 'Other')
    const name = await backUp('mmbak', { kind: 'database', db }, other)
    const asked = await card([
      { name: 'restore_backup', args: { backup: name, connection: 'Test', database: db, mode: 'replace' } },
    ])
    expect(asked.step.proposal).toMatchObject({
      opening: true,
      preview: { from: 'Other', warnings: ['source'] },
    })
    await asked.decide('decline')
  }, 150_000)

  // M2: what only the password shows is said as such; a change since the card is a change.
  it('tells what only the password shows from a change since the card', async () => {
    const { db, backUp, card, h } = await restoring()
    // The same server by another name: the plan sees it (it asks the server), the card cannot.
    const loop = namedConnection(h.t.app, mongo.port, 'Loop', {
      settings: { hosts: [{ host: 'localhost', port: mongo.port }] },
    })
    const name = await backUp('mmbak', { kind: 'database', db }, loop)
    const ask = () =>
      card([
        { name: 'restore_backup', args: { backup: name, connection: 'Test', database: db, mode: 'replace' } },
      ])
    const first = await ask()
    expect(first.step.proposal!.preview?.warnings ?? []).not.toContain('source')
    const shown = await first.decide('confirm', { confirm: db, password: PASSWORD })
    expect(shown.ended).toMatchObject({ state: 'error', reason: 'restore_plan_differs' })
    const second = await ask()
    // Since its card, a target turned a view: left out now — a change, not what the password shows.
    await client.db(db).collection('orders').drop()
    await client.db(db).collection('base').insertOne({ n: 0 })
    await client.db(db).createCollection('orders', { viewOn: 'base', pipeline: [] })
    const changed = await second.decide('confirm', { confirm: db, password: PASSWORD })
    expect(changed.ended).toMatchObject({ state: 'error', reason: 'plan_changed' })
  }, 150_000)
})
