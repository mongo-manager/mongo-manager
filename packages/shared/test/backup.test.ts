// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import {
  BackupScopeSchema,
  DumpRequestSchema,
  DumpStartSchema,
  JOB_KINDS,
  RestoreRequestSchema,
  RestoreStartSchema,
  InspectRequestSchema,
  BackupUploadCreateSchema,
  MongoManagerHeaderSchema,
} from '../src/browser'

const HASH = 'a'.repeat(64)
const ID = '11111111-1111-4111-8111-111111111111'

describe('backup requests (phase 3d-3a)', () => {
  it('knows the two job kinds', () => {
    expect(JOB_KINDS).toContain('backup.dump')
    expect(JOB_KINDS).toContain('backup.restore')
  })

  it('takes the three scopes and refuses system and odd names', () => {
    expect(BackupScopeSchema.parse({ kind: 'collection', db: 'shop', coll: 'orders' })).toEqual({
      kind: 'collection',
      db: 'shop',
      coll: 'orders',
    })
    expect(BackupScopeSchema.parse({ kind: 'database', db: 'shop' })).toEqual({
      kind: 'database',
      db: 'shop',
      views: true,
    })
    expect(BackupScopeSchema.parse({ kind: 'server' })).toEqual({ kind: 'server' })
    for (const bad of [
      { kind: 'collection', db: 'shop', coll: 'system.users' },
      { kind: 'collection', db: 'shop', coll: 'a$b' },
      { kind: 'collection', db: 'sh.op', coll: 'x' },
      { kind: 'collection', db: 'shop', coll: 'a\u0000b' },
      { kind: 'database', db: 'a/b' },
      { kind: 'server', databases: [] },
    ])
      expect(BackupScopeSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
  })

  it('defaults a dump to the built-in engine and an encrypted file, its part size left to the server', () => {
    // Final review minor 2: no part size means the server's MM_BACKUP_CHUNK_MB.
    expect(DumpRequestSchema.parse({ scope: { kind: 'server' } })).toEqual({
      scope: { kind: 'server' },
      engine: 'builtin',
      indexes: true,
      options: true,
      anonymous: false,
      format: 'mmbak',
      // Phase 3d-3b: no destinations unless chosen.
      destinations: [],
      deleteLocal: false,
    })
    expect(DumpRequestSchema.parse({ scope: { kind: 'server' }, chunkMb: 128 }).chunkMb).toBe(128)
    expect(DumpRequestSchema.safeParse({ scope: { kind: 'server' }, chunkMb: 48 }).success).toBe(false)
  })

  it('needs a password of 12+ characters exactly for an encrypted dump', () => {
    const base = { scope: { kind: 'server' }, planHash: HASH }
    expect(DumpStartSchema.safeParse({ ...base }).success).toBe(false)
    expect(DumpStartSchema.safeParse({ ...base, password: 'short' }).success).toBe(false)
    expect(DumpStartSchema.safeParse({ ...base, password: 'correct horse battery' }).success).toBe(true)
    expect(
      DumpStartSchema.safeParse({ ...base, format: 'gzip', password: 'correct horse battery' }).success,
    ).toBe(false)
    expect(DumpStartSchema.safeParse({ ...base, format: 'archive' }).success).toBe(true)
  })

  it('parses a restore with a mapping and refuses system targets', () => {
    const ok = RestoreRequestSchema.parse({
      source: { kind: 'upload', uploadId: ID },
      mapping: [{ from: { db: 'shop', coll: 'orders' }, to: { db: 'shop2', coll: 'orders' } }],
    })
    expect(ok).toMatchObject({
      mode: 'insert',
      keys: ['_id'],
      indexes: true,
      options: true,
      engine: 'builtin',
      onError: 'continue',
      confirmTtl: false,
      confirmPersonal: false,
      confirmMasked: false,
      addRulesToTarget: false,
      confirmNames: [],
      dryRun: false,
    })
    for (const to of [
      { db: 'admin', coll: 'x' },
      { db: 'local', coll: 'x' },
      { db: 'config', coll: 'x' },
      { db: 'shop', coll: 'system.views' },
    ])
      expect(
        RestoreRequestSchema.safeParse({
          source: { kind: 'backup', backupId: ID },
          mapping: [{ from: { db: 'shop', coll: 'orders' }, to }],
        }).success,
        JSON.stringify(to),
      ).toBe(false)
    expect(
      RestoreStartSchema.safeParse({
        source: { kind: 'backup', backupId: ID },
        mapping: [{ from: { db: 'a', coll: 'b' }, to: { db: 'a', coll: 'b' } }],
      }).success,
    ).toBe(false)
  })

  it('takes inspections, uploads and the Mongo Manager header', () => {
    expect(InspectRequestSchema.parse({ source: { kind: 'upload', uploadId: ID } })).toEqual({
      source: { kind: 'upload', uploadId: ID },
    })
    expect(BackupUploadCreateSchema.safeParse({ name: 'x.archive', size: 0 }).success).toBe(false)
    expect(
      MongoManagerHeaderSchema.safeParse({
        tool: 'mongo-manager 2.0.0',
        scope: { kind: 'server' },
        masked: true,
        anonymous: false,
        maskedPaths: ['shop.orders.email'],
        rules: [{ db: 'shop', coll: 'orders', field: 'email' }],
        startedAt: 1,
      }).success,
    ).toBe(true)
    expect(MongoManagerHeaderSchema.safeParse({ tool: 'x', masked: 'yes' }).success).toBe(false)
  })
})
