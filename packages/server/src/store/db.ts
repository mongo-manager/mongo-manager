// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { chmodSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync, backup } from 'node:sqlite'
import { MIGRATIONS } from './migrations'
import { ensureDataDir } from './datadir'

export interface Migration {
  version: number
  name: string
  sql: string
  /**
   * W4 re-review 2 (minor): whether the migration's change is there, where that is cheap to tell. A
   * store moved to the record of applied migrations takes every version up to its own as applied —
   * except one that says its change is missing (a build of another branch numbered past it): that
   * one runs.
   */
  applied?: (db: DatabaseSync) => boolean
  /**
   * W4.5: the migration rebuilds a table other tables point at (to change its CHECK). It runs with
   * foreign keys off — a DROP TABLE would otherwise cascade the rows pointing at it away — and every
   * key is checked before it commits (SQLite's documented procedure for such changes).
   */
  foreignKeysOff?: true
  /**
   * W4 review (minor): the tables the migration rebuilds. The keys checked before it commits are
   * theirs and those of the tables pointing at them — another table's old rows are not its to fail
   * on — and the error names them.
   */
  rebuilt?: readonly string[]
}

/** The rows of the rebuilt tables, and of the tables pointing at them, that point at nothing. */
function brokenKeys(db: DatabaseSync, rebuilt: readonly string[]): string[] {
  const tables = (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{
      name: string
    }>
  ).map((t) => t.name)
  const pointing = tables.filter(
    (t) =>
      rebuilt.includes(t) ||
      (db.prepare(`PRAGMA foreign_key_list(${JSON.stringify(t)})`).all() as Array<{ table: string }>).some(
        (k) => rebuilt.includes(k.table),
      ),
  )
  const found = new Set<string>()
  for (const t of pointing)
    for (const row of db.prepare(`PRAGMA foreign_key_check(${JSON.stringify(t)})`).all() as Array<{
      table: string
      parent: string
    }>)
      found.add(`${row.table} → ${row.parent}`)
  return [...found]
}

export interface Store {
  readonly db: DatabaseSync
  readonly path: string
  close(): void
}

export const DB_FILE = 'mongo-manager.db'

export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

/** The store holds password hashes and sealed secrets: keep it private to the service user (POSIX). */
export function restrictPermissions(dataDir: string, files: string[]): void {
  if (process.platform === 'win32') return
  chmodSync(dataDir, 0o700)
  for (const file of files) if (existsSync(file)) chmodSync(file, 0o600)
}

const currentVersion = (db: DatabaseSync): number =>
  (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version

function assertOrdered(migrations: readonly Migration[]) {
  migrations.forEach((m, i) => {
    const prev = migrations[i - 1]
    if (m.version < 1 || (prev && m.version <= prev.version)) {
      throw new Error('Migrations must have strictly ascending positive versions')
    }
  })
}

export async function openStore(
  dataDir: string,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<Store> {
  assertOrdered(migrations)
  ensureDataDir(dataDir)
  const path = join(dataDir, DB_FILE)
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
    const current = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    const latest = migrations.at(-1)?.version ?? 0
    if (current > latest) {
      throw new Error(
        `Database schema version ${current} is newer than this Mongo Manager supports (${latest}). Upgrade Mongo Manager.`,
      )
    }
    // W4 re-review I3: which migrations ran is recorded one by one, so one of a lower number that
    // arrives after a higher one ran (branches merged in another order) still runs. A store made before
    // this record takes every version up to its own as applied (it ran them in order).
    const tracked = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
      .get()
    if (!tracked)
      // W4 re-review 2 (minor): made and filled at once, or not at all.
      transaction(db, () => {
        db.exec(
          'CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)',
        )
        const mark = db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        for (const m of migrations)
          if (m.version <= current && (m.applied?.(db) ?? true)) mark.run(m.version, m.name, Date.now())
      })
    const applied = new Set(
      (db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map(
        (r) => r.version,
      ),
    )
    const pending = migrations.filter((m) => !applied.has(m.version))
    if (pending.length > 0 && current > 0) {
      const backupPath = `${path}.bak-v${current}-${Date.now()}`
      await backup(db, backupPath)
      restrictPermissions(dataDir, [backupPath])
    }
    for (const m of pending) {
      // Outside the transaction: SQLite ignores this pragma inside one.
      if (m.foreignKeysOff) db.exec('PRAGMA foreign_keys = OFF')
      try {
        transaction(db, () => {
          db.exec(m.sql)
          if (m.foreignKeysOff) {
            const broken = m.rebuilt
              ? brokenKeys(db, m.rebuilt)
              : (
                  db.prepare('PRAGMA foreign_key_check').all() as Array<{ table: string; parent: string }>
                ).map((r) => `${r.table} → ${r.parent}`)
            if (broken.length)
              throw new Error(`rows point at nothing after the rebuild: ${[...new Set(broken)].join(', ')}`)
          }
          db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
            m.version,
            m.name,
            Date.now(),
          )
          db.exec(`PRAGMA user_version = ${Math.max(m.version, currentVersion(db))}`)
        })
      } catch (e) {
        throw new Error(`Database migration ${m.version} (${m.name}) failed: ${(e as Error).message}`, {
          cause: e,
        })
      } finally {
        if (m.foreignKeysOff) db.exec('PRAGMA foreign_keys = ON')
      }
    }
  } catch (e) {
    db.close()
    throw e
  }
  restrictPermissions(dataDir, [path, `${path}-wal`, `${path}-shm`])
  return { db, path, close: () => db.close() }
}
