// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore, type Store } from '../src/store/db'
import { createSecretBox, loadOrCreateKey } from '../src/crypto/secret-box'
import { ConnectionRepo } from '../src/connections/repo'
import { rotateSecretKey } from '../src/crypto/rotate'
import { PersonalFieldsRepo } from '../src/masking/repo'

/** Phase 3b spec §2.1: the rule list is sealed per connection and covered by key rotation. */
const stores: Store[] = []
const dirs: string[] = []
afterEach(() => {
  for (const s of stores.splice(0)) s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'mm-pf-'))
  dirs.push(dir)
  const box = createSecretBox(loadOrCreateKey({ dataDir: dir }))
  const store = await openStore(dir)
  stores.push(store)
  const connRepo = new ConnectionRepo(store.db, box, Date.now)
  const conn = connRepo.create({ name: 'P', settings: { hosts: [{ host: 'h' }] } } as never, null)
  const repo = new PersonalFieldsRepo(store.db, box, () => 1000)
  return { dir, store, box, conn, connRepo, repo }
}

const rules = [{ db: 'crm', coll: 'users', field: 'email' }]

describe('PersonalFieldsRepo (phase 3b §2.1)', () => {
  it('answers no rules until set, then the rules with a version', async () => {
    const { conn, repo } = await setup()
    expect(repo.get(conn.id)).toEqual({ rules: [], version: 0, scratch: 0 })
    repo.set(conn.id, rules)
    expect(repo.get(conn.id)).toEqual({ rules, version: 1000, scratch: 0 })
    // A second save in the same millisecond still gets a new version.
    repo.set(conn.id, [])
    expect(repo.get(conn.id)).toEqual({ rules: [], version: 1001, scratch: 0 })
  })

  it('binds the sealed list to its connection (a row moved to another connection does not open)', async () => {
    const { store, conn, connRepo, repo } = await setup()
    const other = connRepo.create({ name: 'Q', settings: { hosts: [{ host: 'h' }] } } as never, null)
    repo.set(conn.id, rules)
    const sealed = (store.db.prepare('SELECT rules FROM personal_fields').get() as { rules: string }).rules
    store.db
      .prepare('INSERT INTO personal_fields (connection_id, rules, updated_at) VALUES (?, ?, 1)')
      .run(other.id, sealed)
    expect(() => repo.get(other.id)).toThrow()
  })

  it('goes with its connection', async () => {
    const { store, conn, connRepo, repo } = await setup()
    repo.set(conn.id, rules)
    connRepo.delete(conn.id)
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM personal_fields').get()).toEqual({ n: 0 })
  })

  it('re-seals on key rotation', async () => {
    const { dir, store, conn, repo } = await setup()
    repo.set(conn.id, rules)
    store.close()
    stores.splice(stores.indexOf(store), 1)
    const result = await rotateSecretKey({ dataDir: dir })
    expect(result.personalFields).toBe(1)
    const reopened = await openStore(dir)
    stores.push(reopened)
    const fresh = new PersonalFieldsRepo(
      reopened.db,
      createSecretBox(loadOrCreateKey({ dataDir: dir })),
      Date.now,
    )
    expect(fresh.get(conn.id).rules).toEqual(rules)
  })
})
