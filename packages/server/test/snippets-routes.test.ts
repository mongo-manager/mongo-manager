// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConnectionSettingsSchema } from '@mongo-manager/shared'
import { MAX_SNIPPETS_TOTAL_PER_CONNECTION, SNIPPET_LIST_BYTES } from '../src/queries/snippets'
import { H, makeApp, type TestApp } from './helpers'

/**
 * Phase 3a-2 spec §3.5: snippet routes. Everyone who may use the shell on the connection sees their
 * own and the shared snippets; editing is the owner's; a connection admin may delete any snippet it
 * sees (as with favourites). The code never reaches the audit log.
 */
const apps: TestApp[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})

async function setup() {
  const t = await makeApp({ auth: true })
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
  const as = (role: 'admin' | 'editor' | 'viewer', grant?: 'editor' | 'viewer', shell?: boolean) => {
    const user = ctx.users.create({ username: `u-${role}-${Math.random()}`, passwordHash: 'x', role })
    if (grant) ctx.grants.set(connectionId, user.id, grant)
    if (shell) ctx.grants.setShell(connectionId, user.id, true)
    const s = ctx.sessions.create(user.id, {})
    const opts = { headers: { ...H, 'x-csrf-token': s.session.csrfToken }, cookies: { mm_sid: s.sessionId } }
    const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) =>
      t.app.inject({
        method,
        url: `/api/connections/${connectionId}${url}`,
        ...opts,
        ...(payload ? { payload } : {}),
      })
    return { id: user.id, call }
  }
  const audit = (action: string) =>
    ctx.store.db.prepare('SELECT details FROM audit_log WHERE action = ?').all(action) as Array<{
      details: string
    }>
  return { t, ctx, connectionId, as, audit }
}

const snippet = (name: string, extra: object = {}) => ({
  name,
  code: 'db.orders.find({ tag: {{tag}} }) // MARKER_CODE',
  params: [{ name: 'tag', type: 'string' }],
  ...extra,
})

