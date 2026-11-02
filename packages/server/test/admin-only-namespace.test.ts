import { afterEach, describe, expect, it } from 'vitest'
import { ConnectionSettingsSchema } from '@mongo-manager/shared'
import { isAdminOnlyNamespace, isAdminOnlyNs } from '../src/connections/access'
import { redactSecrets } from '../src/masking/secrets'
import { canSee } from '../src/jobs/visibility'
import { operationView } from '../src/routes/data/server'
import { collectSlow } from '../src/monitor/slow-queries'
import { contextFor } from '../src/ai/context'
import type { JobRecord } from '../src/jobs/types'
import type { Principal } from '../src/http/context'
import { H, makeApp, type TestApp } from './helpers'

/**
 * Security audit 2026-10-16 (minor): one rule for what only a connection's admins may read — the
 * local database whole and the credential collections — used by every list, log and context.
 */
const apps: TestApp[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})

async function team() {
  const t = await makeApp({ auth: true })
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
  const user = (role: 'admin' | 'editor') => {
    const u = ctx.users.create({ username: `u-${role}-${Math.random()}`, passwordHash: 'x', role })
    const { sessionId, session } = ctx.sessions.create(u.id, {})
    const principal: Principal = {
      kind: 'user',
      userId: u.id,
      username: u.username,
      role,
      csrfToken: session.csrfToken,
    } as Principal
    const get = (url: string) =>
      t.app.inject({
        method: 'GET',
        url,
        headers: { ...H, 'x-csrf-token': session.csrfToken },
        cookies: { mm_sid: sessionId },
      })
    return { id: u.id, principal, get }
  }
  return { t, ctx, connectionId, user }
}

describe('security audit 2026-10-16: admin-only namespaces', () => {
  it('names the local database and the credential collections, nothing else', () => {
    expect(isAdminOnlyNamespace('local', 'oplog.rs')).toBe(true)
    expect(isAdminOnlyNamespace('local')).toBe(true)
    expect(isAdminOnlyNamespace('shop', 'system.users')).toBe(true)
    expect(isAdminOnlyNamespace('admin', 'system.keys')).toBe(true)
    expect(isAdminOnlyNamespace('shop', 'orders')).toBe(false)
    expect(isAdminOnlyNamespace('locale', 'x')).toBe(false)
    expect(isAdminOnlyNs('local.oplog.rs')).toBe(true)
    expect(isAdminOnlyNs('local')).toBe(true)
    expect(isAdminOnlyNs('admin.system.users')).toBe(true)
    expect(isAdminOnlyNs('shop.orders')).toBe(false)
    expect(isAdminOnlyNs(null)).toBe(false)
  })

  it('hides SCRAM credentials (storedKey, serverKey, salt) for everyone', () => {
    const user = {
      user: 'bob',
      credentials: {
        'SCRAM-SHA-256': {
          iterationCount: 15000,
          salt: 'c2FsdA==',
          storedKey: 'U1RPUkVE',
          serverKey: 'U0VSVkVS',
        },
      },
    }
    const text = JSON.stringify(redactSecrets(user))
    for (const secret of ['c2FsdA==', 'U1RPUkVE', 'U0VSVkVS']) expect(text).not.toContain(secret)
    expect(text).toContain('15000')
  })

  it('shows a non-admin no job on the local database, as for a credential collection', async () => {
    const { ctx, connectionId, user } = await team()
    const editor = user('editor')
    const job = (db: string, coll: string) =>
      ({ kind: 'index.create', userId: 'someone-else', connectionId, db, coll }) as unknown as JobRecord
    expect(canSee(ctx, editor.principal, job('shop', 'orders'))).toBe(true)
    expect(canSee(ctx, editor.principal, job('shop', 'system.users'))).toBe(false)
    expect(canSee(ctx, editor.principal, job('local', 'oplog.rs'))).toBe(false)
    expect(canSee(ctx, user('admin').principal, job('local', 'oplog.rs'))).toBe(true)
  })

  it('shows a non-admin no command of an operation on the local database', () => {
    const op = {
      opid: 1,
      op: 'getmore',
      ns: 'local.oplog.rs',
      command: { getMore: 1, collection: 'oplog.rs' },
    }
    expect(operationView(op, null, false).command).toBeUndefined()
    expect(operationView({ ...op, ns: 'shop.orders' }, null, false).command).toBeDefined()
    expect(operationView(op, null, true).command).toBeDefined()
  })

  it('lists a non-admin no slow query of the local database', async () => {
    const line = (ns: string) =>
      JSON.stringify({
        t: { $date: '2026-10-16T10:00:00.000Z' },
        id: 51803,
        attr: { type: 'command', ns, durationMillis: 500, command: { find: ns.split('.')[1], filter: {} } },
      })
    const client = {
      db: () => ({
        command: async () => ({
          log: [line('local.oplog.rs'), line('shop.orders'), line('admin.system.users')],
        }),
      }),
    } as never
    const shown = async (admin: boolean) =>
      (await collectSlow(client, { source: 'log' } as never, 100, admin)).raw.map((e) => e.ns)
    expect(await shown(false)).toEqual(['shop.orders'])
    expect((await shown(true)).sort()).toEqual(['admin.system.users', 'local.oplog.rs', 'shop.orders'])
  })

  it('never sends the local database to an AI provider, whoever asks', async () => {
    const { ctx, connectionId, user } = await team()
    await expect(
      contextFor(
        {
          ctx,
          principal: user('admin').principal,
          connectionId,
          client: {} as never,
          db: 'local',
          coll: 'oplog.rs',
          comment: 'c',
          signal: new AbortController().signal,
        } as never,
        { plan: false, indexes: false, validator: false },
      ),
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('marks an AI history entry on the local database as admin-only', async () => {
    const { ctx, connectionId, user } = await team()
    const id = ctx.ai.history.record({
      owner: user('editor').id,
      action: 'query',
      connectionId,
      namespace: 'local.oplog.rs',
      provider: { id: 'p', name: 'P', kind: 'anthropic', model: 'm' },
      outcome: 'ok',
      usage: { input: 1, output: 1 },
      ms: 1,
      price: null,
      content: null,
    } as never)
    const row = ctx.store.db.prepare('SELECT credential FROM ai_requests WHERE id = ?').get(id) as {
      credential: number
    }
    expect(row.credential).toBe(1)
  })

  it('opens no shared favourite of the local database in a non-admin’s library', async () => {
    const { t, ctx, connectionId, user } = await team()
    const admin = user('admin')
    const editor = user('editor')
    ctx.grants.set(connectionId, editor.id, 'editor')
    for (const [db, coll] of [
      ['local', 'oplog.rs'],
      ['shop', 'orders'],
    ] as const)
      ctx.favourites.create({
        ownerId: admin.id,
        connectionId,
        db,
        coll,
        name: `fav ${db}`,
        tags: [],
        shared: true,
        text: JSON.stringify({ filter: {} }),
      })
    const listed = async (u: typeof editor) =>
      (
        (await u.get(`/api/connections/${connectionId}/library?type=favourite`)).json().items as Array<{
          db: string
        }>
      )
        .map((i) => i.db)
        .sort()
    expect(await listed(editor)).toEqual(['shop'])
    expect(await listed(admin)).toEqual(['local', 'shop'])
    void t
  })
})
