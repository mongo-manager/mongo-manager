// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import * as main from '../src/index'
import * as browser from '../src/browser'

describe('package entries', () => {
  it('the main entry re-exports everything the browser entry offers (they cannot drift)', () => {
    for (const [name, value] of Object.entries(browser))
      expect(main[name as keyof typeof main], name).toBe(value)
  })
})