describe('snippet routes (phase 3a-2 §3.5)', () => {
  it('are closed to a viewer and to an editor without the shell grant', async () => {
    const { as } = await setup()
    for (const u of [as('viewer', 'viewer'), as('editor', 'editor')]) {
      expect((await u.call('GET', '/snippets')).statusCode).toBe(403)
      expect((await u.call('POST', '/snippets', snippet('x'))).statusCode).toBe(403)
      expect((await u.call('PUT', `/snippets/${crypto.randomUUID()}`, snippet('x'))).statusCode).toBe(403)
      expect((await u.call('DELETE', `/snippets/${crypto.randomUUID()}`)).statusCode).toBe(403)
    }
  })

  it('let an editor with the shell grant save, list, change and delete their own', async () => {
    const { as } = await setup()
    const ed = as('editor', 'editor', true)
    const created = await ed.call('POST', '/snippets', snippet('mine', { tags: ['a'] }))
    expect(created.statusCode).toBe(201)
    const view = created.json()
    expect(view).toMatchObject({ name: 'mine', tags: ['a'], mine: true, shared: false })
    expect(view.code).toContain('MARKER_CODE')
    expect((await ed.call('GET', '/snippets')).json().snippets).toHaveLength(1)
    const changed = await ed.call('PUT', `/snippets/${view.id}`, snippet('renamed'))
    expect(changed.statusCode).toBe(200)
    expect(changed.json()).toMatchObject({ name: 'renamed', tags: ['a'] })
    expect((await ed.call('DELETE', `/snippets/${view.id}`)).statusCode).toBe(204)
    expect((await ed.call('GET', '/snippets')).json().snippets).toHaveLength(0)
  })

  it('hide another user’s private snippet and keep a shared one read-only for others', async () => {
    const { as } = await setup()
    const ada = as('editor', 'editor', true)
    const bob = as('editor', 'editor', true)
    const priv = (await ada.call('POST', '/snippets', snippet('private'))).json()
    const shared = (await ada.call('POST', '/snippets', snippet('shared', { shared: true }))).json()
    const seen = (await bob.call('GET', '/snippets')).json().snippets as Array<{
      name: string
      mine: boolean
      owner: string
    }>
    expect(seen.map((s) => s.name)).toEqual(['shared'])
    expect(seen[0]).toMatchObject({ mine: false })
    expect(seen[0]!.owner).toBeTruthy()
    expect((await bob.call('PUT', `/snippets/${priv.id}`, snippet('x'))).statusCode).toBe(404)
    expect((await bob.call('DELETE', `/snippets/${priv.id}`)).statusCode).toBe(404)
    expect((await bob.call('PUT', `/snippets/${shared.id}`, snippet('x'))).statusCode).toBe(403)
    expect((await bob.call('DELETE', `/snippets/${shared.id}`)).statusCode).toBe(403)
  })

  it('let a connection admin remove a shared snippet (moderation)', async () => {
    const { as } = await setup()
    const ada = as('editor', 'editor', true)
    const admin = as('admin')
    const shared = (await ada.call('POST', '/snippets', snippet('shared', { shared: true }))).json()
    expect((await admin.call('DELETE', `/snippets/${shared.id}`)).statusCode).toBe(204)
  })

  it('refuse the 201st snippet of one owner on one connection', async () => {
    const { ctx, connectionId, as } = await setup()
    const ed = as('editor', 'editor', true)
    for (let i = 0; i < 200; i++)
      ctx.snippets.create({
        ownerId: ed.id,
        connectionId,
        name: `s${i}`,
        tags: [],
        body: { code: 'print(1)', params: [] },
        shared: false,
      })
    const res = await ed.call('POST', '/snippets', snippet('one too many'))
    expect(res.statusCode).toBe(409)
    expect(res.json().message).toMatch(/200/)
  })

  it('give one snippet by id to those who may see it (final review M8)', async () => {
    const { as } = await setup()
    const ada = as('editor', 'editor', true)
    const bob = as('editor', 'editor', true)
    const priv = (await ada.call('POST', '/snippets', snippet('private'))).json()
    const shared = (await ada.call('POST', '/snippets', snippet('shared', { shared: true }))).json()
    const own = await ada.call('GET', `/snippets/${priv.id}`)
    expect(own.statusCode).toBe(200)
    expect(own.json()).toMatchObject({ id: priv.id, name: 'private', mine: true })
    expect((await bob.call('GET', `/snippets/${priv.id}`)).statusCode).toBe(404)
    expect((await bob.call('GET', `/snippets/${shared.id}`)).json()).toMatchObject({
      name: 'shared',
      mine: false,
    })
    expect((await bob.call('GET', `/snippets/${crypto.randomUUID()}`)).statusCode).toBe(404)
    expect((await bob.call('GET', '/snippets/not-a-uuid')).statusCode).toBe(400)
    expect((await as('viewer', 'viewer').call('GET', `/snippets/${shared.id}`)).statusCode).toBe(403)
  })

  it('refuse a snippet past the connection total, whoever saves it (final review M8)', async () => {
    const { ctx, connectionId, as } = await setup()
    const owners = Array.from({ length: MAX_SNIPPETS_TOTAL_PER_CONNECTION / 200 }, () =>
      as('editor', 'editor', true),
    )
    for (const owner of owners)
      for (let i = 0; i < 200; i++)
        ctx.snippets.create({
          ownerId: owner.id,
          connectionId,
          name: `s${i}`,
          tags: [],
          body: { code: 'print(1)', params: [] },
          shared: false,
        })
    const res = await as('editor', 'editor', true).call('POST', '/snippets', snippet('one too many'))
    expect(res.statusCode).toBe(409)
    expect(res.json().message).toMatch(String(MAX_SNIPPETS_TOTAL_PER_CONNECTION))
  })

  it('list within a byte budget and say when some were left out (final review M8)', async () => {
    const { ctx, connectionId, as } = await setup()
    const ed = as('editor', 'editor', true)
    const code = `print(1) // ${'x'.repeat(60 * 1024)}`
    const count = Math.ceil(SNIPPET_LIST_BYTES / (60 * 1024)) + 5
    for (let i = 0; i < count; i++)
      ctx.snippets.create({
        ownerId: ed.id,
        connectionId,
        name: `s${String(i).padStart(3, '0')}`,
        tags: [],
        body: { code, params: [] },
        shared: false,
      })
    const res = (await ed.call('GET', '/snippets')).json() as { snippets: unknown[]; truncated?: boolean }
    expect(res.truncated).toBe(true)
    expect(res.snippets.length).toBeLessThan(count)
    expect(res.snippets.length).toBeGreaterThan(0)
  })

  it('never put the code in the audit log', async () => {
    const { as, audit } = await setup()
    const ed = as('editor', 'editor', true)
    const view = (await ed.call('POST', '/snippets', snippet('audited', { tags: ['t'] }))).json()
    await ed.call('DELETE', `/snippets/${view.id}`)
    await vi.waitFor(() => expect(audit('snippets.delete')).toHaveLength(1))
    const saved = audit('snippets.save')
    expect(saved).toHaveLength(1)
    expect(JSON.parse(saved[0]!.details)).toMatchObject({ name: 'audited', tags: ['t'], shared: false })
    for (const row of [...saved, ...audit('snippets.delete')])
      expect(row.details).not.toContain('MARKER_CODE')
  })

  // W5: a snippet's code and parameters are edited in the Library; the edit is audited (that the
  // code changed, never the code), checked as a new snippet is, and shared ones stay the owner's.
  it('let the owner change the code and parameters, audited without the code', async () => {
    const { as, audit } = await setup()
    const ada = as('editor', 'editor', true)
    const bob = as('editor', 'editor', true)
    const view = (
      await ada.call('POST', '/snippets', snippet('shared', { shared: true, tags: ['t'] }))
    ).json()
    const edited = {
      name: 'shared',
      code: 'db.orders.find({ tag: {{tag}} }).limit({{n}}) // MARKER_CODE_2',
      params: [
        { name: 'tag', type: 'string' },
        { name: 'n', type: 'number', default: '5' },
      ],
      shared: true,
    }
    const changed = await ada.call('PUT', `/snippets/${view.id}`, edited)
    expect(changed.statusCode).toBe(200)
    expect(changed.json()).toMatchObject({ code: edited.code, tags: ['t'], shared: true })
    expect((await bob.call('GET', `/snippets/${view.id}`)).json().params).toHaveLength(2)
    // Unchanged code is said so too.
    await ada.call('PUT', `/snippets/${view.id}`, { ...edited, name: 'renamed' })
    await vi.waitFor(() => expect(audit('snippets.save')).toHaveLength(3))
    const rows = audit('snippets.save').map((r) => JSON.parse(r.details) as Record<string, unknown>)
    expect(rows[1]).toMatchObject({ name: 'shared', shared: true, codeChanged: true })
    expect(rows[2]).toMatchObject({ name: 'renamed', codeChanged: false })
    for (const row of audit('snippets.save')) expect(row.details).not.toContain('MARKER_CODE')
    // Checked as a new one: a placeholder inside a string, or one not declared, is refused.
    for (const code of ['db.c.find({ a: "{{tag}}" })', 'db.c.find({ a: {{other}} })'])
      expect((await ada.call('PUT', `/snippets/${view.id}`, { ...edited, code })).statusCode).toBe(400)
    // Another user may read it, never change its code.
    expect(
      (await bob.call('PUT', `/snippets/${view.id}`, { ...edited, code: 'db.dropDatabase()' })).statusCode,
    ).toBe(403)
    expect((await bob.call('GET', `/snippets/${view.id}`)).json().code).toBe(edited.code)
  })

  it('show an ownerless snippet to a connection admin only', async () => {
    const { ctx, connectionId, as } = await setup()
    ctx.snippets.create({
      ownerId: null,
      connectionId,
      name: 'local',
      tags: [],
      body: { code: 'print(1)', params: [] },
      shared: false,
    })
    const names = async (u: ReturnType<typeof as>) =>
      ((await u.call('GET', '/snippets')).json().snippets as Array<{ name: string }>).map((s) => s.name)
    expect(await names(as('admin'))).toEqual(['local'])
    expect(await names(as('editor', 'editor', true))).toEqual([])
  })

  it('appear in the library search for shell users only', async () => {
    const { as } = await setup()
    const ed = as('editor', 'editor', true)
    await ed.call('POST', '/snippets', snippet('lib', { shared: true }))
    const items = (await ed.call('GET', '/library')).json().items as Array<Record<string, unknown>>
    expect(items).toContainEqual(
      expect.objectContaining({ type: 'snippet', kind: 'shell', db: '', coll: '', name: 'lib' }),
    )
    expect(items.find((i) => i.type === 'snippet')!.preview).toContain('db.orders.find')
    const noShell = as('editor', 'editor')
    const theirs = (await noShell.call('GET', '/library')).json().items as Array<{ type: string }>
    expect(theirs.some((i) => i.type === 'snippet')).toBe(false)
    const onlySnippets = (await ed.call('GET', '/library?type=snippet')).json().items as Array<{
      type: string
    }>
    expect(onlySnippets.every((i) => i.type === 'snippet')).toBe(true)
  })
})
