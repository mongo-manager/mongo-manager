// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { dummyHash, hashPassword, passwordProblems, verifyPassword } from '../src/auth/passwords'

describe('password hashing', () => {
  it('hashes with argon2id in PHC format and verifies', async () => {
    const hash = await hashPassword('correct horse battery staple')
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/)
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true)
    expect(await verifyPassword('correct horse battery stapl', hash)).toBe(false)
  })

  it('salts every hash', async () => {
    expect(await hashPassword('same password 123')).not.toBe(await hashPassword('same password 123'))
  })

  it('supports the scrypt fallback', async () => {
    const hash = await hashPassword('correct horse battery staple', { algorithm: 'scrypt' })
    expect(hash).toMatch(/^\$scrypt\$ln=17,r=8,p=1\$/)
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true)
    expect(await verifyPassword('wrong', hash)).toBe(false)
  })

  it('returns false (never throws) for malformed stored hashes', async () => {
    for (const bad of ['', 'plain', '$argon2id$v=19$m=1$x$y', '$md5$abc', '$scrypt$ln=99,r=8,p=1$a$b']) {
      expect(await verifyPassword('x', bad), bad).toBe(false)
    }
  })

  it('provides a stable dummy hash for timing equalisation', async () => {
    expect(await dummyHash()).toBe(await dummyHash())
    expect(await verifyPassword('anything', await dummyHash())).toBe(false)
  })
})

describe('passwordProblems', () => {
  it('accepts a strong password', () => {
    expect(passwordProblems('tarçın-kavanoz-42-mavi', 'alice')).toEqual([])
  })

  it('enforces length, username, common passwords and repetition', () => {
    expect(passwordProblems('short1')).toContain('must be at least 12 characters')
    expect(passwordProblems('x'.repeat(1025))).toContain('must be at most 1024 characters')
    expect(passwordProblems('alice-rocks-2026', 'Alice')).toContain('must not contain the username')
    expect(passwordProblems('password1234')).toContain('is too common')
    expect(passwordProblems('aaaaaaaaaaaaaa')).toContain('must not repeat a single character')
  })
})
