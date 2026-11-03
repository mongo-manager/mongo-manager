import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { defaultDashboard, type Dashboard } from '@mongo-manager/shared'
import { startMongo, type TestMongo } from './support/mongo'
import { dataHarness, teamHarness } from './support/data'
import { H } from './helpers'

let mongo: TestMongo
beforeAll(async () => {
  mongo = await startMongo()
})
afterAll(async () => {
  await mongo?.stop()
})
const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c()
})

type Method = 'GET' | 'PUT' | 'DELETE'
const layout = (): Dashboard => defaultDashboard(randomUUID)

async function local() {
  const h = await dataHarness(mongo)
  closers.push(h.t.close)
  const api = (method: Method, payload?: unknown) =>
    h.t.app.inject({
      method,
      url: '/api/me/dashboard',
      headers: h.headers,
      ...(payload !== undefined ? { payload: payload as object } : {}),
    })
  return { h, api }
}

async function team() {
  const h = await teamHarness(mongo)
  closers.push(h.t.close)
  const { ctx } = h.t.app
  const as = (role: 'admin' | 'editor' | 'viewer') => {
    const user = ctx.users.create({
      username: `u-${role}-${randomUUID().slice(0, 6)}`,
      passwordHash: 'x',
      role,
    })
    const { sessionId, session } = ctx.sessions.create(user.id, {})
    const call = (method: Method, url: string, payload?: unknown) =>
      h.t.app.inject({
        method,
        url: `/api/${url}`,
        headers: { ...H, 'x-csrf-token': session.csrfToken },
        cookies: { mm_sid: sessionId },
        ...(payload !== undefined ? { payload: payload as object } : {}),
      })
    return { id: user.id, call }
  }
  return { h, as }
}

describe('each user’s Overview dashboard (user review 2026-10-09)', () => {
  it('has none saved at first, then keeps what is saved, and forgets it on reset', async () => {
    const { api } = await local()
    expect((await api('GET')).json()).toEqual({ dashboard: null })
    const mine = layout()
    const saved = await api('PUT', mine)
    expect(saved.statusCode).toBe(200)
    expect((await api('GET')).json()).toEqual({ dashboard: mine })
    expect((await api('DELETE')).statusCode).toBe(204)
    expect((await api('GET')).json()).toEqual({ dashboard: null })
  })

  it('refuses a layout that is not one', async () => {
    const { api } = await local()
    const widget = (over: object) => ({ id: randomUUID(), type: 'quick', size: 'm', settings: {}, ...over })
    const bad = [
      {
        version: 1,
        widgets: Array.from({ length: 31 }, () =>
          widget({ type: 'serverStatus', settings: { connectionId: randomUUID() } }),
        ),
      },
      // User report 2026-10-27: the same widget twice.
      { version: 1, widgets: [widget({}), widget({})] },
      { version: 1, widgets: [widget({ type: 'shell' })] },
      { version: 1, widgets: [widget({ settings: { x: 1 } })] },
      { version: 1, widgets: [widget({ type: 'serverStatus', settings: { connectionId: 'nope' } })] },
      { version: 1, widgets: [widget({ size: 'huge' })] },
      { version: 1, widgets: [widget({ col: 13 })] },
      { version: 1, widgets: [widget({ col: 0 })] },
      { version: 1, widgets: [widget({ col: 2.5 })] },
      { version: 2, widgets: [] },
    ]

    for (const body of bad) expect((await api('PUT', body)).statusCode).toBe(400)
    // Not JSON at all: refused before it is read.
    expect([400, 415]).toContain((await api('PUT', 'text')).statusCode)
    expect((await api('GET')).json()).toEqual({ dashboard: null })
  })

  it('keeps where a widget starts on the wide grid', async () => {
    const { api } = await local()
    const placed = {
      version: 1,
      widgets: [{ id: randomUUID(), type: 'quick', size: 'm', settings: {}, col: 7 }],
    }
    expect((await api('PUT', placed)).json()).toEqual({ dashboard: placed })
    expect((await api('GET')).json()).toEqual({ dashboard: placed })
  })

  it('refuses a body too large to be a layout', async () => {
    const { api } = await local()
    const res = await api('PUT', { version: 1, widgets: [], padding: 'x'.repeat(40 * 1024) })
    expect([400, 413]).toContain(res.statusCode)
  })

  it('keeps what still reads of a stored layout (a widget of another version is left out)', async () => {
    const { h, api } = await local()
    const mine = layout()
    h.t.app.ctx.preferences.set('local', 'dashboard', {
      version: 1,
      widgets: [{ id: randomUUID(), type: 'fromTheFuture', size: 'm', settings: {} }, ...mine.widgets],
    })
    expect((await api('GET')).json()).toEqual({ dashboard: mine })
  })
})

