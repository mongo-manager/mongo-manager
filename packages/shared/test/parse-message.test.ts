// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { QueryParseError, parseQueryObject } from '../src'

describe('syntax error messages', () => {
  it('drop acorn’s "(line:column)" suffix; the position is carried separately', () => {
    let error: unknown
    try {
      parseQueryObject('{ a: }')
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(QueryParseError)
    expect((error as QueryParseError).message).not.toMatch(/\(\d+:\d+\)$/)
    expect((error as QueryParseError).column).toBe(6)
  })
})
