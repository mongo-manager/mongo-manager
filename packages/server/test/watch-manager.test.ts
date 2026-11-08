// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it } from 'vitest'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { Timestamp, type Document, type MongoClient } from 'mongodb'
import { ConnectionSettingsSchema, WatchOptionsSchema, type Role } from '@mongo-manager/shared'
import { makeApp, type TestApp } from './helpers'
import type { StreamLike, WatchMessage } from '../src/changestreams/feed'
import { WatchRefusal } from '../src/changestreams/target'
import type { Subscriber, WatchRequest } from '../src/changestreams/manager'

const apps: TestApp[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(check: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('condition not reached')
    await wait(5)
  }
}

function fakeStream() {
  const queue: Document[] = []
  let token = 0
  const s = {
    closed: false,
    push: (d: Document) => queue.push(d),
    get resumeToken() {
      return { t: token }
    },
    async tryNext() {
      if (s.closed) throw Object.assign(new Error('closed'), { name: 'MongoAPIError' })
      await wait(1)
      const d = queue.shift()
      if (d) token++
      return d ?? null
    },
    async close() {
      s.closed = true
    },
  }
  return s
}

async function setup(
  config: object = {},
  o: { inspectMs?: number; exists?: boolean; limits?: object; timing?: object } = {},
) {
  const opened: Array<{ resumeAfter: unknown; pipeline: Document[]; stream: ReturnType<typeof fakeStream> }> =
    []
  const t = await makeApp(
    { auth: true, ...config },
    {
      watch: {
        timing: { flushMs: 10, waitMs: 5, ...o.timing },
        limits: { graceMs: 200, ...o.limits },
        client: async () => ({}) as MongoClient,
        inspect: async () => {
          if (o.inspectMs) await wait(o.inspectMs)
          return { preImages: false, exists: o.exists ?? true }
        },
        openStream: (_client, _target, pipeline, options) => {
          const stream = fakeStream()
          opened.push({ resumeAfter: options.resumeAfter ?? null, pipeline, stream })
          return stream as unknown as StreamLike
        },
      },
    },
  )
  apps.push(t)
  const { ctx } = t.app
  const connectionId = ctx.connections.create(
    {
      name: 'C',
      favorite: false,
      readOnly: false,
      settings: ConnectionSettingsSchema.parse({ hosts: [{ host: '127.0.0.1', port: 1 }] }),
    },
    null,
  ).id
  const user = (role: Role = 'viewer', grant?: Role | 'none') => {
    const u = ctx.users.create({ username: `u-${Math.random()}`, passwordHash: 'x', role })
    if (grant) ctx.grants.set(connectionId, u.id, grant)
    const { session } = ctx.sessions.create(u.id, {})
    return {
      id: u.id,
      principal: {
        kind: 'user' as const,
        userId: u.id,
        username: u.username,
        role,
        csrfToken: session.csrfToken,
        sessionId: 's',
        sessionIdHash: 'h',
      },
    }
  }
  const subscriber = (who: ReturnType<typeof user>) => {
    const sent: WatchMessage[] = []
    const endedIds: string[] = []
    const sub: Subscriber & { sent: WatchMessage[]; gone: boolean; endedIds: string[] } = {
      sent,
      gone: false,
      endedIds,
      ip: '10.0.0.1',
      principal: () => (sub.gone ? null : who.principal),
      send: (m) => sent.push(m),
      writable: () => true,
      ended: (id) => endedIds.push(id),
    }
    return sub
  }
  const request = (over: Partial<WatchRequest> = {}): WatchRequest => ({
    id: randomUUID(),
    target: { connectionId, scope: 'collection', db: 'shop', coll: 'orders' },
    filter: {},
    options: WatchOptionsSchema.parse({}),
    ...over,
  })
  const audit = (action: string) =>
    ctx.store.db
      .prepare('SELECT details, outcome, ip FROM audit_log WHERE action = ? ORDER BY rowid')
      .all(action) as Array<{
      details: string
      outcome: string
      ip: string | null
    }>
  const holds = () => (ctx.manager as unknown as { holds: Map<string, number> }).holds.get(connectionId) ?? 0
  return { t, ctx, connectionId, user, subscriber, request, opened, audit, holds, watch: ctx.watch }
}
const refusal = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (e) {
    return e instanceof WatchRefusal ? { reason: e.reason, detail: e.detail } : { reason: 'thrown' }
  }
  return null
}
const insert = (n: number): Document => ({
  operationType: 'insert',
  clusterTime: new Timestamp({ t: 1, i: n }),
  ns: { db: 'shop', coll: 'orders' },
  documentKey: { _id: n },
})

