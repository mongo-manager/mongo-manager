import { describe, expect, it } from 'vitest'
import {
  CollectionCopyRequestSchema,
  CompareRequestSchema,
  DatabaseCopyRequestSchema,
  JOB_KINDS,
  PresetSchema,
  RestoreRequestSchema,
  SyncRequestSchema,
} from '../src'

const HASH = 'a'.repeat(64)

describe('copy, compare and sync requests (phase 3d-2)', () => {
  it('knows the three new job kinds', () => {
    expect(JOB_KINDS).toEqual(expect.arrayContaining(['data.copy', 'data.compare', 'data.sync']))
  })

  it('parses a collection copy with its defaults', () => {
    const r = CollectionCopyRequestSchema.parse({
      source: { kind: 'collection' },
      target: { connectionId: 'c2', db: 'shop', coll: 'orders' },
      mode: 'insert',
      planHash: HASH,
    })
    expect(r).toMatchObject({
      keys: ['_id'],
      onError: 'continue',
      indexes: true,
      validator: true,
      options: true,
      anonymous: false,
      confirmPersonal: false,
      addRulesToTarget: false,
      confirmTtl: false,
      dryRun: false,
      updateOnly: false,
    })
  })

  // Sixteenth review of explain masking (P-1): a key is a field, never an operator.
  it('refuses a key that names an operator', () => {
    const body = {
      source: { kind: 'collection' },
      target: { connectionId: 'c2', db: 'shop', coll: 'orders' },
      mode: 'merge',
      planHash: HASH,
    }
    for (const key of [
      '$expr',
      'a.$where',
      '$or',
      'tags[0]',
      Array.from({ length: 33 }, () => 'a').join('.'),
    ])
      expect(CollectionCopyRequestSchema.safeParse({ ...body, keys: [key] }).success, key).toBe(false)
    expect(CollectionCopyRequestSchema.safeParse({ ...body, keys: ['a.b', 'c$'] }).success).toBe(true)
    expect(RestoreRequestSchema.shape.keys.safeParse(['$expr']).success).toBe(false)
  })

  it('refuses unknown fields, a bad mode, a bad target name and a bad hash', () => {
    const base = {
      source: { kind: 'collection' },
      target: { connectionId: 'c2', db: 'shop', coll: 'o' },
      mode: 'insert',
    }
    expect(() => CollectionCopyRequestSchema.parse({ ...base, extra: 1 })).toThrow()
    expect(() => CollectionCopyRequestSchema.parse({ ...base, mode: 'drop' })).toThrow()
    expect(() =>
      CollectionCopyRequestSchema.parse({ ...base, target: { connectionId: 'c2', db: 'a/b', coll: 'o' } }),
    ).toThrow()
    expect(() => CollectionCopyRequestSchema.parse({ ...base, planHash: 'zz' })).toThrow()
  })

  it('parses a database copy with a collection list of at most 1 000', () => {
    const r = DatabaseCopyRequestSchema.parse({
      target: { connectionId: 'c2', db: 'shop2' },
      mode: 'replace',
    })
    expect(r.views).toBe(true)
    expect(() =>
      DatabaseCopyRequestSchema.parse({
        target: { connectionId: 'c2', db: 'x' },
        mode: 'insert',
        collections: Array.from({ length: 1001 }, (_, i) => `c${i}`),
      }),
    ).toThrow()
  })

  it('parses compare and sync requests', () => {
    expect(CompareRequestSchema.parse({ target: { connectionId: 'c2', db: 'd', coll: 'c' } })).toEqual({
      target: { connectionId: 'c2', db: 'd', coll: 'c' },
      filter: {},
      ignore: [],
    })
    expect(SyncRequestSchema.parse({ compareJobId: '11111111-1111-4111-8111-111111111111' })).toEqual({
      compareJobId: '11111111-1111-4111-8111-111111111111',
      insert: true,
      replace: true,
      delete: false,
      confirmPersonal: false,
    })
  })

  it('takes copy presets', () => {
    expect(
      PresetSchema.parse({
        kind: 'copy',
        name: 'nightly',
        body: { mode: 'upsert', copy: { indexes: false } },
      }).kind,
    ).toBe('copy')
  })
})