describe('each user’s Overview dashboard, abuse cases', () => {
  it('is never another user’s: never read, never written', async () => {
    const { as } = await team()
    const ada = as('editor')
    const bob = as('viewer')
    const adas = layout()
    expect((await ada.call('PUT', 'me/dashboard', adas)).statusCode).toBe(200)
    expect((await bob.call('GET', 'me/dashboard')).json()).toEqual({ dashboard: null })
    const bobs = layout()
    expect((await bob.call('PUT', 'me/dashboard', bobs)).statusCode).toBe(200)
    expect((await ada.call('GET', 'me/dashboard')).json()).toEqual({ dashboard: adas })
    expect((await bob.call('DELETE', 'me/dashboard')).statusCode).toBe(204)
    expect((await ada.call('GET', 'me/dashboard')).json()).toEqual({ dashboard: adas })
  })

  it('asks to sign in', async () => {
    const { h } = await team()
    for (const method of ['GET', 'PUT', 'DELETE'] as const)
      expect(
        (await h.t.app.inject({ method, url: '/api/me/dashboard', headers: H, payload: layout() }))
          .statusCode,
      ).toBe(401)
  })

  it('goes with the user', async () => {
    const { h, as } = await team()
    const admin = as('admin')
    const ada = as('editor')
    expect((await ada.call('PUT', 'me/dashboard', layout())).statusCode).toBe(200)
    expect((await admin.call('DELETE', `users/${ada.id}`)).statusCode).toBe(204)
    const left = h.t.app.ctx.store.db
      .prepare('SELECT COUNT(*) AS n FROM user_preferences WHERE owner = ?')
      .get(ada.id) as { n: number }
    expect(left.n).toBe(0)
  })

  it('never overwrites a layout a newer version saved, and says it is there (final review 13)', async () => {
    const { api, h } = await local()
    const { ctx } = h.t.app
    const newer = { version: 2, widgets: [{ id: randomUUID(), kind: 'future' }] }
    ctx.preferences.set('local', 'dashboard', newer)
    expect((await api('GET')).json()).toEqual({ dashboard: null, newer: true })
    const mine = { version: 1, widgets: [] }
    expect((await api('PUT', mine)).statusCode).toBe(409)
    expect(ctx.preferences.get('local', 'dashboard')).toEqual(newer)
  })

  it('refuses a change without the CSRF token or from another origin (final review 14)', async () => {
    const { h } = await local()
    const raw = (method: 'PUT' | 'DELETE', o: { csrf?: boolean; origin?: string; payload?: object }) => {
      const headers: Record<string, string> = { ...h.headers }
      if (o.csrf === false) delete headers['x-csrf-token']
      if (o.origin) headers.origin = o.origin
      return h.t.app.inject({
        method,
        url: '/api/me/dashboard',
        headers,
        ...(o.payload ? { payload: o.payload } : {}),
      })
    }
    const body = { version: 1, widgets: [] }
    for (const [method, payload] of [
      ['PUT', body],
      ['DELETE', undefined],
    ] as const) {
      expect((await raw(method, { csrf: false, payload })).statusCode).toBe(403)
      expect((await raw(method, { origin: 'https://evil.example', payload })).statusCode).toBe(403)
    }
  })
})
