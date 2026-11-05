// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { holdsSecret, redactSecrets, MASK } from '../src/masking'

describe('redactSecrets (phase 3b §2.3, for everyone)', () => {
  it('hides secret-named keys at any depth and connection strings', () => {
    expect(
      redactSecrets({
        a: { pwd: 'p', Password: 'q', nested: [{ token: 't', accessToken: 'a' }] },
        key: 'k',
        uri: 'mongodb://user:secret@h:27017/db',
      }),
    ).toEqual({
      a: { pwd: MASK, Password: MASK, nested: [{ token: MASK, accessToken: MASK }] },
      key: MASK,
      uri: '[connection string]',
    })
  })

  it('tells whether a value holds anything it would hide (final review I1)', () => {
    expect(holdsSecret({ find: 'users', filter: { name: 'bob' } })).toBe(false)
    expect(holdsSecret({ find: 'users', filter: { password: 'x' } })).toBe(true)
    expect(holdsSecret({ find: 'users', comment: 'mongodb://u:p@h' })).toBe(true)
    expect(holdsSecret({ distinct: 'users', key: 'email' })).toBe(false)
  })

  it('hides the whole body of user and authentication commands', () => {
    expect(redactSecrets({ createUser: 'bob', pwd: 'p', roles: ['r'] })).toEqual({ createUser: MASK })
    expect(redactSecrets({ saslStart: 1, payload: 'x' })).toEqual({ saslStart: MASK })
  })
})
