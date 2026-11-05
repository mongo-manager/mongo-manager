// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig } from '../src/config'
import { openStore } from '../src/store/db'
import { MIGRATIONS } from '../src/store/migrations'
import { backupLimits } from '../src/backup/limits'

describe('scheduling settings (phase 3d-3c spec §3.2)', () => {
  it('reads MM_BACKUP_SCHEDULES and MM_BACKUP_SCHEDULE_CONCURRENCY within bounds', () => {
    expect(resolveConfig({}).backup).toMatchObject({ schedules: true, scheduleConcurrency: 2 })
    const c = resolveConfig({ env: { MM_BACKUP_SCHEDULES: '0', MM_BACKUP_SCHEDULE_CONCURRENCY: '8' } })
    expect(c.backup).toMatchObject({ schedules: false, scheduleConcurrency: 8 })
    expect(backupLimits(c)).toMatchObject({ schedules: false, scheduleConcurrency: 8 })
    expect(() => resolveConfig({ env: { MM_BACKUP_SCHEDULE_CONCURRENCY: '9' } })).toThrow()
    expect(() => resolveConfig({ env: { MM_BACKUP_SCHEDULE_CONCURRENCY: '0' } })).toThrow()
    expect(() => resolveConfig({ env: { MM_BACKUP_SCHEDULES: 'maybe' } })).toThrow(/MM_BACKUP_SCHEDULES/)
  })
})

describe('migration 16 (phase 3d-3c spec §3.1)', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })
  const open = async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-m16-'))
    dirs.push(dir)
    return openStore(dir)
  }

  it('creates the key, schedule and run tables, and the schedule columns', async () => {
    const store = await open()
    try {
      expect(MIGRATIONS.find((m) => m.version === 16)).toMatchObject({ name: 'backup-schedules' })
      const tables = (
        store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
          name: string
        }>
      ).map((t) => t.name)
      expect(tables).toEqual(
        expect.arrayContaining(['backup_keys', 'backup_schedules', 'backup_schedule_runs']),
      )
      const cols = (table: string) =>
        (store.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name)
      expect(cols('backups')).toContain('schedule_id')
      expect(cols('backup_remote_copies')).toContain('schedule_id')
    } finally {
      store.close()
    }
  })

  it('allows one active key per owner, one fingerprint per owner, and one run per due time', async () => {
    const store = await open()
    try {
      const key = store.db.prepare(
        "INSERT INTO backup_keys (id, owner, name, fingerprint, state, sealed_key, created_at) VALUES (?, ?, 'K', ?, ?, 'x', 1)",
      )
      key.run('k1', 'u1', 'K-00000001', 'active')
      key.run('k2', 'u1', 'K-00000002', 'retired')
      expect(() => key.run('k3', 'u1', 'K-00000003', 'active')).toThrow(/UNIQUE/)
      key.run('k4', 'u2', 'K-00000004', 'active')
      expect(() => key.run('k5', 'u1', 'K-00000001', 'retired')).toThrow(/UNIQUE/)
      expect(() => key.run('k6', 'u1', 'K-00000006', 'lost')).toThrow(/CHECK/)
      // The connection foreign key is checked elsewhere; here only the run table's own rules.
      store.db.exec('PRAGMA foreign_keys = OFF')
      store.db
        .prepare(
          `INSERT INTO backup_schedules (id, owner, connection_id, name, request, format, key_id, cadence, time_zone,
            destinations, keep_on_server, retention, state, created_at, updated_at)
           VALUES ('s1', 'u1', 'c1', 'S', '{}', 'mmbak', 'k1', '{}', 'UTC', '[]', 0, '{}', 'active', 1, 1)`,
        )
        .run()
      const run = store.db.prepare(
        "INSERT INTO backup_schedule_runs (id, schedule_id, due_at, kind) VALUES (?, 's1', 1000, 'scheduled')",
      )
      run.run('r1')
      expect(() => run.run('r2')).toThrow(/UNIQUE/)
    } finally {
      store.close()
    }
  })
})
