import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { LightMyRequestResponse } from 'fastify'
import { SECRET_MASK } from '@mongo-manager/shared'
import { ADMIN_PASSWORD, H, givePassword, makeApp, type TestApp } from './helpers'
import { startMongo, type TestMongo } from './support/mongo'

// An Atlas connection string as Atlas shows it, with an invented user and password; built from parts
// so secret scanning does not take it for a real credential.
const ATLAS_URI = [
  'mongodb+srv://user',
  'p%40ss@cluster0.x.mongodb.net/db?retryWrites=true&w=majority&appName=Cluster0',
].join(':')

let secured: TestMongo
beforeAll(async () => {
  secured = await startMongo({ auth: { user: 'root', password: 'root-pass' } })
})
afterAll(async () => {
  await secured?.stop()
})

const apps: TestApp[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})

const PASSWORD = 'tarçın-kavanoz-42-mavi'
const sid = (res: LightMyRequestResponse) => res.cookies.find((c) => c.name === 'mm_sid')?.value

async function local() {
  const t = await makeApp()
  apps.push(t)
  const csrf = t.app.ctx.localCsrfToken
  const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object) =>
    t.app.inject({ method, url, headers: { ...H, 'x-csrf-token': csrf }, ...(payload ? { payload } : {}) })
  return { t, call }
}

const securedInput = (name = 'Secured') => ({
  name,
  settings: {
    hosts: [{ host: '127.0.0.1', port: secured.port }],
    serverSelectionTimeoutMS: 3_000,
    auth: { mechanism: 'DEFAULT', username: 'root', password: 'root-pass', authSource: 'admin' },
  },
})

describe('connection CRUD with masking', () => {
  it('creates and lists without ever returning the password', async () => {
    const { call } = await local()
    const created = await call('POST', '/api/connections', securedInput())
    expect(created.statusCode).toBe(200)
    expect(created.json().settings.auth.password).toBe(SECRET_MASK)
    expect(created.body).not.toContain('root-pass')
    const list = await call('GET', '/api/connections')
    expect(list.json()).toHaveLength(1)
    expect(list.body).not.toContain('root-pass')
    expect(
      (
        await call('POST', '/api/connections', {
          ...securedInput(),
          settings: {
            ...securedInput().settings,
            auth: { ...securedInput().settings.auth, password: SECRET_MASK },
          },
        })
      ).statusCode,
    ).toBe(400)
  })

  it('keeps stored secrets when a masked DTO comes back unchanged (Review Focus 2)', async () => {
    const { call } = await local()
    const dto = (await call('POST', '/api/connections', securedInput())).json()
    const patched = await call('PATCH', `/api/connections/${dto.id}`, {
      name: 'Renamed',
      settings: dto.settings,
    })
    expect(patched.json().name).toBe('Renamed')
    expect((await call('POST', `/api/connections/${dto.id}/test`)).json()).toMatchObject({ ok: true })
  })

  it('uses fresh settings after an edit and 404s after delete (Review Focus 3)', async () => {
    const { t, call } = await local()
    const dto = (await call('POST', '/api/connections', securedInput())).json()
    const client = await t.app.ctx.manager.getClient(dto.id)
    await call('PATCH', `/api/connections/${dto.id}`, { settings: { ...dto.settings, appName: 'edited' } })
    expect(await t.app.ctx.manager.getClient(dto.id)).not.toBe(client)
    expect((await call('DELETE', `/api/connections/${dto.id}`)).statusCode).toBe(204)
    expect((await call('GET', `/api/connections/${dto.id}`)).statusCode).toBe(404)
    await expect(t.app.ctx.manager.getClient(dto.id)).rejects.toThrow(/not found/)
  })
})

describe('parse and test', () => {
  it('parses a pasted Atlas URI without echoing the password (Review Focus 1)', async () => {
    const { call } = await local()
    const res = await call('POST', '/api/connections/parse-uri', {
      uri: ATLAS_URI,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().settings).toMatchObject({
      scheme: 'mongodb+srv',
      auth: { username: 'user', password: SECRET_MASK },
    })
    expect(res.body).not.toContain('p@ss')
    const bad = await call('POST', '/api/connections/parse-uri', {
      uri: 'mongodb://h/?tlsCAFile=/etc/passwd',
    })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().message).toMatch(/File-based TLS options/)
  })

  it('refuses timeoutMS with its reason, so the app can say it in its language', async () => {
    const { call } = await local()
    const res = await call('POST', '/api/connections/parse-uri', { uri: 'mongodb://h/?timeoutMS=5000' })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: expect.stringMatching(/^timeoutMS is not supported/),
      details: { reason: 'option_not_supported', option: 'timeoutMS' },
    })
  })

  it('tests unsaved settings, and unsaved edits of a saved connection with masked secrets', async () => {
    const { call } = await local()
    expect(
      (await call('POST', '/api/connections/test', { settings: securedInput().settings })).json(),
    ).toMatchObject({ ok: true })
    const wrong = await call('POST', '/api/connections/test', {
      settings: { ...securedInput().settings, auth: { ...securedInput().settings.auth, password: 'nope' } },
    })
    expect(wrong.json()).toMatchObject({ ok: false, error: { kind: 'auth' } })
    const dto = (await call('POST', '/api/connections', securedInput())).json()
    const masked = await call('POST', '/api/connections/test', {
      settings: { ...dto.settings, appName: 'x' },
      connectionId: dto.id,
    })
    expect(masked.json()).toMatchObject({ ok: true })
  })
})

