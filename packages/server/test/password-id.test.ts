// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { passwordId } from '../src/crypto/password-id'

// Code scanning 2026-11-05 (js/insufficient-password-hash, high): a cache keys a password by a
// password hash under a secret of this process, never by a fast hash of it.
describe('the id a cache keys a password by', () => {
  it('is the same for the same password, and another for another', async () => {
    expect(await passwordId('correct horse')).toBe(await passwordId('correct horse'))
    expect(await passwordId('correct horse')).not.toBe(await passwordId('correct horsf'))
  })

  it('is no fast hash of the password, and takes the password as given', async () => {
    const id = await passwordId('correct horse')
    for (const digest of ['sha256', 'sha512', 'md5'])
      expect(id).not.toBe(createHash(digest).update('correct horse').digest('base64url'))
    expect(await passwordId('é')).not.toBe(await passwordId('é'))
  })

  it('is what the backup key cache and the SCRAM cache key passwords by', () => {
    for (const file of ['../src/backup/mmbak.ts', '../src/shell/proxy/scram.ts']) {
      const source = readFileSync(join(import.meta.dirname, file), 'utf8')
      expect(source, file).toContain('passwordId(')
      expect(source, file).not.toMatch(/create(?:Hash|Hmac)\([^)]*\)\.update\(password/)
    }
  })
})
