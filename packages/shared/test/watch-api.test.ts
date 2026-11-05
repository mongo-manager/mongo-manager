// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import {
  DATA_OPS,
  MAX_WATCH_KEPT_BYTES,
  WATCH_OPS,
  WatchOptionsSchema,
  WatchTargetSchema,
} from '../src/index'

describe('Watch contracts (phase 3e-1 spec §1)', () => {
  it('defaults to the data changes, with before-images on and the rest off', () => {
    expect(WatchOptionsSchema.parse({})).toEqual({
      ops: [...DATA_OPS],
      fullDocument: false,
      schemaChanges: false,
      before: true,
      // W4.7: recording and the alert hook are asked for, never on by default.
      record: false,
      alert: false,
    })
    expect(WATCH_OPS).toContain('dropDatabase')
    expect(() => WatchOptionsSchema.parse({ ops: [] })).toThrow()
    expect(() => WatchOptionsSchema.parse({ ops: ['invalidate'] })).toThrow()
    expect(() => WatchOptionsSchema.parse({ extra: 1 })).toThrow()
  })

  it('takes a target whose database and collection match its scope', () => {
    expect(WatchTargetSchema.parse({ connectionId: 'c', scope: 'deployment' })).toEqual({
      connectionId: 'c',
      scope: 'deployment',
    })
    expect(
      WatchTargetSchema.parse({ connectionId: 'c', scope: 'collection', db: 'shop', coll: 'orders' }).coll,
    ).toBe('orders')
    for (const bad of [
      { connectionId: 'c', scope: 'collection', db: 'shop' },
      { connectionId: 'c', scope: 'database' },
      { connectionId: 'c', scope: 'database', db: 'shop', coll: 'orders' },
      { connectionId: 'c', scope: 'deployment', db: 'shop' },
      { connectionId: 'c', scope: 'database', db: 'a/b' },
    ])
      expect(() => WatchTargetSchema.parse(bad)).toThrow()
  })

  it('bounds what the web keeps in bytes as well as in events (final review I6)', () => {
    expect(MAX_WATCH_KEPT_BYTES).toBe(64 * 1024 * 1024)
  })
})
