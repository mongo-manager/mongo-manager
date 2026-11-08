// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it } from 'vitest'
import { ConnectionSettingsSchema, type JobView, type Role } from '@mongo-manager/shared'
import type { JobKind } from '../src/jobs/types'
import { H, makeApp, type TestApp } from './helpers'

const apps: TestApp[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})

/** A job that runs until the test ends it; cancelling it always succeeds. */
function hangingKind(name: JobKind<unknown>['name']): JobKind<unknown> & { finish(): void } {
  const finishers: Array<() => void> = []
  return {
    name,
    run: (ctx) =>
      new Promise<void>((resolve, reject) => {
        finishers.push(resolve)
        ctx.signal.addEventListener('abort', () => reject(new Error('aborted')))
      }),
    cancel: async () => true,
    recover: () => 'interrupted',
    finish: () => finishers.splice(0).forEach((f) => f()),
  }
}

async function setup(overrides: object = {}) {
  const t = await makeApp({ auth: true, ...overrides }, { jobs: { cancelGraceMs: 100 } })
  apps.push(t)
  const { ctx } = t.app
  const connectionId = ctx.connections.create(
    {
      name: 'M',
      favorite: false,
      readOnly: false,
      settings: ConnectionSettingsSchema.parse({ hosts: [{ host: '127.0.0.1' }] }),
    },
    null,
  ).id
  const as = (role: Role, grant?: 'admin' | 'editor' | 'viewer' | 'none') => {
    const user = ctx.users.create({ username: `u-${role}-${Math.random()}`, passwordHash: 'x', role })
    if (grant) ctx.grants.set(connectionId, user.id, grant)
    const { sessionId, session } = ctx.sessions.create(user.id, {})
    const call = (method: 'GET' | 'POST', url: string) =>
      t.app.inject({
        method,
        url,
        headers: { ...H, 'x-csrf-token': session.csrfToken },
        cookies: { mm_sid: sessionId },
      })
    return { id: user.id, call }
  }
  const start = (kind: JobKind<unknown>, userId: string | null, where: { db?: string; coll?: string } = {}) =>
    ctx.jobs.start(
      kind,
      { userId, connectionId, db: where.db ?? 'shop', coll: where.coll ?? 'orders', target: 'x' },
      {},
    )
  return { t, ctx, connectionId, as, start }
}

const ids = (jobs: JobView[]) => jobs.map((j) => j.id)

