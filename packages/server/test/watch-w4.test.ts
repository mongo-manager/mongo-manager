// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { RECORDING_JOB, recordingJob } from '../src/changestreams/recording'
import { MongoClient } from 'mongodb'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { H, type TestApp } from './helpers'
import { watchApp } from './support/watch'

import type { AppEvent } from '@mongo-manager/shared'
import { slow } from './support/slowness'

/**
 * W4 item 7 (completion design §2 W4.7): change streams — pre- and post-images turned on from
 * the Watch page, events recorded to a bounded file and replayed or exported, and the alert hook.
 */
let set: MongoMemoryReplSet
let mc: MongoClient
beforeAll(async () => {
  set = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
  mc = await new MongoClient(set.getUri()).connect()
}, slow(180_000))
afterAll(async () => {
  await mc?.close()
  await set?.stop()
})
const apps: TestApp[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})
const name = (prefix: string) => `${prefix}${randomUUID().slice(0, 8)}`

async function setup() {
  const w = await watchApp(set.getUri())
  apps.push(w.t)
  const call = (
    u: ReturnType<typeof w.user>,
    method: 'GET' | 'PUT' | 'POST' | 'DELETE',
    url: string,
    payload?: unknown,
  ) =>
    w.t.app.inject({
      method,
      url,
      headers: { ...H, 'x-csrf-token': u.csrf },
      cookies: { mm_sid: u.sessionId },
      ...(payload === undefined ? {} : { payload: payload as object }),
    })
  return { w, call }
}

describe('pre- and post-images from the Watch page (W4.7)', () => {
  it('turns them on and off for a collection, for those who may change its options', async () => {
    const { w, call } = await setup()
    const admin = w.user('admin')
    const viewer = w.user('viewer', { grant: 'viewer' })
    const db = name('pi')
    await mc.db(db).createCollection('orders')
    const url = `/api/connections/${w.connectionId}/databases/${db}/collections/orders/pre-images`
    const options = async () =>
      (((await mc.db(db).listCollections({ name: 'orders' }).toArray())[0] as { options?: object }).options ??
        {}) as {
        changeStreamPreAndPostImages?: { enabled: boolean }
      }
    expect((await call(viewer, 'PUT', url, { enabled: true })).statusCode).toBe(403)
    expect((await options()).changeStreamPreAndPostImages?.enabled).not.toBe(true)
    const on = await call(admin, 'PUT', url, { enabled: true })
    expect([on.statusCode, on.json()]).toEqual([200, { enabled: true }])
    expect((await options()).changeStreamPreAndPostImages).toEqual({ enabled: true })
    const off = await call(admin, 'PUT', url, { enabled: false })
    expect(off.json()).toEqual({ enabled: false })
    expect((await options()).changeStreamPreAndPostImages?.enabled).not.toBe(true)
    // Audited, with the collection and the new state.
    const audit = w.t.app.ctx.audit
      .list({ limit: 10 })
      .filter(
        (e: { action: string; outcome: string }) =>
          e.action === 'collections.preimages' && e.outcome === 'success',
      )
    expect(audit.length).toBe(2)
    // A missing collection, a view, a credential namespace: refused.
    expect(
      (
        await call(
          admin,
          'PUT',
          `/api/connections/${w.connectionId}/databases/${db}/collections/nope/pre-images`,
          { enabled: true },
        )
      ).statusCode,
    ).toBe(404)
    await mc.db(db).createCollection('v', { viewOn: 'orders', pipeline: [] })
    const view = await call(
      admin,
      'PUT',
      `/api/connections/${w.connectionId}/databases/${db}/collections/v/pre-images`,
      { enabled: true },
    )
    expect([view.statusCode, view.json().details?.reason]).toEqual([409, 'view'])
    const editor = w.user('editor', { grant: 'editor' })
    const creds = await call(
      editor,
      'PUT',
      `/api/connections/${w.connectionId}/databases/admin/collections/system.users/pre-images`,
      {
        enabled: true,
      },
    )
    expect(creds.statusCode).toBe(403)
  })
})

