// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MIGRATIONS } from '../src/store/migrations'
import { openStore } from '../src/store/db'

/**
 * W4 item 5: the destinations table takes the new kinds (Google Cloud Storage, Azure Blob, SFTP). Its
 * CHECK is widened by rebuilding the table with foreign keys off — so the grants and the copies that
 * point at a destination stay, never cascaded away — and the keys hold again afterwards.
 */
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('the destination kinds migration (W4.5)', () => {
  it('comes after W3’s alerts and W6’s agent switch, numbered in order with no gap or repeat', () => {
    const by = (name: string) => MIGRATIONS.find((m) => m.name === name)?.version
    expect([
      by('alerts'),
      by('ai_agent_writes'),
      by('destination-kinds-w4'),
      by('live-sync-lag-w4'),
      by('transfer-files-growing-w4'),
    ]).toEqual([36, 37, 38, 39, 40])
    expect(MIGRATIONS.map((m) => m.version)).toEqual(MIGRATIONS.map((_, i) => i + 1))
  })

  it('keeps every destination, grant and copy, and takes the new kinds', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-mig-'))
    dirs.push(dir)
    // The store as it was before this migration (later ones need it first).
    const at = MIGRATIONS.find((m) => m.name === 'destination-kinds-w4')!.version
    const before = MIGRATIONS.filter((m) => m.version < at)
    const first = await openStore(dir, before)
    const db = first.db
    db.prepare(
      "INSERT INTO users (id, username, password_hash, role, password_changed_at, created_at) VALUES ('u1', 'ada', 'x', 'admin', 1, 1)",
    ).run()
    db.prepare(
      "INSERT INTO backup_destinations (id, name, type, config, policy, status, created_at, updated_at) VALUES ('d1', 'S3', 's3', '{}', '{}', '{}', 1, 1)",
    ).run()
    db.prepare("INSERT INTO backup_destination_grants VALUES ('d1', 'u1', 'send')").run()
    db.prepare(
      "INSERT INTO backup_remote_copies (id, destination_id, remote_key, owner, format, size, sha256, state, created_at) VALUES ('c1', 'd1', 'k', 'u1', 'gzip', 1, 'x', 'complete', 1)",
    ).run()
    expect(() =>
      db
        .prepare(
          "INSERT INTO backup_destinations (id, name, type, config, policy, status, created_at, updated_at) VALUES ('d2', 'G', 'gcs', '{}', '{}', '{}', 1, 1)",
        )
        .run(),
    ).toThrow(/CHECK/)
    first.close()

    const after = await openStore(dir)
    const db2 = after.db
    expect(db2.prepare('SELECT id, type FROM backup_destinations').all()).toEqual([{ id: 'd1', type: 's3' }])
    expect(db2.prepare('SELECT * FROM backup_destination_grants').all()).toHaveLength(1)
    expect(db2.prepare('SELECT id FROM backup_remote_copies').all()).toEqual([{ id: 'c1' }])
    for (const [id, type] of <Array<[string, string]>>[
      ['d2', 'gcs'],
      ['d3', 'azure'],
      ['d4', 'sftp'],
    ])
      db2
        .prepare(
          "INSERT INTO backup_destinations (id, name, type, config, policy, status, created_at, updated_at) VALUES (?, ?, ?, '{}', '{}', '{}', 1, 1)",
        )
        .run(id, `n-${id}`, type)
    expect(() =>
      db2
        .prepare(
          "INSERT INTO backup_destinations (id, name, type, config, policy, status, created_at, updated_at) VALUES ('d9', 'X', 'ftp', '{}', '{}', '{}', 1, 1)",
        )
        .run(),
    ).toThrow(/CHECK/)
    // The keys hold again: a grant for no destination is refused, and a delete cascades.
    expect((db2.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys).toBe(1)
    expect(() =>
      db2.prepare("INSERT INTO backup_destination_grants VALUES ('nope', 'u1', 'send')").run(),
    ).toThrow(/FOREIGN KEY/)
    db2.prepare("DELETE FROM backup_destinations WHERE id = 'd1'").run()
    expect(db2.prepare('SELECT * FROM backup_destination_grants').all()).toHaveLength(0)
    expect(db2.prepare('SELECT * FROM backup_remote_copies').all()).toHaveLength(0)
    after.close()
  })
})

