// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { CollectionNameSchema, DatabaseNameSchema, PaginationSchema, UsernameSchema } from '../src/schemas'

describe('schemas', () => {
  it('accepts valid database names and rejects invalid ones', () => {
    for (const ok of ['shop', 'my_db-1', 'çağrı']) expect(DatabaseNameSchema.safeParse(ok).success).toBe(true)
    for (const bad of ['', 'a/b', 'a.b', 'a b', 'a$b', 'a"b', 'x'.repeat(64), 'a\0b']) {
      expect(DatabaseNameSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
  })

  it('accepts hostile-looking but valid collection names and rejects invalid ones', () => {
    for (const ok of ['users', 'a.b.c', '<img src=x onerror=alert(1)>', 'system.views']) {
      expect(CollectionNameSchema.safeParse(ok).success, ok).toBe(true)
    }
    for (const bad of ['', 'a$b', 'a\0b', 'x'.repeat(256)]) {
      expect(CollectionNameSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
  })

  it('coerces and bounds pagination', () => {
    expect(PaginationSchema.parse({})).toEqual({ page: 1, pageSize: 20 })
    expect(PaginationSchema.parse({ page: '3', pageSize: '50' })).toEqual({ page: 3, pageSize: 50 })
    for (const bad of [
      { page: '0' },
      { page: '-1' },
      { page: 'abc' },
      { pageSize: '1001' },
      { page: '1.5' },
    ]) {
      expect(PaginationSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
  })
})

describe('UsernameSchema', () => {
  it('accepts simple usernames and rejects others', () => {
    for (const ok of ['bob', 'alice.smith', 'ops_team-1', 'A'.repeat(64)])
      expect(UsernameSchema.safeParse(ok).success, ok).toBe(true)
    for (const bad of ['ab', 'A'.repeat(65), 'with space', 'ümit', 'a/b', '<script>']) {
      expect(UsernameSchema.safeParse(bad).success, bad).toBe(false)
    }
  })
})