describe('recorded feeds (W4.7)', () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
  async function record(
    w: Awaited<ReturnType<typeof setup>>['w'],
    u: ReturnType<Awaited<ReturnType<typeof setup>>['w']['user']>,
    db: string,
    options: Record<string, unknown> = { record: true },
  ) {
    const c = await w.socket(u)
    const id = randomUUID()
    c.send({
      ch: 'watch',
      type: 'sub',
      id,
      connectionId: w.connectionId,
      scope: 'collection',
      db,
      coll: 'people',
      filter: {},
      options,
    })
    const started = await c
      .next('started', (m) => m.payload.id === id)
      .catch(async () => {
        throw new Error(JSON.stringify(await c.next('error', (m) => m.payload.id === id)))
      })
    return { c, id, started: started.payload }
  }

  it('records what the viewer was sent, for them alone to list, replay, download and delete', async () => {
    const { w, call } = await setup()
    const editor = w.user('editor', { grant: 'editor' })
    const db = name('rc')
    await mc.db(db).createCollection('people')
    const { c, id, started } = await record(w, editor, db)
    expect(started.recording).toBe(true)
    await mc
      .db(db)
      .collection('people')
      .insertMany([{ n: 1 }, { n: 2 }, { n: 3 }])
    while (c.events(id).length < 3) await wait(25)
    c.send({ ch: 'watch', type: 'unsub', id })
    await wait(300)
    const list = await call(editor, 'GET', `/api/connections/${w.connectionId}/watch/recordings`)
    expect(list.statusCode).toBe(200)
    const [rec] = list.json() as Array<{ id: string; size: number; recording: boolean; namespace: string }>
    expect(rec).toMatchObject({ recording: false, namespace: `${db}.people` })
    expect(rec!.size).toBeGreaterThan(0)
    const file = await call(editor, 'GET', `/api/connections/${w.connectionId}/watch/recordings/${rec!.id}`)
    expect(file.statusCode, file.body).toBe(200)
    const lines = file.body
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    expect(lines.map((e) => [e.seq, e.op])).toEqual([
      [1, 'insert'],
      [2, 'insert'],
      [3, 'insert'],
    ])
    // Another user, an administrator included, finds nothing.
    const admin = w.user('admin')
    expect((await call(admin, 'GET', `/api/connections/${w.connectionId}/watch/recordings`)).json()).toEqual(
      [],
    )
    expect(
      (await call(admin, 'GET', `/api/connections/${w.connectionId}/watch/recordings/${rec!.id}`)).statusCode,
    ).toBe(404)
    expect(
      (await call(editor, 'DELETE', `/api/connections/${w.connectionId}/watch/recordings/${rec!.id}`))
        .statusCode,
    ).toBe(204)
    expect((await call(editor, 'GET', `/api/connections/${w.connectionId}/watch/recordings`)).json()).toEqual(
      [],
    )
  })

  it('records a masked viewer’s events masked, and refuses them once the rules move', async () => {
    const { w, call } = await setup()
    const db = name('rm')
    await mc.db(db).createCollection('people')
    w.ctx.personalFields.set(w.connectionId, [{ db, coll: 'people', field: 'email' }])
    const masked = w.user('editor', { grant: 'editor', masked: true })
    const { c, id } = await record(w, masked, db)
    await mc.db(db).collection('people').insertOne({ email: 'ada@example.com', n: 1 })
    while (c.events(id).length < 1) await wait(25)
    c.send({ ch: 'watch', type: 'unsub', id })
    await wait(300)
    const [rec] = (await call(masked, 'GET', `/api/connections/${w.connectionId}/watch/recordings`)).json()
    expect(rec.masked).toBe(true)
    const file = await call(masked, 'GET', `/api/connections/${w.connectionId}/watch/recordings/${rec.id}`)
    expect(file.body).not.toContain('ada@example.com')
    expect(file.body).toContain('***')
    w.ctx.personalFields.set(w.connectionId, [
      { db, coll: 'people', field: 'email' },
      { db, coll: 'people', field: 'n' },
    ])
    const moved = await call(masked, 'GET', `/api/connections/${w.connectionId}/watch/recordings/${rec.id}`)
    expect([moved.statusCode, moved.json().details?.reason]).toEqual([409, 'rules_changed'])
  })

  // W4 review I8: a file labelled masked never holds an event sent unmasked.
  it('begins a new file when the viewer’s masking changes mid-feed', async () => {
    const { w, call } = await setup()
    const db = name('rx')
    await mc.db(db).createCollection('people')
    w.ctx.personalFields.set(w.connectionId, [{ db, coll: 'people', field: 'email' }])
    const viewer = w.user('editor', { grant: 'editor', masked: true })
    const { c, id } = await record(w, viewer, db)
    const people = mc.db(db).collection('people')
    await people.insertOne({ email: 'ada@example.com', n: 1 })
    while (c.events(id).length < 1) await wait(25)
    // The viewer may see personal values from now on.
    w.ctx.grants.setMasked(w.connectionId, viewer.id, false)
    await people.insertOne({ email: 'bob@example.com', n: 2 })
    while (c.events(id).length < 2) await wait(25)
    c.send({ ch: 'watch', type: 'unsub', id })
    await wait(300)
    const list = (
      await call(viewer, 'GET', `/api/connections/${w.connectionId}/watch/recordings`)
    ).json() as Array<{
      id: string
      masked: boolean
    }>
    expect(list.map((r) => r.masked).sort()).toEqual([false, true])
    const body = async (masked: boolean) =>
      (
        await call(
          viewer,
          'GET',
          `/api/connections/${w.connectionId}/watch/recordings/${list.find((r) => r.masked === masked)!.id}`,
        )
      ).body
    const maskedFile = await body(true)
    expect(maskedFile).not.toContain('example.com')
    expect(maskedFile).toContain('***')
    expect(await body(false)).toContain('bob@example.com')
  })

  // W4 review I9: a replay is read a page at a time from the server, never the whole file at once.
  it('gives a recording to replay page by page, leaving out a line still being written', async () => {
    const { w, call } = await setup()
    const editor = w.user('editor', { grant: 'editor' })
    const db = name('rp')
    await mc.db(db).createCollection('people')
    const { c, id } = await record(w, editor, db)
    await mc
      .db(db)
      .collection('people')
      .insertMany(Array.from({ length: 7 }, (_, n) => ({ n })))
    while (c.events(id).length < 7) await wait(25)
    c.send({ ch: 'watch', type: 'unsub', id })
    await wait(300)
    const [rec] = (await call(editor, 'GET', `/api/connections/${w.connectionId}/watch/recordings`)).json()
    const page = async (from: number, limit = 3) =>
      call(
        editor,
        'GET',
        `/api/connections/${w.connectionId}/watch/recordings/${rec.id}/events?from=${from}&limit=${limit}`,
      )
    const seqs: number[] = []
    let from = 0
    for (let i = 0; i < 5; i++) {
      const res = await page(from)
      expect(res.statusCode, res.body).toBe(200)
      const body = res.json() as { events: Array<{ seq: number }>; next: number; end: boolean }
      seqs.push(...body.events.map((e) => e.seq))
      from = body.next
      if (body.end) break
    }
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7])
    // A line still being written (no end of line yet) is not given, and the place stays before it.
    const file = w.ctx.transfer.files.get(editor.id, rec.id)!
    appendFileSync(w.ctx.transfer.files.pathOf(file), '{"seq":8,"op":"ins')
    const tail = (await page(from)).json() as { events: unknown[]; next: number; end: boolean }
    expect([tail.events, tail.next, tail.end]).toEqual([[], from, true])
    // The same checks as the download: another user finds nothing; a bad place is refused.
    const other = w.user('editor', { grant: 'editor' })
    expect(
      (
        await call(
          other,
          'GET',
          `/api/connections/${w.connectionId}/watch/recordings/${rec.id}/events?from=0`,
        )
      ).statusCode,
    ).toBe(404)
    expect((await page(-1)).statusCode).toBe(400)
  })

  it('names a recording of an upper-case feed id as its own (W4 review minor)', () => {
    const upper = randomUUID().toUpperCase()
    expect(RECORDING_JOB.test(recordingJob(upper, 5))).toBe(true)
  })

  it('refuses to record for someone without the export right', async () => {
    const { w } = await setup()
    const viewer = w.user('viewer', { grant: 'viewer' })
    const db = name('rv')
    await mc.db(db).createCollection('people')
    const c = await w.socket(viewer)
    const id = randomUUID()
    c.send({
      ch: 'watch',
      type: 'sub',
      id,
      connectionId: w.connectionId,
      scope: 'collection',
      db,
      coll: 'people',
      filter: {},
      options: { record: true },
    })
    const refused = await c.next('error', (m) => m.payload.id === id)
    expect(refused.payload.reason).toBe('record_denied')
  })
})

