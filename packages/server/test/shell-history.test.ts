import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openStore, transaction, type Store } from '../src/store/db'
import { createSecretBox, loadOrCreateKey } from '../src/crypto/secret-box'
import { ConnectionRepo } from '../src/connections/repo'
import { rotateSecretKey } from '../src/crypto/rotate'
import { slow } from './support/slowness'
import {
  ShellHistoryRepo,
  MAX_SHELL_HISTORY_PER_CONNECTION,
  MAX_SHELL_HISTORY_PER_OWNER,
} from '../src/shell/history'

const dirs: string[] = []
const stores: Store[] = []
afterEach(() => {
  for (const s of stores.splice(0)) s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'mm-shellhist-'))
  dirs.push(dir)
  const box = createSecretBox(loadOrCreateKey({ dataDir: dir }))
  const store = await openStore(dir)
  stores.push(store)
  const conn = new ConnectionRepo(store.db, box, Date.now).create(
    { name: 'P', settings: { hosts: [{ host: 'h' }] } } as never,
    null,
  )
  let t = 1000
  return { dir, store, box, conn, repo: new ShellHistoryRepo(store.db, box, () => ++t) }
}

const count = (store: Store) =>
  (store.db.prepare('SELECT COUNT(*) AS n FROM shell_history').get() as { n: number }).n

describe('shell history (phase 3a-1 §7)', () => {
  it('records commands newest first and counts repeats, moving them to the top', async () => {
    const { conn, repo } = await setup()
    repo.record(null, conn.id, 'db.a.find()')
    repo.record(null, conn.id, 'db.b.find()')
    repo.record(null, conn.id, 'db.a.find()')
    const list = repo.list({ owner: null, connectionId: conn.id, limit: 10 })
    expect(list.map((e) => e.code)).toEqual(['db.a.find()', 'db.b.find()'])
    expect(list[0]!.count).toBe(2)
  })

  it('keeps the per-connection cap and ignores an over-large command', async () => {
    const { store, conn, repo } = await setup()
    for (let i = 0; i < MAX_SHELL_HISTORY_PER_CONNECTION + 5; i++) repo.record(null, conn.id, `cmd${i}`)
    expect(count(store)).toBe(MAX_SHELL_HISTORY_PER_CONNECTION)
    repo.record(null, conn.id, 'y'.repeat(70 * 1024))
    expect(JSON.stringify(repo.list({ owner: null, connectionId: conn.id, limit: 1 }))).not.toContain('yyyy')
  })

  // Proving the per-owner cap means writing more than the cap of sealed rows (each an encrypt +
  // HMAC): about 8 s in one transaction, so a budget above the default for a loaded runner.
  it('keeps the per-owner cap across connections', { timeout: slow(40_000) }, async () => {
    const { store, box, repo } = await setup()
    const connRepo = new ConnectionRepo(store.db, box, Date.now)
    const perConn = Math.floor(MAX_SHELL_HISTORY_PER_OWNER / 6) + 100
    const conns = Array.from({ length: 6 }, (_, c) =>
      connRepo.create({ name: `c${c}`, settings: { hosts: [{ host: 'h' }] } } as never, null),
    )
    // Thousands of records, each its own commit, waited on the disk under a full run (75 s): one
    // transaction around them; each record's savepoint and pruning run as ever.
    transaction(store.db, () => {
      for (const [c, conn] of conns.entries())
        for (let i = 0; i < perConn; i++) repo.record(null, conn.id, `x${c}-${i}`)
    })
    expect(count(store)).toBe(MAX_SHELL_HISTORY_PER_OWNER)
  })

  it('seals the code at rest and is owner-only', async () => {
    const { store, conn, repo } = await setup()
    const ada = randomUUID()
    store.db
      .prepare(
        "INSERT INTO users (id, username, password_hash, role, password_changed_at, created_at) VALUES (?, 'ada', 'x', 'editor', 0, 0)",
      )
      .run(ada)
    repo.record(ada, conn.id, 'db.secret.find({ token: "abc" })')
    const raw = store.db.prepare('SELECT code FROM shell_history').get() as { code: string }
    expect(raw.code).not.toContain('secret')
    expect(repo.list({ owner: null, connectionId: conn.id, limit: 10 })).toEqual([])
    expect(repo.list({ owner: ada, connectionId: conn.id, limit: 10 })).toHaveLength(1)
  })

  it('re-seals and re-keys on key rotation, so repeats still count', async () => {
    const { dir, store, conn, repo } = await setup()
    repo.record(null, conn.id, 'db.a.find()')
    store.close()
    stores.splice(stores.indexOf(store), 1)
    const result = await rotateSecretKey({ dataDir: dir })
    expect(result.shellHistory).toBe(1)
    const reopened = await openStore(dir)
    stores.push(reopened)
    const fresh = new ShellHistoryRepo(
      reopened.db,
      createSecretBox(loadOrCreateKey({ dataDir: dir })),
      Date.now,
    )
    fresh.record(null, conn.id, 'db.a.find()')
    expect(fresh.list({ owner: null, connectionId: conn.id, limit: 10 }).map((e) => e.count)).toEqual([2])
  })
})
