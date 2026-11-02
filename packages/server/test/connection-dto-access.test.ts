import { afterEach, describe, expect, it } from 'vitest'
import { ConnectionSettingsSchema } from '@mongo-manager/shared'
import { H, makeApp, type TestApp } from './helpers'

const apps: TestApp[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})

describe('connection DTO access (Review Focus 5)', () => {
  it('reports the caller’s effective role and permissions per connection', async () => {
    const t = await makeApp({ auth: true })
    apps.push(t)
    const settings = ConnectionSettingsSchema.parse({ hosts: [{ host: 'h' }] })
    const create = (name: string, readOnly = false) =>
      t.app.ctx.connections.create({ name, favorite: false, readOnly, settings }, null)
    const rw = create('RW')
    create('RO', true)
    const viewed = create('Viewed')
    const hidden = create('Hidden')
    const user = t.app.ctx.users.create({ username: 'ed', passwordHash: 'x', role: 'editor' })
    t.app.ctx.grants.set(hidden.id, user.id, 'none')
    t.app.ctx.grants.set(viewed.id, user.id, 'viewer')
    const { sessionId } = t.app.ctx.sessions.create(user.id, {})
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/connections',
      headers: H,
      cookies: { mm_sid: sessionId },
    })
    const list = res.json() as Array<{ id: string; name: string; access: string; permissions: string[] }>
    const byName = Object.fromEntries(list.map((c) => [c.name, c]))
    expect(Object.keys(byName).sort()).toEqual(['RO', 'RW', 'Viewed'])
    expect(byName.RW!.access).toBe('editor')
    expect(byName.RW!.permissions).toContain('databases:write')
    expect(byName.RO!.access).toBe('editor')
    expect(byName.RO!.permissions).toContain('documents:read')
    expect(byName.RO!.permissions).not.toContain('documents:write')
    expect(byName.Viewed!.access).toBe('viewer')
    expect(byName.Viewed!.permissions).not.toContain('databases:write')
    const one = await t.app.inject({
      method: 'GET',
      url: `/api/connections/${rw.id}`,
      headers: H,
      cookies: { mm_sid: sessionId },
    })
    expect(one.json()).toMatchObject({ access: 'editor' })
  })
})

describe('masked secrets (review 1e-2)', () => {
  it('refuses masks anywhere on create, including mechanism properties, and names the reason', async () => {
    const t = await makeApp({ auth: false })
    apps.push(t)
    const headers = { ...H, origin: 'http://localhost:4321' }
    const me = await t.app.inject({ method: 'GET', url: '/api/auth/me', headers })
    const csrf = { ...headers, 'x-csrf-token': me.json().csrfToken as string }
    const settings = {
      hosts: [{ host: 'h' }],
      auth: {
        mechanism: 'MONGODB-AWS',
        username: 'AKIA',
        password: 'secret',
        mechanismProperties: 'AWS_SESSION_TOKEN:••••••••',
      },
    }
    const create = await t.app.inject({
      method: 'POST',
      url: '/api/connections',
      headers: csrf,
      payload: { name: 'Dup', settings },
    })
    expect(create.statusCode).toBe(400)
    expect(create.json().details).toEqual({ reason: 'masked_secret_on_create' })

    const test = await t.app.inject({
      method: 'POST',
      url: '/api/connections/test',
      headers: csrf,
      payload: {
        settings: {
          hosts: [{ host: 'h' }],
          auth: { mechanism: 'DEFAULT', username: 'u', password: '••••••••' },
        },
      },
    })
    expect(test.statusCode).toBe(400)
    expect(test.json().details).toEqual({ reason: 'masked_secret_reuse' })
  })
})
