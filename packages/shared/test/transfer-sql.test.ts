// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { EXPORT_FORMATS, ExportRequestSchema, SqlExportRequestSchema, SqlImportRequestSchema } from '../src'

// User request 2026-10-10: SQL dumps imported, collections exported as SQL.
describe('SQL in the transfer requests', () => {
  it('exports as SQL with a dialect, a table, rows per INSERT and a transaction', () => {
    expect(EXPORT_FORMATS).toContain('sql')
    const req = ExportRequestSchema.parse({ source: { kind: 'collection' }, format: 'sql' })
    expect(req.sql).toEqual({ dialect: 'postgres', rowsPerInsert: 100, transaction: true, jsonAsText: false })
    const own = ExportRequestSchema.parse({
      source: { kind: 'collection' },
      format: 'sql',
      sql: { dialect: 'mysql', table: 'orders_2026', rowsPerInsert: 500, transaction: false },
    })
    expect(own.sql).toMatchObject({ dialect: 'mysql', table: 'orders_2026', rowsPerInsert: 500 })
  })

  it('refuses a SQL export it could not write safely', () => {
    const bad = (sql: object) =>
      ExportRequestSchema.safeParse({ source: { kind: 'collection' }, format: 'sql', sql }).success
    expect(bad({ dialect: 'oracle' })).toBe(false)
    expect(bad({ rowsPerInsert: 0 })).toBe(false)
    expect(bad({ rowsPerInsert: 1001 })).toBe(false)
    expect(bad({ table: '' })).toBe(false)
    expect(bad({ table: 'x'.repeat(129) })).toBe(false)
    expect(bad({ table: 'a\u0000b' })).toBe(false)
    // Review 2026-10-12 (M11): LONGTEXT for nested values is MySQL's only.
    expect(bad({ dialect: 'postgres', jsonAsText: true })).toBe(false)
    expect(bad({ dialect: 'sqlite', jsonAsText: true })).toBe(false)
    expect(bad({ dialect: 'mysql', jsonAsText: true })).toBe(true)
    expect(bad({ dialect: 'mysql', jsonAsText: 'yes' })).toBe(false)
    const sqlBody = (sql: object) =>
      SqlExportRequestSchema.safeParse({
        collections: ['a'],
        sql: { rowsPerInsert: 100, transaction: true, ...sql },
      }).success
    expect(sqlBody({ dialect: 'postgres', jsonAsText: true })).toBe(false)
    expect(sqlBody({ dialect: 'mysql', jsonAsText: true })).toBe(true)
    // A request from before the option (an older page, a stored job) still reads: without it, JSON.
    const old = SqlExportRequestSchema.parse({
      collections: ['a'],
      sql: { dialect: 'mysql', rowsPerInsert: 100, transaction: true },
    })
    expect(old.sql.jsonAsText).toBe(false)
  })

  it('imports chosen tables of a dump into collections, the primary key as _id by default', () => {
    const req = SqlImportRequestSchema.parse({
      uploadId: '3b241101-e2bb-4255-8caf-4136c566a962',
      tables: [
        { table: 'orders', collection: 'orders' },
        { table: 'audit_log', collection: 'audit', include: false },
      ],
    })
    expect(req).toMatchObject({ primaryKeyAsId: true, mode: 'insert', onError: 'continue', dryRun: false })
    expect(req.tables[0]!.include).toBe(true)
  })

  it('refuses an import of no table, of a collection name MongoDB refuses, or of a table twice', () => {
    const parse = (tables: object[]) =>
      SqlImportRequestSchema.safeParse({ uploadId: '3b241101-e2bb-4255-8caf-4136c566a962', tables }).success
    expect(parse([])).toBe(false)
    expect(parse([{ table: 'a', collection: 'system.users' }])).toBe(false)
    expect(parse([{ table: 'a', collection: '$x' }])).toBe(false)
    expect(
      parse([
        { table: 'a', collection: 'one' },
        { table: 'a', collection: 'two' },
      ]),
    ).toBe(false)
    // Two tables into one collection: allowed (a merge of like tables).
    expect(
      parse([
        { table: 'a', collection: 'one' },
        { table: 'b', collection: 'one' },
      ]),
    ).toBe(true)
  })
})