describe('job routes (phase 1h spec §5)', () => {
  it('refuses anonymous callers', async () => {
    const { t } = await setup()
    expect((await t.app.inject({ method: 'GET', url: '/api/jobs', headers: H })).statusCode).toBe(401)
  })

  it('shows a job to its owner, to others who may read the collection, and to admins', async () => {
    const { as, start } = await setup()
    const kind = hangingKind('index.create')
    const owner = as('editor')
    const other = as('editor')
    const reader = as('viewer')
    const hidden = as('viewer', 'none')
    const admin = as('admin')
    const job = start(kind, owner.id)
    const list = async (u: ReturnType<typeof as>) =>
      (await u.call('GET', '/api/jobs')).json().jobs as JobView[]
    expect(await list(owner)).toEqual([
      expect.objectContaining({ id: job.id, mine: true, cancellable: true }),
    ])
    expect(await list(other)).toEqual([
      expect.objectContaining({ id: job.id, mine: false, cancellable: false }),
    ])
    expect(ids(await list(reader))).toEqual([job.id])
    expect(await list(hidden)).toEqual([])
    expect(await list(admin)).toEqual([
      expect.objectContaining({ id: job.id, mine: false, cancellable: true }),
    ])
    // Neither the owner's id nor a staging name is ever shown.
    const shown = (await owner.call('GET', `/api/jobs/${job.id}`)).json().job
    expect(Object.keys(shown)).not.toContain('userId')
    expect(Object.keys(shown)).not.toContain('staging')
    // An invisible job answers like a missing one.
    expect((await hidden.call('GET', `/api/jobs/${job.id}`)).statusCode).toBe(404)
    expect((await hidden.call('POST', `/api/jobs/${job.id}/cancel`)).statusCode).toBe(404)
    kind.finish()
  })

  it('hides a job from its own owner once their grant on the connection is none (final review I1)', async () => {
    const { ctx, as, start, connectionId } = await setup()
    const kind = hangingKind('index.create')
    const owner = as('editor')
    const job = start(kind, owner.id)
    expect(ids((await owner.call('GET', '/api/jobs')).json().jobs)).toEqual([job.id])
    ctx.grants.set(connectionId, owner.id, 'none')
    expect((await owner.call('GET', '/api/jobs')).json().jobs).toEqual([])
    expect((await owner.call('GET', `/api/jobs/${job.id}`)).statusCode).toBe(404)
    expect((await owner.call('POST', `/api/jobs/${job.id}/cancel`)).statusCode).toBe(404)
    kind.finish()
  })

  it('hides jobs on credential collections from everyone but their owner and admins', async () => {
    const { as, start } = await setup()
    const kind = hangingKind('collection.duplicate')
    const owner = as('editor')
    const other = as('editor')
    const job = start(kind, owner.id, { db: 'admin', coll: 'system.users' })
    expect(ids((await other.call('GET', '/api/jobs')).json().jobs)).toEqual([])
    expect(ids((await owner.call('GET', '/api/jobs')).json().jobs)).toEqual([job.id])
    kind.finish()
  })

  it('lets only the owner or an admin with the manage permission cancel, and audits it', async () => {
    const { ctx, as, start, connectionId } = await setup()
    const kind = hangingKind('index.create')
    const owner = as('editor')
    const other = as('editor')
    const narrowed = as('editor', 'viewer')
    const mine = start(kind, owner.id)
    expect((await other.call('POST', `/api/jobs/${mine.id}/cancel`)).statusCode).toBe(403)
    const theirs = start(kind, narrowed.id)
    expect((await narrowed.call('POST', `/api/jobs/${theirs.id}/cancel`)).statusCode).toBe(403)
    const res = await owner.call('POST', `/api/jobs/${mine.id}/cancel`)
    expect(res.statusCode).toBe(200)
    expect(res.json().job).toMatchObject({ id: mine.id, state: 'cancelled', cancellable: false })
    const admin = as('admin')
    expect((await admin.call('POST', `/api/jobs/${theirs.id}/cancel`)).json().job.state).toBe('cancelled')
    const rows = ctx.audit.list({ action: 'jobs.cancel', limit: 10 })
    expect(rows.map((r) => [r.outcome, r.connectionId])).toEqual([
      ['success', connectionId],
      ['success', connectionId],
      ['denied', connectionId],
      ['denied', connectionId],
    ])
    expect(rows[0]!.details).toMatchObject({ kind: 'index.create', db: 'shop', coll: 'orders' })
  })

  it('answers 202 while a stopped job winds down, and 409 when it could not be stopped (final review I3)', async () => {
    const { as, start } = await setup()
    const owner = as('editor')
    const slow = hangingKind('collection.duplicate')
    // Told to stop, but its run has not ended yet.
    slow.run = () => new Promise<void>((resolve) => (slow.finish = resolve))
    const winding = start(slow, owner.id)
    const res = await owner.call('POST', `/api/jobs/${winding.id}/cancel`)
    expect([res.statusCode, res.json().job.state]).toEqual([202, 'running'])
    slow.finish()
    const stubborn = hangingKind('index.create')
    stubborn.cancel = async () => false
    const job = start(stubborn, owner.id)
    const refused = await owner.call('POST', `/api/jobs/${job.id}/cancel`)
    expect([refused.statusCode, refused.json().message, refused.json().details]).toEqual([
      409,
      'The job could not be stopped; it is still running',
      { reason: 'not_stopped' },
    ])
    stubborn.finish()
  })

  it('answers 409 for a finished job and READ_ONLY in read-only mode', async () => {
    const { as, start } = await setup({ readOnly: true })
    const kind = hangingKind('collection.duplicate')
    const owner = as('editor')
    const job = start(kind, owner.id)
    const res = await owner.call('POST', `/api/jobs/${job.id}/cancel`)
    expect([res.statusCode, res.json().code]).toEqual([403, 'READ_ONLY'])
    kind.finish()
    await new Promise((r) => setImmediate(r))
    const late = await owner.call('POST', `/api/jobs/${job.id}/cancel`)
    expect([late.statusCode, late.json().message]).toEqual([409, 'The job has already finished'])
  })

  it('filters by state and connection, and refuses malformed input', async () => {
    const { as, start, connectionId } = await setup()
    const kind = hangingKind('index.create')
    const owner = as('editor')
    const running = start(kind, owner.id)
    const get = async (q: string) => (await owner.call('GET', `/api/jobs${q}`)).json().jobs as JobView[]
    expect(ids(await get('?state=running'))).toEqual([running.id])
    expect(await get('?state=done')).toEqual([])
    expect(ids(await get(`?connectionId=${connectionId}`))).toEqual([running.id])
    expect((await owner.call('GET', '/api/jobs?state=nonsense')).statusCode).toBe(400)
    expect((await owner.call('GET', '/api/jobs/not-a-uuid')).statusCode).toBe(400)
    kind.finish()
  })
})