describe('the watch manager (phase 3e-1 spec §1.2, §2)', () => {
  it('starts a feed, says so, streams it, and audits start and stop without filter values', async () => {
    const s = await setup()
    const u = s.user()
    const sub = s.subscriber(u)
    const req = s.request({ filter: { 'fullDocument.n': { $gt: 1 } } })
    await s.watch.start(u.id, req, sub)
    expect(sub.sent[0]).toEqual({
      ch: 'watch',
      type: 'started',
      payload: { id: req.id, preImages: false, resumed: false, gap: false, paused: false, exists: true },
    })
    s.opened[0]!.stream.push(insert(1))
    await until(() => sub.sent.some((m) => m.type === 'events'))
    await s.watch.stop(u.id, req.id, sub)
    expect(s.watch.count()).toBe(0)
    const [start] = s.audit('watch.start')
    expect(JSON.parse(start!.details)).toMatchObject({
      scope: 'collection',
      ops: ['insert', 'update', 'replace', 'delete'],
      filter: expect.stringMatching(/^[0-9a-f]{64}$/),
    })
    expect(start!.details).not.toContain('$gt')
    const [stop] = s.audit('watch.stop')
    expect(JSON.parse(stop!.details)).toMatchObject({ reason: 'closed', events: 1 })
  })

  it('refuses without documents:read, an unknown connection, a credential collection, or when turned off (W1)', async () => {
    const s = await setup()
    const none = s.user('viewer', 'none')
    expect(await refusal(s.watch.start(none.id, s.request(), s.subscriber(none)))).toEqual({
      reason: 'access',
      detail: undefined,
    })
    const u = s.user()
    expect(
      await refusal(
        s.watch.start(
          u.id,
          s.request({ target: { connectionId: 'nope', scope: 'deployment' } }),
          s.subscriber(u),
        ),
      ),
    ).toMatchObject({ reason: 'access' })
    expect(
      await refusal(
        s.watch.start(
          u.id,
          s.request({
            target: { connectionId: s.connectionId, scope: 'collection', db: 'admin', coll: 'system.users' },
          }),
          s.subscriber(u),
        ),
      ),
    ).toMatchObject({ reason: 'access' })
    const off = await setup({ watch: { enabled: false, maxFeeds: 50 } })
    const v = off.user()
    expect(await refusal(off.watch.start(v.id, off.request(), off.subscriber(v)))).toMatchObject({
      reason: 'turned_off',
    })
  })

  it('bounds feeds per user and per server (W5)', async () => {
    const s = await setup({ watch: { enabled: true, maxFeeds: 6 } })
    const a = s.user()
    for (let i = 0; i < 5; i++) await s.watch.start(a.id, s.request(), s.subscriber(a))
    expect(await refusal(s.watch.start(a.id, s.request(), s.subscriber(a)))).toEqual({
      reason: 'limit',
      detail: 'user',
    })
    const b = s.user()
    await s.watch.start(b.id, s.request(), s.subscriber(b))
    expect(await refusal(s.watch.start(b.id, s.request(), s.subscriber(b)))).toEqual({
      reason: 'limit',
      detail: 'server',
    })
  })

  it('refuses a restricted user’s filter on a personal path, and audits the refusal (W3)', async () => {
    const s = await setup()
    const u = s.user('viewer', 'viewer')
    s.ctx.grants.setMasked(s.connectionId, u.id, true)
    s.ctx.personalFields.set(s.connectionId, [{ db: 'shop', coll: 'orders', field: 'email' }])
    expect(
      await refusal(
        s.watch.start(u.id, s.request({ filter: { 'fullDocument.email': 'a@x' } }), s.subscriber(u)),
      ),
    ).toEqual({ reason: 'masking_filter', detail: 'fullDocument.email' })
    expect(s.audit('masking.refused')).toHaveLength(1)
    expect(s.audit('masking.refused')[0]!.details).not.toContain('a@x')
  })

  it('resumes a detached feed within the grace, for its owner, id and parameters only (W6)', async () => {
    const s = await setup()
    const u = s.user()
    const req = s.request()
    const first = s.subscriber(u)
    await s.watch.start(u.id, req, first)
    s.opened[0]!.stream.push(insert(1))
    await until(
      () =>
        s.opened[0]!.stream.resumeToken !== null &&
        (s.opened[0]!.stream.resumeToken as { t: number }).t === 1,
    )
    await wait(30)
    await s.watch.detach(u.id, req.id, first)
    expect(s.watch.count()).toBe(0)
    expect(s.watch.parked(u.id)).toBe(1)
    const again = s.subscriber(u)
    await s.watch.start(u.id, req, again)
    expect(s.opened[1]!.resumeAfter).toEqual({ t: 1 })
    expect(again.sent[0]).toMatchObject({ type: 'started', payload: { resumed: true } })
    await s.watch.detach(u.id, req.id, again)
    // Other parameters, or another owner with the same id: from now.
    const third = s.subscriber(u)
    await s.watch.start(u.id, { ...req, filter: { 'ns.coll': 'x' } }, third)
    expect(s.opened[2]!.resumeAfter).toBeNull()
    await s.watch.detach(u.id, req.id, third)
    const other = s.user()
    await s.watch.start(other.id, req, s.subscriber(other))
    expect(s.opened[3]!.resumeAfter).toBeNull()
    // After the grace: from now.
    await wait(250)
    expect(s.watch.parked(u.id)).toBe(0)
    await s.watch.start(u.id, req, s.subscriber(u))
    expect(s.opened[4]!.resumeAfter).toBeNull()
  })

  it('ends a feed whose viewer lost access, and lets go of it (W2)', async () => {
    const s = await setup()
    const u = s.user()
    const sub = s.subscriber(u)
    const req = s.request()
    await s.watch.start(u.id, req, sub)
    s.ctx.grants.set(s.connectionId, u.id, 'none')
    await until(() => sub.sent.some((m) => m.type === 'ended'))
    expect(sub.sent.at(-1)).toEqual({ ch: 'watch', type: 'ended', payload: { id: req.id, reason: 'access' } })
    expect(s.watch.count()).toBe(0)
  })

  // Final review I1: limits hold for starts in flight, and a duplicate id leaks no hold.
  it('counts starts in flight against the limits', async () => {
    const s = await setup({}, { inspectMs: 30 })
    const u = s.user()
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => s.watch.start(u.id, s.request(), s.subscriber(u))),
    )
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(5)
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect(refused.reason).toMatchObject({ reason: 'limit', detail: 'user' })
    expect(s.watch.count(u.id)).toBe(5)
  })

  it('keeps one feed for an id sent twice at once, and releases every hold', async () => {
    const s = await setup({}, { inspectMs: 30 })
    const u = s.user()
    const sub = s.subscriber(u)
    const req = s.request()
    await Promise.all([s.watch.start(u.id, req, sub), s.watch.start(u.id, req, sub)])
    expect(s.watch.count()).toBe(1)
    expect(s.opened.filter((o) => !o.stream.closed)).toHaveLength(1)
    await s.watch.stop(u.id, req.id, sub)
    await wait(20)
    expect(s.holds()).toBe(0)
    expect(s.opened.every((o) => o.stream.closed)).toBe(true)
  })

  // Final review I2: an unsubscribe during a start leaves no feed behind.
  it('cancels a start its socket stopped while it was starting', async () => {
    const s = await setup({}, { inspectMs: 50 })
    const u = s.user()
    const sub = s.subscriber(u)
    const req = s.request()
    const starting = s.watch.start(u.id, req, sub)
    await wait(10)
    await s.watch.stop(u.id, req.id, sub)
    await starting
    expect(s.watch.count()).toBe(0)
    expect(sub.sent.some((m) => m.type === 'started')).toBe(false)
    expect(s.holds()).toBe(0)
    expect(s.opened).toHaveLength(0)
  })

  // Final review I3: a reconnect takes the feed over; the old socket can no longer touch it.
  it('hands a feed to the socket that took it over, and ignores the old one', async () => {
    const s = await setup()
    const u = s.user()
    const a = s.subscriber(u)
    const b = s.subscriber(u)
    const req = s.request()
    await s.watch.start(u.id, req, a)
    await s.watch.start(u.id, req, b)
    expect(a.endedIds).toEqual([req.id])
    s.watch.pause(u.id, req.id, a)
    await s.watch.stop(u.id, req.id, a)
    await s.watch.detach(u.id, req.id, a)
    expect(s.watch.count()).toBe(1)
    expect(b.sent.some((m) => m.type === 'paused')).toBe(false)
    s.opened.at(-1)!.stream.push(insert(1))
    await until(() => b.sent.some((m) => m.type === 'events'))
    expect(s.audit('watch.stop').map((r) => JSON.parse(r.details).reason)).toEqual(['replaced'])
    await s.watch.stop(u.id, req.id, b)
  })

  // Final review I5: a reconnect resumes after the last event the browser received.
  it('resumes after the last event received, and says when it cannot', async () => {
    const s = await setup({}, { timing: { maxBatch: 1 } })
    const u = s.user()
    const a = s.subscriber(u)
    const req = s.request()
    await s.watch.start(u.id, req, a)
    for (let n = 1; n <= 3; n++) s.opened[0]!.stream.push(insert(n))
    await until(() => a.sent.filter((m) => m.type === 'events').length === 3)
    await s.watch.detach(u.id, req.id, a)
    const b = s.subscriber(u)
    await s.watch.start(u.id, { ...req, after: 1 }, b)
    expect(s.opened[1]!.resumeAfter).toEqual({ t: 1 })
    expect(b.sent[0]).toMatchObject({ type: 'started', payload: { resumed: true, gap: false } })
    s.opened[1]!.stream.push(insert(9))
    await until(() => b.sent.some((m) => m.type === 'events'))
    const first = b.sent.find((m) => m.type === 'events')!
    expect(first.type === 'events' && first.payload.events[0]!.seq).toBe(2)
    await s.watch.detach(u.id, req.id, b)
    const c = s.subscriber(u)
    await s.watch.start(u.id, { ...req, after: 42 }, c)
    expect(c.sent[0]).toMatchObject({ type: 'started', payload: { resumed: true, gap: true } })
    await s.watch.stop(u.id, req.id, c)
  })

  // Final review I7: a filter is checked again when its viewer's masking changes.
  it('ends a feed whose filter reads a field that became personal, and audits it', async () => {
    const s = await setup()
    const u = s.user('viewer', 'viewer')
    s.ctx.grants.setMasked(s.connectionId, u.id, true)
    const sub = s.subscriber(u)
    const req = s.request({ filter: { 'fullDocument.ssn': { $regex: '^123' } } })
    await s.watch.start(u.id, req, sub)
    s.ctx.personalFields.set(s.connectionId, [{ db: 'shop', coll: 'orders', field: 'ssn' }])
    await until(() => sub.sent.some((m) => m.type === 'ended'))
    expect(sub.sent.at(-1)).toEqual({
      ch: 'watch',
      type: 'ended',
      payload: { id: req.id, reason: 'masking_filter', detail: 'fullDocument.ssn' },
    })
    expect(s.audit('masking.refused')).toHaveLength(1)
    expect(s.audit('masking.refused')[0]!.details).not.toContain('123')
  })

  it('checks the filter again when an unrestricted viewer becomes restricted', async () => {
    const s = await setup()
    s.ctx.personalFields.set(s.connectionId, [{ db: 'shop', coll: 'orders', field: 'ssn' }])
    const u = s.user('viewer', 'viewer')
    const sub = s.subscriber(u)
    const req = s.request({ filter: { 'fullDocument.ssn': '123-45' } })
    await s.watch.start(u.id, req, sub)
    s.ctx.grants.setMasked(s.connectionId, u.id, true)
    await until(() => sub.sent.some((m) => m.type === 'ended'))
    expect(sub.sent.at(-1)).toMatchObject({ payload: { reason: 'masking_filter' } })
  })

  // Final review M2: a filter that is not valid Extended JSON is refused in its own words.
  it('refuses a filter that is not valid Extended JSON as a filter problem', async () => {
    const s = await setup()
    const u = s.user()
    expect(
      await refusal(s.watch.start(u.id, s.request({ filter: { n: { $numberLong: 'x' } } }), s.subscriber(u))),
    ).toEqual({ reason: 'filter', detail: 'ejson' })
  })

  // Final review M7: audit rows carry the address; the filter is named by a keyed hash.
  it('audits with the address, a keyed filter hash, and why a feed left', async () => {
    const s = await setup()
    const u = s.user()
    const sub = s.subscriber(u)
    const filter = { 'fullDocument.email': 'x@y' }
    const req = s.request({ filter })
    await s.watch.start(u.id, req, sub)
    sub.gone = true
    await s.watch.detach(u.id, req.id, sub)
    const [start] = s.audit('watch.start')
    expect(start!.ip).toBe('10.0.0.1')
    const hash = JSON.parse(start!.details).filter as string
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hash).not.toBe(createHash('sha256').update(JSON.stringify(filter)).digest('hex'))
    expect(hash).not.toBe(createHmac('sha256', '').update(JSON.stringify(filter)).digest('hex'))
    const [stop] = s.audit('watch.stop')
    expect(stop!.ip).toBe('10.0.0.1')
    expect(JSON.parse(stop!.details).reason).toBe('access')
  })

  // Final review M8: starting feeds is rate limited per user, resumes from now included.
  it('limits how often a user starts feeds', async () => {
    const s = await setup({}, { limits: { startsPerMinute: 3 } })
    const u = s.user()
    const sub = s.subscriber(u)
    const req = s.request()
    await s.watch.start(u.id, req, sub)
    await s.watch.stop(u.id, req.id, sub)
    await s.watch.start(u.id, s.request(), sub)
    const third = s.request()
    await s.watch.start(u.id, third, sub)
    expect(await refusal(s.watch.start(u.id, s.request(), sub))).toEqual({ reason: 'limit', detail: 'rate' })
    // Over the rate, a resume from now resumes where it was.
    s.watch.pause(u.id, third.id, sub)
    await s.watch.resume(u.id, third.id, 'now', sub)
    expect(sub.sent.at(-1)).toMatchObject({ type: 'resumed', payload: { from: 'here' } })
  })

  // Final review M10, M4: a feed starts paused when asked, and says whether its collection exists.
  it('starts paused when asked, and says a collection does not exist yet', async () => {
    const s = await setup({}, { exists: false })
    const u = s.user()
    const sub = s.subscriber(u)
    const req = s.request({ paused: true })
    await s.watch.start(u.id, req, sub)
    expect(sub.sent[0]).toMatchObject({ type: 'started', payload: { paused: true, exists: false } })
    s.opened[0]!.stream.push(insert(1))
    await wait(60)
    expect(sub.sent.some((m) => m.type === 'events')).toBe(false)
    await s.watch.resume(u.id, req.id, 'here', sub)
    await until(() => sub.sent.some((m) => m.type === 'events'))
    await s.watch.stop(u.id, req.id, sub)
  })
})
