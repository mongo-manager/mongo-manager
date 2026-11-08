// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { answerFor } from '../src/answer'

/** Plugins wave 3 (spec §8a): the date answers once — in the tooltip, or beside it if set. */
const DATE = { $date: { $numberLong: String(Date.UTC(2026, 9, 26, 11, 3, 12)) } }
const NOW = Date.UTC(2026, 9, 27, 11, 3, 12)

describe('a date cell’s answer', () => {
  it('comes from the tooltip renderer unless the settings put it beside the value', () => {
    const utc = { timeZone: 'UTC' }
    expect(answerFor('tip', DATE, 'en', utc, NOW)).toMatchObject({
      tone: 'neutral',
      text: expect.stringContaining('(UTC)'),
    })
    expect(answerFor('beside', DATE, 'en', utc, NOW)).toBeNull()
    const beside = { ...utc, beside: true }
    expect(answerFor('beside', DATE, 'en', beside, NOW)).not.toBeNull()
    expect(answerFor('tip', DATE, 'en', beside, NOW)).toBeNull()
  })

  it('adds the relative time when set, and says nothing of what is no date', () => {
    expect(answerFor('tip', DATE, 'en', { timeZone: 'UTC', relative: true }, NOW)!.text).toMatch(
      /· yesterday$/,
    )
    expect(answerFor('tip', 'x', 'en', {}, NOW)).toBeNull()
    // A setting of the wrong kind is no setting.
    expect(answerFor('tip', DATE, 'en', { timeZone: true, relative: 'yes' }, NOW)!.text).not.toContain('·')
  })
})