describe('a pasted connection string that cannot sign in yet (review minor 3)', () => {
  it('fills the form, and the save says what is missing', async () => {
    const { call } = await local()
    const aws = await call('POST', '/api/connections/parse-uri', {
      uri: 'mongodb+srv://c.example.net/?authSource=%24external&authMechanism=MONGODB-AWS',
    })
    expect(aws.statusCode).toBe(200)
    expect(aws.json().settings).toMatchObject({
      hosts: [{ host: 'c.example.net' }],
      auth: { mechanism: 'MONGODB-AWS' },
    })
    const kerberos = await call('POST', '/api/connections/parse-uri', {
      uri: 'mongodb://u%40REALM@db.example/?authMechanism=GSSAPI',
    })
    expect(kerberos.json().settings.auth.mechanism).toBe('GSSAPI')
    const saved = await call('POST', '/api/connections', { name: 'A', settings: aws.json().settings })
    expect(saved.statusCode).toBe(400)
    expect(saved.body).toContain('Access key ID is required')
  })

  // An import is all or nothing; a refused method is named, with the entry it is in.
  // W8: Kerberos is the server's policy now (the kerberos package; team mode's switch).
  it('names the refused Kerberos entry of an import', async () => {
    const t = await makeApp(
      {},
      {
        optionalModules: {
          distribution: 'npm',
          clientEncryption: { status: 'missing', version: null },
          kerberos: { status: 'missing', version: null },
        },
      },
    )
    apps.push(t)
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/connections/import',
      headers: { ...H, 'x-csrf-token': t.app.ctx.localCsrfToken },
      payload: {
        format: 'mongo-manager-connections',
        version: 1,
        connections: [
          { name: 'A', settings: { hosts: [{ host: 'h' }] } },
          { name: 'K', settings: { hosts: [{ host: 'h' }], auth: { mechanism: 'GSSAPI', username: 'u' } } },
        ],
      },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().details).toMatchObject({
      reason: 'kerberos_unavailable',
      field: 'connections.1.settings.auth.mechanism',
    })
    expect(res.body).toContain('K: Kerberos (GSSAPI) needs the optional package kerberos')
    expect(t.app.ctx.connections.count()).toBe(0)
  })
})

describe('export and import', () => {
  it('exports masked by default and re-imports without secrets', async () => {
    const { call } = await local()
    await call('POST', '/api/connections', securedInput('One'))
    const exported = (await call('POST', '/api/connections/export', { includeSecrets: false })).json()
    expect(exported).toMatchObject({ format: 'mongo-manager-connections', version: 1 })
    expect(JSON.stringify(exported)).not.toContain('root-pass')
    expect((await call('POST', '/api/connections/import', exported)).json()).toEqual({ created: 1 })
    const all = (await call('GET', '/api/connections')).json()
    expect(all).toHaveLength(2)
  })

  it('imports a file that still holds timeoutMS without it, and says how many held it', async () => {
    const { call } = await local()
    const res = await call('POST', '/api/connections/import', {
      format: 'mongo-manager-connections',
      version: 1,
      connections: [
        { name: 'A', settings: { hosts: [{ host: 'h' }], options: { timeoutMS: '5000', maxPoolSize: '5' } } },
        { name: 'B', settings: { hosts: [{ host: 'h' }] } },
      ],
    })
    expect(res.json()).toEqual({ created: 2, refusedOptionsDropped: 1 })
    const a = (
      (await call('GET', '/api/connections')).json() as Array<{ name: string; settings: { options: object } }>
    ).find((c) => c.name === 'A')
    expect(a?.settings.options).toEqual({ maxPoolSize: '5' })
  })

  it('refuses timeoutMS in a connection it is given to save', async () => {
    const { call } = await local()
    const res = await call('POST', '/api/connections', {
      ...securedInput('T'),
      settings: { ...securedInput('T').settings, options: { timeoutMS: '5000' } },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().details).toContainEqual(
      expect.objectContaining({
        path: 'settings.options.timeoutMS',
        message: 'timeoutMS is not supported: the app bounds each operation itself',
      }),
    )
  })

  it('includes secrets only on explicit request (with the password in team mode)', async () => {
    const t = await makeApp({ auth: true })
    apps.push(t)
    const token = t.app.ctx.setup.ensureToken()
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      headers: H,
      payload: { token, username: 'admin', password: PASSWORD },
    })
    const opts = { headers: { ...H, 'x-csrf-token': res.json().csrfToken }, cookies: { mm_sid: sid(res)! } }
    await t.app.inject({ method: 'POST', url: '/api/connections', ...opts, payload: securedInput() })
    const denied = await t.app.inject({
      method: 'POST',
      url: '/api/connections/export',
      ...opts,
      payload: { includeSecrets: true },
    })
    expect(denied.statusCode).toBe(400)
    const full = await t.app.inject({
      method: 'POST',
      url: '/api/connections/export',
      ...opts,
      payload: { includeSecrets: true, password: PASSWORD },
    })
    expect(full.body).toContain('root-pass')
  })
})

