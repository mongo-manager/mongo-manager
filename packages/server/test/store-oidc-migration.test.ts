// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { MIGRATIONS } from '../src/store/migrations'
import { openStore } from '../src/store/db'

/**
 * W7 × W4 (merge): migration 41 (people's OIDC tokens) after W4's 38–40 and its record of applied
 * migrations. A store on main's 40 runs it once and records it; a store from before the record that
 * says 41 without the table (a build of another branch) runs it too; one that has it does not.
 */
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const dir = () => {
  const d = mkdtempSync(join(tmpdir(), 'mm-mig-oidc-'))
  dirs.push(d)
  return d
}
const hasTokens = (db: DatabaseSync) =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'oidc_tokens'").get() !== undefined
const recorded = (db: DatabaseSync) =>
  (
    db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>
  ).map((r) => r.version)

describe('the OIDC tokens migration (41) with the record of applied migrations', () => {
  it('comes right after W4’s three, numbered in order', () => {
    expect(MIGRATIONS.find((m) => m.name === 'oidc_tokens')?.version).toBe(41)
    expect(MIGRATIONS.find((m) => m.version === 40)?.name).toBe('transfer-files-growing-w4')
  })

  it('runs on a store at main’s 40, and is recorded once', async () => {
    const d = dir()
    const first = await openStore(
      d,
      MIGRATIONS.filter((m) => m.version <= 40),
    )
    expect(hasTokens(first.db)).toBe(false)
    first.close()
    const s = await openStore(d)
    expect(hasTokens(s.db)).toBe(true)
    expect(recorded(s.db).filter((v) => v === 41)).toEqual([41])
    s.close()
    const again = await openStore(d)
    expect(recorded(again.db).filter((v) => v === 41)).toEqual([41])
    again.close()
  })

  it('runs on a store from before the record that says 41 but lacks the table', async () => {
    const d = dir()
    const s = await openStore(d)
    s.db.exec('DROP TABLE oidc_tokens; DROP TABLE schema_migrations')
    s.close()
    const again = await openStore(d)
    expect(hasTokens(again.db)).toBe(true)
    expect(recorded(again.db)).toContain(41)
    again.close()
  })

  it('knows its own change: a store that has the table takes it as applied', async () => {
    const d = dir()
    const s = await openStore(d)
    expect(MIGRATIONS.find((m) => m.version === 41)!.applied?.(s.db)).toBe(true)
    s.db.exec('DROP TABLE schema_migrations')
    s.close()
    const again = await openStore(d)
    expect(recorded(again.db)).toContain(41)
    again.close()
  })
})
