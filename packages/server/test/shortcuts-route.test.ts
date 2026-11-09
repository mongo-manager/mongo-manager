// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { H, makeApp, type TestApp } from './helpers'

/**
 * W5 (completion §2 W5.3): each user's own keyboard shortcuts, kept on the server as the Overview
 * is. Only the global shortcuts rebind, checked as the settings page checks them; nobody reads or
 * writes another's.
 */
const apps: TestApp[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})
type Method = 'GET' | 'PUT' | 'DELETE'

async function local() {
  const t = await makeApp()
  apps.push(t)
  const headers = { ...H, 'x-csrf-token': t.app.ctx.localCsrfToken }
  const api = (method: Method, payload?: unknown) =>
    t.app.inject({
      method,
      url: '/api/me/shortcuts',
      headers,
      ...(payload !== undefined ? { payload: payload as object } : {}),
    })
  return { t, api, headers }
}

async function team() {
  const t = await makeApp({ auth: true })
  apps.push(t)
  const { ctx } = t.app
  const as = (role: 'admin' | 'editor' | 'viewer') => {
    const user = ctx.users.create({ username: `u-${randomUUID().slice(0, 8)}`, passwordHash: 'x', role })
    const { sessionId, session } = ctx.sessions.create(user.id, {})
    const call = (method: Method, payload?: unknown) =>
      t.app.inject({
        method,
        url: '/api/me/shortcuts',
        headers: { ...H, 'x-csrf-token': session.csrfToken },
        cookies: { mm_sid: sessionId },
        ...(payload !== undefined ? { payload: payload as object } : {}),
      })
    return { id: user.id, call }
  }
  return { t, as }
}

const mine = {
  bindings: {
    palette: [['Mod', 'Shift', 'K']],
    tabReorder: [
      ['Alt', '←'],
      ['Alt', '→'],
    ],
  },
}

describe('each user’s keyboard shortcuts (W5)', () => {
  it('starts with none of their own, keeps what they bind, and resets', async () => {
    const { api } = await local()
    expect((await api('GET')).json()).toEqual({ bindings: {} })
    // Alt+← is the browser's Back: refused, and nothing is kept.
    expect((await api('PUT', mine)).statusCode).toBe(400)
    const ok = {
      bindings: {
        palette: [['Mod', 'Shift', 'K']],
        tabReorder: [
          ['Alt', 'Shift', '←'],
          ['Alt', 'Shift', '→'],
        ],
      },
    }
    const put = await api('PUT', ok)
    expect(put.statusCode).toBe(200)
    expect(put.json()).toEqual(ok)
    expect((await api('GET')).json()).toEqual(ok)
    expect((await api('DELETE')).statusCode).toBe(204)
    expect((await api('GET')).json()).toEqual({ bindings: {} })
  })

  it('refuses conflicts, unknown actions, fixed shortcuts, odd keys and large bodies (abuse cases)', async () => {
    const { t, api, headers } = await local()
    for (const bindings of [
      { palette: [['Mod', 'Shift', 'F']] },
      { shellCancel: [['Mod', 'Shift', 'K']] },
      { palette: [['Mod', '<img src=x>']] },
      { palette: [['Mod', 'C']] },
      { palette: [['K']] },
    ]) {
      const res = await api('PUT', { bindings })
      expect(res.statusCode, JSON.stringify(bindings)).toBe(400)
    }
    // A prototype key in the JSON itself.
    const proto = await t.app.inject({
      method: 'PUT',
      url: '/api/me/shortcuts',
      headers: { ...headers, 'content-type': 'application/json' },
      payload: '{"bindings":{"__proto__":{"palette":[["Mod","Shift","K"]]}}}',
    })
    expect(proto.statusCode).toBe(400)
    const big = await api('PUT', { bindings: {}, padding: 'x'.repeat(16 * 1024) })
    // Refused before it is read: a binding list is far smaller.
    expect(big.statusCode).toBe(413)
    expect((await api('GET')).json()).toEqual({ bindings: {} })
  })

  it('reads what is kept leniently: a stored binding this version cannot use is left out', async () => {
    const { t, api } = await local()
    t.app.ctx.preferences.set('local', 'shortcuts', {
      bindings: { palette: [['Mod', 'Shift', 'K']], gone: [['Mod', 'J']], library: [['Mod', 'C']] },
    })
    // W5 re-review: what was left out is said (its names only; an unknown one is no action of this version).
    expect((await api('GET')).json()).toEqual({
      bindings: { palette: [['Mod', 'Shift', 'K']] },
      dropped: ['library'],
    })
  })

  // Review I1: bindings that only fit together (a swap, a chain) are read back whole.
  it('keeps a swap and a chain of bindings across a reload', async () => {
    const { api } = await local()
    const swapped = {
      bindings: {
        navigator: [['Mod', 'Shift', 'F']],
        focusMode: [['Mod', 'B']],
        library: [['Mod', 'Shift', 'B']],
        pinPlace: [['Mod', 'Shift', 'L']],
      },
    }
    expect((await api('PUT', swapped)).statusCode).toBe(200)
    expect((await api('GET')).json()).toEqual(swapped)
  })

  it('leaves out only the bindings a stored set names as wrong, then reads the rest again', async () => {
    const { t, api } = await local()
    t.app.ctx.preferences.set('local', 'shortcuts', {
      bindings: {
        navigator: [['Mod', 'Shift', 'F']],
        focusMode: [['Mod', 'B']],
        library: [['Mod', 'C']],
        // Library's shipped keys: once library's own binding goes, it has them again, so this goes too.
        pinPlace: [['Mod', 'Shift', 'L']],
      },
    })
    expect((await api('GET')).json()).toEqual({
      bindings: { navigator: [['Mod', 'Shift', 'F']], focusMode: [['Mod', 'B']] },
      dropped: ['library', 'pinPlace'],
    })
  })

  it('is never another user’s, and asks to sign in', async () => {
    const { t, as } = await team()
    const ada = as('editor')
    const bob = as('viewer')
    const adas = { bindings: { palette: [['Mod', 'Shift', 'K']] } }
    expect((await ada.call('PUT', adas)).statusCode).toBe(200)
    expect((await bob.call('GET')).json()).toEqual({ bindings: {} })
    expect((await bob.call('DELETE')).statusCode).toBe(204)
    expect((await ada.call('GET')).json()).toEqual(adas)
    for (const method of ['GET', 'PUT', 'DELETE'] as const)
      expect(
        (await t.app.inject({ method, url: '/api/me/shortcuts', headers: H, payload: adas })).statusCode,
      ).toBe(401)
  })
})