describe('mutations close open shells (phase 3a-1 §6, Review Focus 5)', () => {
  it('closes shells when a connection is edited or deleted, a grant changes, or the user is deleted', async () => {
    const t = await makeApp({ auth: true })
    apps.push(t)
    const calls: Array<{ match: { connectionId?: string; userId?: string | null }; reason: string }> = []
    ;(t.app.ctx.shell as unknown as { closeFor: unknown }).closeFor = async (
      match: { connectionId?: string; userId?: string | null },
      reason: string,
    ) => {
      calls.push({ match, reason })
    }
    const admin = t.app.ctx.users.create({ username: 'admin', passwordHash: 'x', role: 'admin' })
    const editor = t.app.ctx.users.create({ username: 'ed', passwordHash: 'x', role: 'editor' })
    const session = (id: string) => {
      const s = t.app.ctx.sessions.create(id, {})
      return { headers: { ...H, 'x-csrf-token': s.session.csrfToken }, cookies: { mm_sid: s.sessionId } }
    }
    const asAdmin = session(admin.id)
    const a = (
      await t.app.inject({ method: 'POST', url: '/api/connections', ...asAdmin, payload: securedInput('A') })
    ).json()

    await t.app.inject({
      method: 'PATCH',
      url: `/api/connections/${a.id}`,
      ...asAdmin,
      // An edit of its settings (a new name alone changes nothing it was made of: manager-opening.test.ts).
      payload: { settings: { ...a.settings, appName: 'edited' } },
    })
    expect(calls).toContainEqual({ match: { connectionId: a.id }, reason: 'access' })

    calls.length = 0
    await t.app.inject({
      method: 'PUT',
      url: `/api/connections/${a.id}/grants/${editor.id}`,
      ...asAdmin,
      payload: { role: 'editor', shell: true },
    })
    expect(calls).toContainEqual({ match: { connectionId: a.id, userId: editor.id }, reason: 'access' })

    // Review 2026-10-12 (M8): a shell held open keeps the rules it was opened with, so a changed role
    // or a disabled account closes it at once; the same role again leaves it.
    calls.length = 0
    await givePassword(t.app.ctx, admin.id)
    const patch = (payload: object) =>
      t.app.inject({
        method: 'PATCH',
        url: `/api/users/${editor.id}`,
        ...asAdmin,
        payload: { ...payload, currentPassword: ADMIN_PASSWORD },
      })
    expect((await patch({ role: 'editor' })).statusCode).toBe(200)
    expect(calls).toEqual([])
    expect((await patch({ role: 'viewer' })).statusCode).toBe(200)
    expect(calls).toContainEqual({ match: { userId: editor.id }, reason: 'access' })
    calls.length = 0
    expect((await patch({ disabled: true })).statusCode).toBe(200)
    expect(calls).toContainEqual({ match: { userId: editor.id }, reason: 'access' })
    calls.length = 0
    expect((await patch({ disabled: false })).statusCode).toBe(200)
    expect(calls).toEqual([])

    calls.length = 0
    await t.app.inject({ method: 'DELETE', url: `/api/users/${editor.id}`, ...asAdmin })
    expect(calls).toContainEqual({ match: { userId: editor.id }, reason: 'access' })

    calls.length = 0
    await t.app.inject({ method: 'DELETE', url: `/api/connections/${a.id}`, ...asAdmin })
    expect(calls).toContainEqual({ match: { connectionId: a.id }, reason: 'access' })
  })
})

