// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it } from 'vitest'
import { ConnectionSettingsSchema } from '@mongo-manager/shared'
import { H, makeApp, type TestApp } from './helpers'
import { effectiveRole, mayUseShell, requireConnection } from '../src/connections/access'

const apps: TestApp[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})

async function setup(overrides = {}) {
  const t = await makeApp({ auth: true, ...overrides })
  apps.push(t)
  t.app.get('/t/conn/:id', { preHandler: requireConnection('documents:read') }, async (req) => ({
    name: req.connection!.name,
    role: req.connectionRole,
  }))
  t.app.post('/t/conn/:id/write', { preHandler: requireConnection('documents:write') }, async () => ({
    ok: true,
  }))
  const conn = t.app.ctx.connections.create(
    {
      name: 'Prod',
      favorite: false,
      readOnly: false,
      settings: ConnectionSettingsSchema.parse({ hosts: [{ host: 'h' }] }),
    },
    null,
  )
  const as = (role: 'admin' | 'editor' | 'viewer') => {
    const user = t.app.ctx.users.create({
      username: `u-${role}-${Math.random().toString(36).slice(2, 8)}`,
      passwordHash: 'x',
      role,
    })
    const { sessionId, session } = t.app.ctx.sessions.create(user.id, {})
    const opts = { headers: { ...H, 'x-csrf-token': session.csrfToken }, cookies: { mm_sid: sessionId } }
    return {
      user,
      get: () => t.app.inject({ method: 'GET', url: `/t/conn/${conn.id}`, ...opts }),
      write: () => t.app.inject({ method: 'POST', url: `/t/conn/${conn.id}/write`, ...opts }),
    }
  }
  return { t, conn, as }
}

describe('effective role', () => {
  it('uses the global role, overridden by a grant; none hides the connection; admins are always admin', async () => {
    const { t, conn, as } = await setup()
    const editor = as('editor')
    const admin = as('admin')
    const p = (u: { user: { id: string; username: string; role: 'admin' | 'editor' | 'viewer' } }) => ({
      kind: 'user' as const,
      userId: u.user.id,
      username: u.user.username,
      role: u.user.role,
      csrfToken: '',
      sessionId: '',
      sessionIdHash: '',
    })
    expect(effectiveRole(t.app.ctx, p(editor), conn.id)).toBe('editor')
    t.app.ctx.grants.set(conn.id, editor.user.id, 'viewer')
    expect(effectiveRole(t.app.ctx, p(editor), conn.id)).toBe('viewer')
    t.app.ctx.grants.set(conn.id, editor.user.id, 'none')
    expect(effectiveRole(t.app.ctx, p(editor), conn.id)).toBeNull()
    t.app.ctx.grants.set(conn.id, admin.user.id, 'none')
    expect(effectiveRole(t.app.ctx, p(admin), conn.id)).toBe('admin')
    t.app.ctx.grants.set(conn.id, editor.user.id, null)
    expect(t.app.ctx.grants.list(conn.id)).toEqual([
      { userId: admin.user.id, role: 'none', shell: false, masked: false, export: false },
    ])
  })
})

describe('requireConnection', () => {
  it('lets a granted user in and records the effective role', async () => {
    const { t, conn, as } = await setup()
    const viewer = as('viewer')
    t.app.ctx.grants.set(conn.id, viewer.user.id, 'editor')
    expect((await viewer.get()).json()).toEqual({ name: 'Prod', role: 'editor' })
    expect((await viewer.write()).statusCode).toBe(200)
  })

  it('answers 404 for hidden and unknown connections (no enumeration)', async () => {
    const { t, conn, as } = await setup()
    const editor = as('editor')
    t.app.ctx.grants.set(conn.id, editor.user.id, 'none')
    expect((await editor.get()).statusCode).toBe(404)
    const res = await t.app.inject({
      method: 'GET',
      url: '/t/conn/00000000-0000-4000-8000-000000000000',
      headers: H,
    })
    expect([401, 404]).toContain(res.statusCode)
  })

  it('enforces viewer limits and per-connection read-only', async () => {
    const { t, conn, as } = await setup()
    const viewer = as('viewer')
    expect((await viewer.write()).json().code).toBe('FORBIDDEN')
    const admin = as('admin')
    t.app.ctx.connections.update(conn.id, { readOnly: true })
    expect((await admin.write()).json().code).toBe('READ_ONLY')
    expect((await admin.get()).statusCode).toBe(200)
  })

  it('treats the local owner as admin', async () => {
    const t = await makeApp()
    apps.push(t)
    t.app.get('/t/conn/:id', { preHandler: requireConnection('documents:read') }, async (req) => ({
      role: req.connectionRole,
    }))
    const conn = t.app.ctx.connections.create(
      {
        name: 'Local',
        favorite: false,
        readOnly: false,
        settings: ConnectionSettingsSchema.parse({ hosts: [{ host: 'h' }] }),
      },
      null,
    )
    expect((await t.app.inject({ method: 'GET', url: `/t/conn/${conn.id}`, headers: H })).json()).toEqual({
      role: 'admin',
    })
  })
})

describe('mayUseShell (phase 3a-1 §9)', () => {
  const p = (u: { user: { id: string; username: string; role: 'admin' | 'editor' | 'viewer' } }) => ({
    kind: 'user' as const,
    userId: u.user.id,
    username: u.user.username,
    role: u.user.role,
    csrfToken: '',
    sessionId: '',
    sessionIdHash: '',
  })

  it('admins may, editors only with the grant, viewers never, and no one when disabled', async () => {
    const { t, conn, as } = await setup()
    const admin = as('admin')
    const editor = as('editor')
    const viewer = as('viewer')
    t.app.ctx.grants.set(conn.id, viewer.user.id, 'viewer')
    expect(mayUseShell(t.app.ctx, p(admin), conn.id)).toBe(true)
    expect(mayUseShell(t.app.ctx, p(viewer), conn.id)).toBe(false)
    // An editor without the shell grant is refused; with it, allowed.
    t.app.ctx.grants.set(conn.id, editor.user.id, 'editor')
    expect(mayUseShell(t.app.ctx, p(editor), conn.id)).toBe(false)
    t.app.ctx.grants.setShell(conn.id, editor.user.id, true)
    expect(mayUseShell(t.app.ctx, p(editor), conn.id)).toBe(true)
    // Disabling the shell refuses everyone.
    t.app.ctx.config.shell.enabled = false
    expect(mayUseShell(t.app.ctx, p(admin), conn.id)).toBe(false)
  })
})
