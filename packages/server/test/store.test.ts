// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MIGRATIONS } from '../src/store/migrations'
import { DB_FILE, openStore, transaction, type Migration, type Store } from '../src/store/db'

const dirs: string[] = []
const stores: Store[] = []
function tempDir() {
  const d = mkdtempSync(join(tmpdir(), 'mm-store-'))
  dirs.push(d)
  return d
}
async function open(dir: string, migrations?: readonly Migration[]) {
  const s = await openStore(dir, migrations)
  stores.push(s)
  return s
}
afterEach(() => {
  for (const s of stores.splice(0)) s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const userVersion = (s: Store) =>
  (s.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
const tables = (s: Store) =>
  (
    s.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
      name: string
    }[]
  ).map((r) => r.name)

describe('openStore', () => {
  it('creates the schema, WAL mode and foreign keys', async () => {
    const s = await open(join(tempDir(), 'nested', 'data'))
    expect(userVersion(s)).toBe(MIGRATIONS.at(-1)!.version)
    expect(tables(s)).toEqual(
      expect.arrayContaining(['audit_log', 'passkeys', 'recovery_codes', 'sessions', 'settings', 'users']),
    )
    expect((s.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal')
    expect((s.db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys).toBe(1)
  })

  it('is a no-op on reopen and makes no backup', async () => {
    const dir = tempDir()
    ;(await open(dir)).close()
    stores.length = 0
    await open(dir)
    expect(readdirSync(dir).filter((f) => f.includes('.bak-'))).toEqual([])
  })

  it('adds the jobs table to a version 4 database, after a backup (phase 1h)', async () => {
    const dir = tempDir()
    ;(
      await open(
        dir,
        MIGRATIONS.filter((m) => m.version <= 4),
      )
    ).close()
    stores.length = 0
    const s = await open(dir)
    expect(userVersion(s)).toBe(MIGRATIONS.at(-1)!.version)
    expect(tables(s)).toContain('jobs')
    expect(readdirSync(dir).filter((f) => f.startsWith(`${DB_FILE}.bak-v4`))).toHaveLength(1)
  })

  it('adds the saved pipelines table to a version 5 database, after a backup (phase 2a)', async () => {
    const dir = tempDir()
    ;(
      await open(
        dir,
        MIGRATIONS.filter((m) => m.version <= 5),
      )
    ).close()
    stores.length = 0
    const s = await open(dir)
    expect(userVersion(s)).toBe(MIGRATIONS.at(-1)!.version)
    expect(tables(s)).toContain('saved_pipelines')
    expect(readdirSync(dir).filter((f) => f.startsWith(`${DB_FILE}.bak-v5`))).toHaveLength(1)
  })

  it('adds history and favourites to a version 6 database, keeping recent queries for the keyed move (phase 2c)', async () => {
    const dir = tempDir()
    ;(
      await open(
        dir,
        MIGRATIONS.filter((m) => m.version <= 6),
      )
    ).close()
    stores.length = 0
    const s = await open(dir)
    expect(userVersion(s)).toBe(MIGRATIONS.at(-1)!.version)
    expect(tables(s)).toEqual(
      expect.arrayContaining([
        'query_history',
        'saved_queries',
        'recent_queries',
        'shell_history',
        'snippets',
      ]),
    )
    const columns = s.db.prepare('PRAGMA table_info(saved_pipelines)').all() as Array<{ name: string }>
    expect(columns.map((c) => c.name)).toContain('tags')
    // Phase 3a-1: the shell grant column.
    const grantCols = s.db.prepare('PRAGMA table_info(connection_grants)').all() as Array<{ name: string }>
    expect(grantCols.map((c) => c.name)).toContain('shell')
    expect(readdirSync(dir).filter((f) => f.startsWith(`${DB_FILE}.bak-v6`))).toHaveLength(1)
  })

  it('adds metric history to a version 10 database (phase 3b-2)', async () => {
    const dir = tempDir()
    ;(
      await open(
        dir,
        MIGRATIONS.filter((m) => m.version <= 10),
      )
    ).close()
    stores.length = 0
    const s = await open(dir)
    expect(userVersion(s)).toBe(MIGRATIONS.at(-1)!.version)
    expect(tables(s)).toEqual(expect.arrayContaining(['metric_history', 'metric_samples']))
  })

  it('adds transfer files, reports, presets and the export grant to a version 11 database (phase 3d-1)', async () => {
    const dir = tempDir()
    ;(
      await open(
        dir,
        MIGRATIONS.filter((m) => m.version <= 11),
      )
    ).close()
    stores.length = 0
    const s = await open(dir)
    expect(userVersion(s)).toBe(MIGRATIONS.at(-1)!.version)
    expect(tables(s)).toEqual(
      expect.arrayContaining(['transfer_files', 'transfer_reports', 'transfer_presets']),
    )
    const grantCols = s.db.prepare('PRAGMA table_info(connection_grants)').all() as Array<{ name: string }>
    expect(grantCols.map((c) => c.name)).toContain('export')
  })

  it('adds the second connection of a job and copy presets to a version 12 database (phase 3d-2)', async () => {
    const dir = tempDir()
    const old = await open(
      dir,
      MIGRATIONS.filter((m) => m.version <= 12),
    )
    old.db
      .prepare(
        `INSERT INTO transfer_presets (id, owner, kind, name, namespace, body, created_at, updated_at)
         VALUES ('p1', 'local', 'import', 'kept', NULL, 'sealed', 1, 1)`,
      )
      .run()
    old.close()
    stores.length = 0
    const s = await open(dir)
    expect(userVersion(s)).toBe(MIGRATIONS.at(-1)!.version)
    const jobCols = (s.db.prepare('PRAGMA table_info(jobs)').all() as Array<{ name: string }>).map(
      (c) => c.name,
    )
    expect(jobCols).toEqual(
      expect.arrayContaining(['target_connection_id', 'staging_connection_id', 'staging_db']),
    )
    expect(s.db.prepare("SELECT name, kind FROM transfer_presets WHERE id = 'p1'").get()).toEqual({
      name: 'kept',
      kind: 'import',
    })
    s.db
      .prepare(
        `INSERT INTO transfer_presets (id, owner, kind, name, namespace, body, created_at, updated_at)
         VALUES ('p2', 'local', 'copy', 'nightly', NULL, 'sealed', 1, 1)`,
      )
      .run()
    expect(() =>
      s.db
        .prepare(
          `INSERT INTO transfer_presets (id, owner, kind, name, namespace, body, created_at, updated_at)
           VALUES ('p3', 'local', 'bogus', 'x', NULL, 'sealed', 1, 1)`,
        )
        .run(),
    ).toThrow()
  })

  it('adds personal fields, the restricted grant and profiler reverts to a version 9 database (phase 3b)', async () => {
    const dir = tempDir()
    ;(
      await open(
        dir,
        MIGRATIONS.filter((m) => m.version <= 9),
      )
    ).close()
    stores.length = 0
    const s = await open(dir)
    expect(userVersion(s)).toBe(MIGRATIONS.at(-1)!.version)
    expect(tables(s)).toEqual(expect.arrayContaining(['personal_fields', 'profiler_reverts']))
    const grantCols = s.db.prepare('PRAGMA table_info(connection_grants)').all() as Array<{ name: string }>
    expect(grantCols.map((c) => c.name)).toContain('masked')
  })

  it('backs up the database before applying new migrations', async () => {
    const dir = tempDir()
    ;(await open(dir)).close()
    stores.length = 0
    const extra: Migration = { version: 999, name: 'extra', sql: 'CREATE TABLE extra (x INTEGER);' }
    const s = await open(dir, [...MIGRATIONS, extra])
    expect(userVersion(s)).toBe(999)
    expect(tables(s)).toContain('extra')
    expect(readdirSync(dir).filter((f) => f.startsWith(`${DB_FILE}.bak-v`))).toHaveLength(1)
  })

  it('rolls back a failing migration completely', async () => {
    const dir = tempDir()
    ;(await open(dir)).close()
    stores.length = 0
    const bad: Migration = {
      version: 999,
      name: 'bad',
      sql: 'CREATE TABLE half (x INTEGER); SELECT * FROM missing_table;',
    }
    await expect(openStore(dir, [...MIGRATIONS, bad])).rejects.toThrow(/migration 999/)
    const s = await open(dir)
    expect(userVersion(s)).toBe(MIGRATIONS.at(-1)!.version)
    expect(tables(s)).not.toContain('half')
  })

  it('refuses a database created by a newer version', async () => {
    const dir = tempDir()
    const s = await open(dir)
    s.db.exec('PRAGMA user_version = 5000')
    s.close()
    stores.length = 0
    await expect(openStore(dir)).rejects.toThrow(/newer/)
  })

  it('rejects unordered or duplicate migration lists', async () => {
    const m = (version: number): Migration => ({ version, name: `m${version}`, sql: 'SELECT 1;' })
    await expect(openStore(tempDir(), [m(2), m(1)])).rejects.toThrow(/ascending/)
    await expect(openStore(tempDir(), [m(1), m(1)])).rejects.toThrow(/ascending/)
  })
})

describe('audit_log is append-only (S18)', () => {
  it('rejects UPDATE and DELETE', async () => {
    const s = await open(tempDir())
    s.db.prepare("INSERT INTO audit_log (at, action, outcome) VALUES (?, 'x', 'success')").run(Date.now())
    expect(() => s.db.exec("UPDATE audit_log SET action = 'y'")).toThrow(/append-only/)
    expect(() => s.db.exec('DELETE FROM audit_log')).toThrow(/append-only/)
  })
})

describe('transaction', () => {
  it('commits on success and rolls back on error', async () => {
    const s = await open(tempDir())
    transaction(s.db, () => s.db.exec("INSERT INTO settings (key, value) VALUES ('a', '1')"))
    expect(() =>
      transaction(s.db, () => {
        s.db.exec("INSERT INTO settings (key, value) VALUES ('b', '2')")
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(s.db.prepare('SELECT key FROM settings ORDER BY key').all()).toEqual([{ key: 'a' }])
  })
})