describe('team access', () => {
  it('filters the list by grants and lets only admins manage connections and grants', async () => {
    const t = await makeApp({ auth: true })
    apps.push(t)
    const admin = t.app.ctx.users.create({ username: 'admin', passwordHash: 'x', role: 'admin' })
    const editor = t.app.ctx.users.create({ username: 'ed', passwordHash: 'x', role: 'editor' })
    const session = (id: string) => {
      const s = t.app.ctx.sessions.create(id, {})
      return { headers: { ...H, 'x-csrf-token': s.session.csrfToken }, cookies: { mm_sid: s.sessionId } }
    }
    const asAdmin = session(admin.id)
    const asEditor = session(editor.id)
    const a = (
      await t.app.inject({ method: 'POST', url: '/api/connections', ...asAdmin, payload: securedInput('A') })
    ).json()
    await t.app.inject({ method: 'POST', url: '/api/connections', ...asAdmin, payload: securedInput('B') })
    expect(
      (
        await t.app.inject({
          method: 'POST',
          url: '/api/connections',
          ...asEditor,
          payload: securedInput('C'),
        })
      ).statusCode,
    ).toBe(403)
    expect((await t.app.inject({ method: 'GET', url: '/api/connections', ...asEditor })).json()).toHaveLength(
      2,
    )
    const grant = await t.app.inject({
      method: 'PUT',
      url: `/api/connections/${a.id}/grants/${editor.id}`,
      ...asAdmin,
      payload: { role: 'none' },
    })
    expect(grant.statusCode).toBe(204)
    expect(
      (await t.app.inject({ method: 'GET', url: '/api/connections', ...asEditor }))
        .json()
        .map((c: { name: string }) => c.name),
    ).toEqual(['B'])
    expect(
      (await t.app.inject({ method: 'GET', url: `/api/connections/${a.id}`, ...asEditor })).statusCode,
    ).toBe(404)
    expect(
      (await t.app.inject({ method: 'GET', url: `/api/connections/${a.id}/grants`, ...asAdmin })).json(),
    ).toEqual([{ userId: editor.id, role: 'none', shell: false, masked: false, export: false }])
    expect(
      (
        await t.app.inject({
          method: 'PUT',
          url: `/api/connections/${a.id}/grants/${editor.id}`,
          ...asEditor,
          payload: { role: 'admin' },
        })
      ).statusCode,
    ).toBe(404)
    expect(t.app.ctx.audit.list({ action: 'connections.grant' })).toHaveLength(2)
  })

  it('grants an editor the shell, so the DTO and the history route allow it (phase 3a-1)', async () => {
    const t = await makeApp({ auth: true })
    apps.push(t)
    const admin = t.app.ctx.users.create({ username: 'admin2', passwordHash: 'x', role: 'admin' })
    const editor = t.app.ctx.users.create({ username: 'sh', passwordHash: 'x', role: 'editor' })
    const session = (id: string) => {
      const s = t.app.ctx.sessions.create(id, {})
      return { headers: { ...H, 'x-csrf-token': s.session.csrfToken }, cookies: { mm_sid: s.sessionId } }
    }
    const asAdmin = session(admin.id)
    const asEditor = session(editor.id)
    const a = (
      await t.app.inject({ method: 'POST', url: '/api/connections', ...asAdmin, payload: securedInput('A') })
    ).json()
    // Editor granted editor: no shell yet.
    await t.app.inject({
      method: 'PUT',
      url: `/api/connections/${a.id}/grants/${editor.id}`,
      ...asAdmin,
      payload: { role: 'editor' },
    })
    const before = await t.app.inject({
      method: 'GET',
      url: `/api/connections/${a.id}/shell/history`,
      ...asEditor,
    })
    expect(before.statusCode).toBe(403)
    // Grant the shell.
    const grant = await t.app.inject({
      method: 'PUT',
      url: `/api/connections/${a.id}/grants/${editor.id}`,
      ...asAdmin,
      payload: { role: 'editor', shell: true },
    })
    expect(grant.statusCode).toBe(204)
    expect(t.app.ctx.grants.list(a.id)).toEqual([
      { userId: editor.id, role: 'editor', shell: true, masked: false, export: false },
    ])
    const dto = (
      await t.app.inject({ method: 'GET', url: '/api/connections', ...asEditor })
    ).json() as Array<{ id: string; shell: boolean }>
    expect(dto.find((c) => c.id === a.id)?.shell).toBe(true)
    const after = await t.app.inject({
      method: 'GET',
      url: `/api/connections/${a.id}/shell/history`,
      ...asEditor,
    })
    expect(after.statusCode).toBe(200)
    expect(after.json()).toEqual({ entries: [] })
  })
})
