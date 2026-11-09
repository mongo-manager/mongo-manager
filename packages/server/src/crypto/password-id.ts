// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { randomBytes, scrypt } from 'node:crypto'

/**
 * Code scanning 2026-11-05 (js/insufficient-password-hash, high): what an in-memory cache keys a
 * password by — a backup's opened key, a connection's salted SCRAM password. A password hash, not a
 * fast one: scrypt, salted with a secret this process makes and never shows, so a key read out of
 * memory is as hard to guess from as a stored hash, and says nothing about the password elsewhere.
 * Small (4 MB, a few milliseconds): it runs where the cache is asked, which saves a far slower one.
 * The password is taken as given: a caller that normalizes it does so first.
 */
const SECRET = randomBytes(32)
const COST = { N: 2 ** 12, r: 8, p: 1 } as const

export function passwordId(password: string): Promise<string> {
  return new Promise((resolve, reject) =>
    scrypt(password, SECRET, 32, COST, (err, key) =>
      err ? reject(err) : resolve(key.toString('base64url')),
    ),
  )
}