// W4 review (minor): the keys checked after a rebuild are those of the rebuilt tables (and of the
// tables pointing at them) — never a failure of some other table's old rows — and named.
describe('a migration that rebuilds a table with foreign keys off', () => {
  const base = [
    {
      version: 1,
      name: 'tables',
      sql: `
        CREATE TABLE p (id TEXT PRIMARY KEY);
        CREATE TABLE c (id TEXT PRIMARY KEY, p TEXT NOT NULL REFERENCES p(id) ON DELETE CASCADE);
        CREATE TABLE q (id TEXT PRIMARY KEY);
        CREATE TABLE other (id TEXT PRIMARY KEY, q TEXT REFERENCES q(id));
      `,
    },
  ]
  const rebuild = (drop: string) => ({
    version: 2,
    name: 'rebuild-p',
    foreignKeysOff: true as const,
    rebuilt: ['p'],
    sql: `
      CREATE TABLE p_next (id TEXT PRIMARY KEY);
      INSERT INTO p_next SELECT id FROM p ${drop};
      DROP TABLE p;
      ALTER TABLE p_next RENAME TO p;
    `,
  })
  const seeded = async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-mig-fk-'))
    dirs.push(dir)
    const s = await openStore(dir, base)
    s.db.exec("INSERT INTO p VALUES ('p1'); INSERT INTO c VALUES ('c1', 'p1');")
    // Another table's old broken row (foreign keys were off when it was written).
    s.db.exec("PRAGMA foreign_keys = OFF; INSERT INTO other VALUES ('o1', 'gone'); PRAGMA foreign_keys = ON;")
    s.close()
    return dir
  }

  it('checks only the rebuilt table and those pointing at it', async () => {
    const dir = await seeded()
    const s = await openStore(dir, [...base, rebuild('')])
    expect(s.db.prepare('SELECT id FROM c').all()).toEqual([{ id: 'c1' }])
    s.close()
  })

  it('names the tables whose rows point at nothing', async () => {
    const dir = await seeded()
    await expect(openStore(dir, [...base, rebuild("WHERE id <> 'p1'")])).rejects.toThrow(/c → p/)
  })
})

// W4 re-review I3: a migration of a lower number that arrives after a higher one ran (two branches
// merged in another order) is run, never skipped for ever.
describe('migrations applied out of order', () => {
  const m = (version: number, sql: string) => ({ version, name: `m${version}`, sql })
  it('runs a known migration below the current version that never ran', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-mig-order-'))
    dirs.push(dir)
    const first = await openStore(dir, [m(1, 'CREATE TABLE a (x)'), m(3, 'CREATE TABLE c (x)')])
    first.close()
    const second = await openStore(dir, [
      m(1, 'CREATE TABLE a (x)'),
      m(2, 'CREATE TABLE b (x)'),
      m(3, 'CREATE TABLE c (x)'),
    ])
    const tables = (
      second.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string
      }>
    ).map((t) => t.name)
    expect(tables).toEqual(expect.arrayContaining(['a', 'b', 'c']))
    second.close()
    // Opened again: nothing runs twice.
    ;(
      await openStore(dir, [
        m(1, 'CREATE TABLE a (x)'),
        m(2, 'CREATE TABLE b (x)'),
        m(3, 'CREATE TABLE c (x)'),
      ])
    ).close()
  })

  it('takes every version up to the current one as applied in a store made before the tracking', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-mig-legacy-'))
    dirs.push(dir)
    const s = await openStore(dir, [m(1, 'CREATE TABLE a (x)'), m(2, 'CREATE TABLE b (x)')])
    // As it was before: no record of what ran, the version alone.
    s.db.exec('DROP TABLE schema_migrations')
    s.close()
    const again = await openStore(dir, [
      m(1, 'CREATE TABLE a (x)'),
      m(2, 'CREATE TABLE b (x)'),
      m(3, 'CREATE TABLE c (x)'),
    ])
    expect(
      (
        again.db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{
          version: number
        }>
      ).map((r) => r.version),
    ).toEqual([1, 2, 3])
    again.close()
  })
})

// W4 re-review 2 (minor): a store moved to the record already past a migration that never ran (a
// build of another branch) runs it, where the migration can tell whether its change is there.
describe('migrations recorded for a store made before the record', () => {
  it('runs one at or below the current version whose change is not there', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-mig-verify-'))
    dirs.push(dir)
    const s = await openStore(dir, [
      { version: 1, name: 'm1', sql: 'CREATE TABLE a (x)' },
      { version: 3, name: 'm3', sql: 'CREATE TABLE c (x)' },
    ])
    s.db.exec('DROP TABLE schema_migrations')
    s.close()
    const hasTable = (name: string) => (db: import('node:sqlite').DatabaseSync) =>
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined
    const again = await openStore(dir, [
      { version: 1, name: 'm1', sql: 'CREATE TABLE a (x)', applied: hasTable('a') },
      { version: 2, name: 'm2', sql: 'CREATE TABLE b (x)', applied: hasTable('b') },
      { version: 3, name: 'm3', sql: 'CREATE TABLE c (x)', applied: hasTable('c') },
    ])
    expect(hasTable('b')(again.db)).toBe(true)
    again.close()
  })

  it('knows the changes of W4’s own migrations', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-mig-w4-'))
    dirs.push(dir)
    const s = await openStore(dir)
    for (const name of ['destination-kinds-w4', 'live-sync-lag-w4', 'transfer-files-growing-w4']) {
      const m = MIGRATIONS.find((x) => x.name === name)!
      expect(m.applied?.(s.db), name).toBe(true)
    }
    s.close()
  })
})
