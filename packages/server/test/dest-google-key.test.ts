// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { parseServiceAccountKey } from '../src/backup/destinations/google-auth'
import { DestinationError } from '../src/backup/destinations/types'

/**
 * Short names review 7 (M-1): a service account key that cannot be read is a credential that is not
 * valid, not Google's refusal — the editor said "Google refused" and gave the fix for a refusal,
 * though Google was never asked.
 */
describe('a service account key that cannot be read', () => {
  it.each([
    ['not JSON', '{ nope'],
    ['not a service account key', JSON.stringify({ type: 'authorized_user' })],
  ])('is refused as a credential not valid: %s', (_, text) => {
    let got: unknown
    try {
      parseServiceAccountKey(text)
    } catch (e) {
      got = e
    }
    expect(got).toBeInstanceOf(DestinationError)
    expect((got as DestinationError).reason).toBe('secrets_invalid')
  })
})