describe('the alert hook (W4.7)', () => {
  it('raises watch.matched for events that pass the feed’s filter, with counts and never a value', async () => {
    const { w } = await setup()
    const events: AppEvent[] = []
    const off = w.ctx.events.on((e) => void events.push(e))
    try {
      const editor = w.user('editor', { grant: 'editor' })
      const db = name('al')
      await mc.db(db).createCollection('people')
      const c = await w.socket(editor)
      const id = randomUUID()
      c.send({
        ch: 'watch',
        type: 'sub',
        id,
        connectionId: w.connectionId,
        scope: 'collection',
        db,
        coll: 'people',
        filter: { 'fullDocument.vip': true },
        options: { alert: true },
      })
      await c.next('started', (m) => m.payload.id === id)
      await mc
        .db(db)
        .collection('people')
        .insertMany([
          { vip: false, email: 'a@example.com' },
          { vip: true, email: 'b@example.com' },
        ])
      while (c.events(id).length < 1) await new Promise((r) => setTimeout(r, 25))
      const until = Date.now() + 5000
      while (!events.some((e) => e.kind === 'watch.matched') && Date.now() < until)
        await new Promise((r) => setTimeout(r, 25))
      const e = events.find((x) => x.kind === 'watch.matched')!
      expect(e).toMatchObject({
        namespace: `${db}.people`,
        details: { watch: id, operation: 'insert', count: 1 },
      })
      expect(JSON.stringify(e)).not.toContain('example.com')
    } finally {
      off()
    }
  })
})
