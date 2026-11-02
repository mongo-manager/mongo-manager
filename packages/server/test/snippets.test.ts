import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openStore, type Store } from '../src/store/db'
import { createSecretBox, loadOrCreateKey } from '../src/crypto/secret-box'
import { ConnectionRepo } from '../src/connections/repo'
import { rotateSecretKey } from '../src/crypto/rotate'
import { SnippetRepo } from '../src/queries/snippets'

/** Phase 3a-2 spec §3.5: snippets are sealed at rest, owner-scoped, optionally shared. */
const dirs: string[] = []
const stores: Store[] = []
afterEach(() => {
  for (const s of stores.splice(0)) s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'mm-snippets-'))
  dirs.push(dir)
  const box = createSecretBox(loadOrCreateKey({ dataDir: dir }))
  const store = await openStore(dir)
  stores.push(store)
  const connRepo = new ConnectionRepo(store.db, box, Date.now)
  const conn = connRepo.create({ name: 'P', settings: { hosts: [{ host: 'h' }] } } as never, null)
  const user = (name: string) => {
    const id = randomUUID()
    store.db
      .prepare(
        "INSERT INTO users (id, username, password_hash, role, password_changed_at, created_at) VALUES (?, ?, 'x', 'editor', 0, 0)",
      )
      .run(id, name)
    return id
  }
  let t = 1000
  return { dir, store, box, conn, connRepo, user, repo: new SnippetRepo(store.db, box, () => ++t) }
}

const body = (code: string) => ({ code, params: [] })

describe('SnippetRepo', () => {
  it('seals the code at rest', async () => {
    const { store, conn, repo, user } = await setup()
    const ada = user('ada')
    const row = repo.create({
      ownerId: ada,
      connectionId: conn.id,
      name: 'n',
      tags: ['t'],
      body: body('db.SECRET_MARKER.find()'),
      shared: false,
    })
    const raw = store.db.prepare('SELECT body FROM snippets WHERE id = ?').get(row.id) as { body: string }
    expect(raw.body).not.toContain('SECRET_MARKER')
    expect(repo.get(row.id)).toMatchObject({
      body: { code: 'db.SECRET_MARKER.find()', params: [] },
      tags: ['t'],
    })
  })

  it('does not open a body copied to another row (bound to its id and connection)', async () => {
    const { store, conn, repo, user } = await setup()
    const ada = user('ada')
    const a = repo.create({
      ownerId: ada,
      connectionId: conn.id,
      name: 'a',
      tags: [],
      body: body('A'),
      shared: false,
    })
    const b = repo.create({
      ownerId: ada,
      connectionId: conn.id,
      name: 'b',
      tags: [],
      body: body('B'),
      shared: false,
    })
    const sealed = (store.db.prepare('SELECT body FROM snippets WHERE id = ?').get(a.id) as { body: string })
      .body
    store.db.prepare('UPDATE snippets SET body = ? WHERE id = ?').run(sealed, b.id)
    expect(repo.get(b.id)).toBeNull()
    expect(repo.list({ ownerId: ada, connectionId: conn.id, ownerless: false }).map((r) => r.name)).toEqual([
      'a',
    ])
  })

  it('lists own and shared snippets, never another user’s private one; ownerless only on request', async () => {
    const { conn, repo, user } = await setup()
    const ada = user('ada')
    const bob = user('bob')
    repo.create({
      ownerId: ada,
      connectionId: conn.id,
      name: 'ada-private',
      tags: [],
      body: body('1'),
      shared: false,
    })
    repo.create({
      ownerId: bob,
      connectionId: conn.id,
      name: 'bob-private',
      tags: [],
      body: body('2'),
      shared: false,
    })
    repo.create({
      ownerId: bob,
      connectionId: conn.id,
      name: 'bob-shared',
      tags: [],
      body: body('3'),
      shared: true,
    })
    repo.create({
      ownerId: null,
      connectionId: conn.id,
      name: 'local',
      tags: [],
      body: body('4'),
      shared: false,
    })
    const names = (ownerless: boolean) =>
      repo
        .list({ ownerId: ada, connectionId: conn.id, ownerless })
        .map((r) => r.name)
        .sort()
    expect(names(false)).toEqual(['ada-private', 'bob-shared'])
    expect(names(true)).toEqual(['ada-private', 'bob-shared', 'local'])
    expect(repo.countFor(bob, conn.id)).toBe(2)
  })

  it('removes a deleted user’s private snippets and keeps the shared ones, ownerless', async () => {
    const { store, conn, repo, user } = await setup()
    const ada = user('ada')
    const priv = repo.create({
      ownerId: ada,
      connectionId: conn.id,
      name: 'p',
      tags: [],
      body: body('1'),
      shared: false,
    })
    const shared = repo.create({
      ownerId: ada,
      connectionId: conn.id,
      name: 's',
      tags: [],
      body: body('2'),
      shared: true,
    })
    store.db.prepare('DELETE FROM users WHERE id = ?').run(ada)
    expect(repo.get(priv.id)).toBeNull()
    expect(repo.get(shared.id)).toMatchObject({ ownerId: null, name: 's' })
  })

  it('removes the snippets of a deleted connection', async () => {
    const { conn, connRepo, repo } = await setup()
    const row = repo.create({
      ownerId: null,
      connectionId: conn.id,
      name: 'n',
      tags: [],
      body: body('1'),
      shared: false,
    })
    connRepo.delete(conn.id)
    expect(repo.get(row.id)).toBeNull()
  })

  it('re-seals on key rotation', async () => {
    const { dir, store, conn, repo } = await setup()
    repo.create({
      ownerId: null,
      connectionId: conn.id,
      name: 'n',
      tags: [],
      body: body('db.x.find()'),
      shared: false,
    })
    store.close()
    stores.splice(stores.indexOf(store), 1)
    const result = await rotateSecretKey({ dataDir: dir })
    expect(result.snippets).toBe(1)
    const reopened = await openStore(dir)
    stores.push(reopened)
    const fresh = new SnippetRepo(reopened.db, createSecretBox(loadOrCreateKey({ dataDir: dir })), Date.now)
    expect(
      fresh.list({ ownerId: null, connectionId: conn.id, ownerless: true }).map((r) => r.body.code),
    ).toEqual(['db.x.find()'])
  })
})
