import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { randomBytes } from 'node:crypto'
import { MIGRATIONS } from '../src/store/migrations'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createSecretBox, loadOrCreateKey } from '../src/crypto/secret-box'
import { openStore } from '../src/store/db'
import { ConnectionRepo } from '../src/connections/repo'
import { rotateSecretKey } from '../src/crypto/rotate'
import { MAX_PRESETS, TransferPresets, presetContext } from '../src/transfer/presets'
import { AppError } from '../src/errors'
import { H, makeApp } from './helpers'

const setup = () => {
  const db = new DatabaseSync(':memory:')
  for (const m of MIGRATIONS) db.exec(m.sql)
  return { db, presets: new TransferPresets(db, createSecretBox(randomBytes(32)), () => 1) }
}
const input = (name: string, filter = '{ email: "a@x" }') => ({
  kind: 'export' as const,
  name,
  namespace: 'shop.orders',
  body: { format: 'csv' as const, fields: ['a'], filter },
})

describe('saved transfer settings (spec §4.4)', () => {
  it("stores them per owner, sealed, and lists only the owner's", () => {
    const { db, presets } = setup()
    const p = presets.create('u1', input('Monthly'))
    expect(presets.list('u1', 'export')).toEqual([
      expect.objectContaining({ id: p.id, name: 'Monthly', body: input('Monthly').body }),
    ])
    expect(presets.list('u1', 'import')).toEqual([])
    expect(presets.list('u2')).toEqual([])
    const raw = JSON.stringify(db.prepare('SELECT * FROM transfer_presets').all())
    expect(raw).not.toContain('a@x')
    expect(() => presets.update('u2', p.id, input('x'))).toThrow(AppError)
    expect(() => presets.delete('u2', p.id)).toThrow(AppError)
    expect(presets.update('u1', p.id, input('Weekly')).name).toBe('Weekly')
    presets.delete('u1', p.id)
    expect(presets.list('u1')).toEqual([])
  })

  // Seventeenth review of explain masking (M-3): saved before keys refused an operator.
  it('drops the refused keys of a preset saved before, keeping the preset', () => {
    const db = new DatabaseSync(':memory:')
    for (const m of MIGRATIONS) db.exec(m.sql)
    const box = createSecretBox(randomBytes(32))
    const presets = new TransferPresets(db, box, () => 1)
    const p = presets.create('u1', {
      kind: 'import',
      name: 'Old',
      namespace: 'shop.orders',
      body: { mode: 'merge', keys: ['code'] },
    })
    const old = JSON.stringify({ mode: 'merge', keys: ['$expr', 'code'] })
    db.prepare('UPDATE transfer_presets SET body = ? WHERE id = ?').run(
      box.seal(old, presetContext(p.id, 'u1')),
      p.id,
    )
    expect(presets.list('u1')).toEqual([
      // All of them, so the form falls back to _id, never to part of a compound key (eighteenth
      // review, M-3).
      expect.objectContaining({ id: p.id, body: { mode: 'merge' } }),
    ])
    const none = JSON.stringify({ mode: 'merge', keys: ['$expr'] })
    db.prepare('UPDATE transfer_presets SET body = ? WHERE id = ?').run(
      box.seal(none, presetContext(p.id, 'u1')),
      p.id,
    )
    expect(presets.list('u1')).toEqual([expect.objectContaining({ id: p.id, body: { mode: 'merge' } })])
    presets.delete('u1', p.id)
    expect(presets.list('u1')).toEqual([])
  })

  it('does not open a sealed body moved to another row or owner', () => {
    const { db, presets } = setup()
    const a = presets.create('u1', input('A'))
    const b = presets.create('u2', input('B', '{ x: 1 }'))
    const body = (db.prepare('SELECT body FROM transfer_presets WHERE id = ?').get(a.id) as { body: string })
      .body
    db.prepare('UPDATE transfer_presets SET body = ? WHERE id = ?').run(body, b.id)
    expect(presets.list('u2')).toEqual([])
  })

  it('survives a key rotation (sealed settings are re-sealed with the new key)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-presets-'))
    try {
      const store = await openStore(dir)
      const box = createSecretBox(loadOrCreateKey({ dataDir: dir }))
      // A connection, so the store holds sealed data and the rotation has something to start from.
      new ConnectionRepo(store.db, box, Date.now).create(
        { name: 'P', settings: { hosts: [{ host: 'h' }] } } as never,
        null,
      )
      new TransferPresets(store.db, box, () => 1).create('u1', input('Kept'))
      store.close()
      const result = await rotateSecretKey({ dataDir: dir })
      expect(result.transferPresets).toBe(1)
      const reopened = await openStore(dir)
      try {
        const fresh = new TransferPresets(
          reopened.db,
          createSecretBox(loadOrCreateKey({ dataDir: dir })),
          () => 1,
        )
        expect(fresh.list('u1')).toEqual([
          expect.objectContaining({ name: 'Kept', body: input('Kept').body }),
        ])
      } finally {
        reopened.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses duplicate names, oversize bodies and more than 200 presets', () => {
    const { presets } = setup()
    presets.create('u1', input('A'))
    expect(() => presets.create('u1', input('A'))).toThrow(AppError)
    expect(() => presets.create('u1', input('B', 'x'.repeat(70_000)))).toThrow(AppError)
    for (let i = 1; i < MAX_PRESETS; i++) presets.create('u1', input(`P${i}`))
    expect(() => presets.create('u1', input('one too many'))).toThrow(AppError)
  })
})

// Gap scan 2026-10-15: changing and removing a saved setting were tested on the repository only.
describe('saved transfer settings over HTTP', () => {
  it('lets each user change and remove only their own, and checks what is sent', async () => {
    const t = await makeApp({ auth: true })
    try {
      const as = (username: string) => {
        const user = t.app.ctx.users.create({ username, passwordHash: 'x', role: 'editor' })
        const { sessionId, session } = t.app.ctx.sessions.create(user.id, {})
        return (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) =>
          t.app.inject({
            method,
            url: `/api/transfer/presets${url}`,
            headers: { ...H, 'x-csrf-token': session.csrfToken },
            cookies: { mm_sid: sessionId },
            ...(payload ? { payload } : {}),
          })
      }
      const ada = as('ada')
      const bob = as('bob')
      const created = await ada('POST', '', input('Monthly'))
      expect(created.statusCode).toBe(201)
      const { id } = created.json()

      // Someone else's setting is not there for them: neither changed nor removed.
      expect((await bob('PUT', `/${id}`, input('Mine now'))).statusCode).toBe(404)
      expect((await bob('DELETE', `/${id}`)).statusCode).toBe(404)
      expect((await ada('GET', '')).json().presets).toEqual([
        expect.objectContaining({ id, name: 'Monthly' }),
      ])

      // A malformed change is refused and leaves the setting as it was.
      expect((await ada('PUT', `/${id}`, { ...input('x'), kind: 'nope' })).statusCode).toBe(400)
      expect((await ada('PUT', `/${id}`, { ...input(''), name: '' })).statusCode).toBe(400)
      const changed = await ada('PUT', `/${id}`, input('Weekly'))
      expect(changed.statusCode).toBe(200)
      expect(changed.json()).toMatchObject({ id, name: 'Weekly' })

      expect((await ada('DELETE', `/${id}`)).statusCode).toBe(204)
      expect((await ada('DELETE', `/${id}`)).statusCode).toBe(404)
      expect((await ada('PUT', `/${id}`, input('Gone'))).statusCode).toBe(404)
      expect((await ada('GET', '')).json().presets).toEqual([])
    } finally {
      await t.close()
    }
  })
})
