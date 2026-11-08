// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { laterVersion } from '../src/backup/archive-reader'
import { headerUnreadable, metadataTooLarge } from '../src/backup/dump-plan'
import { MAX_METADATA_BYTES } from '../src/backup/limits'

/**
 * Fourth to sixth reviews of the CI fixes: what a backup's reader would refuse is refused before the
 * backup is written, and a header made by a later Mongo Manager is said as that, never as damage.
 */
const header = (over: object = {}) => ({
  tool: 'mongo-manager 2.0.0',
  scope: null,
  masked: true,
  anonymous: false,
  maskedPaths: ['shop.users.email'],
  rules: [{ db: 'shop', coll: 'users', field: 'email' }],
  startedAt: 0,
  ...over,
})

describe('the limits a backup is planned within', () => {
  it('refuses a header past its reader: by its schema, or by its size though the schema takes it', () => {
    expect(headerUnreadable(header(), '8.0.32')).toBe(false)
    expect(
      headerUnreadable(header({ maskedPaths: Array.from({ length: 100_001 }, () => 'a') }), '8.0.32'),
    ).toBe(true)
    // Valid paths (at most 2048 characters, at most 100 000 of them), past the size together.
    const long = 'p'.repeat(2_000)
    const count = Math.ceil(MAX_METADATA_BYTES / long.length)
    expect(count).toBeLessThan(100_000)
    expect(
      headerUnreadable(header({ maskedPaths: Array.from({ length: count }, () => long) }), '8.0.32'),
    ).toBe(true)
  })

  it('refuses namespace metadata past what the reader takes in all', () => {
    const meta = (i: number) => ({
      db: 'shop',
      coll: `c${i}`,
      type: 'collection' as const,
      options: { validator: { $jsonSchema: { description: 'v'.repeat(4_000) } } },
      indexes: [{ v: 2, key: { _id: 1 }, name: '_id_' }],
    })
    expect(metadataTooLarge(Array.from({ length: 10 }, (_, i) => meta(i)))).toBe(false)
    const many = Math.ceil(MAX_METADATA_BYTES / 4_000) + 10
    expect(metadataTooLarge(Array.from({ length: many }, (_, i) => meta(i)))).toBe(true)
  })
})

describe('a header made by a later Mongo Manager', () => {
  it('is told by its numbers, then a release over its prerelease, then the later prerelease', () => {
    expect(laterVersion('mongo-manager 2.0.1', '2.0.0')).toBe('2.0.1')
    expect(laterVersion('mongo-manager 3.0.0', '2.9.9')).toBe('3.0.0')
    expect(laterVersion('mongo-manager 2.1.0', '2.1.0-rc.1')).toBe('2.1.0')
    expect(laterVersion('mongo-manager 2.1.0-rc.2', '2.1.0-rc.1')).toBe('2.1.0-rc.2')
    expect(laterVersion('mongo-manager 2.1.0-rc.10', '2.1.0-rc.9')).toBe('2.1.0-rc.10')
    for (const [tool, version] of [
      ['mongo-manager 2.0.0', '2.0.0'],
      ['mongo-manager 1.9.9', '2.0.0'],
      ['mongo-manager 2.1.0-rc.1', '2.1.0'],
      ['mongo-manager 2.1.0-rc.1', '2.1.0-rc.2'],
      ['other 9.0.0', '2.0.0'],
      ['mongo-manager x', '2.0.0'],
      [undefined, '2.0.0'],
    ] as const)
      expect(laterVersion(tool, version), `${tool} ${version}`).toBeNull()
  })
})
