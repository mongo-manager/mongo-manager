// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import * as crypto from 'node:crypto'
import { promisify } from 'node:util'
import { accountPasswordProblems, type PasswordProblem } from '@mongo-manager/shared'

const ARGON2 = { memory: 19456, passes: 2, parallelism: 1, tagLength: 32 } as const
const SCRYPT = { ln: 17, r: 8, p: 1, keylen: 32 } as const
const SALT_BYTES = 16

const scryptAsync = promisify(crypto.scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: crypto.ScryptOptions,
) => Promise<Buffer>

type Argon2Fn = (
  algorithm: 'argon2id',
  params: {
    message: string
    nonce: Buffer
    parallelism: number
    tagLength: number
    memory: number
    passes: number
  },
  callback: (err: Error | null, result: Buffer) => void,
) => void

const argon2Fn = (crypto as unknown as { argon2?: Argon2Fn }).argon2

function argon2Async(password: string, salt: Buffer, m: number, t: number, p: number, tagLength: number) {
  return new Promise<Buffer>((resolve, reject) => {
    if (!argon2Fn) return reject(new Error('argon2 is not available in this Node.js version'))
    argon2Fn(
      'argon2id',
      { message: password, nonce: salt, parallelism: p, tagLength, memory: m, passes: t },
      (err, out) => (err ? reject(err) : resolve(out)),
    )
  })
}

const b64 = (buf: Buffer) => buf.toString('base64').replace(/=+$/, '')
const unb64 = (text: string) => Buffer.from(text, 'base64')

export async function hashPassword(
  password: string,
  opts: { algorithm?: 'argon2id' | 'scrypt' } = {},
): Promise<string> {
  const algorithm = opts.algorithm ?? (argon2Fn ? 'argon2id' : 'scrypt')
  const salt = crypto.randomBytes(SALT_BYTES)
  if (algorithm === 'argon2id') {
    const hash = await argon2Async(
      password,
      salt,
      ARGON2.memory,
      ARGON2.passes,
      ARGON2.parallelism,
      ARGON2.tagLength,
    )
    return `$argon2id$v=19$m=${ARGON2.memory},t=${ARGON2.passes},p=${ARGON2.parallelism}$${b64(salt)}$${b64(hash)}`
  }
  const hash = await scryptAsync(password, salt, SCRYPT.keylen, scryptOptions(SCRYPT.ln, SCRYPT.r, SCRYPT.p))
  return `$scrypt$ln=${SCRYPT.ln},r=${SCRYPT.r},p=${SCRYPT.p}$${b64(salt)}$${b64(hash)}`
}

function scryptOptions(ln: number, r: number, p: number): crypto.ScryptOptions {
  const N = 2 ** ln
  return { N, r, p, maxmem: 128 * N * r * p + 32 * 1024 * 1024 }
}

const ARGON2_RE = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/
const SCRYPT_RE = /^\$scrypt\$ln=(\d+),r=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    let expected: Buffer
    let actual: Buffer
    const a = ARGON2_RE.exec(stored)
    const s = a ? null : SCRYPT_RE.exec(stored)
    if (a) {
      const [, m, t, p, salt, hash] = a
      expected = unb64(hash!)
      if (Number(m) > 1_048_576 || Number(t) > 10 || Number(p) > 16) return false
      actual = await argon2Async(password, unb64(salt!), Number(m), Number(t), Number(p), expected.length)
    } else if (s) {
      const [, ln, r, p, salt, hash] = s
      if (Number(ln) > 20 || Number(r) > 16 || Number(p) > 4) return false
      expected = unb64(hash!)
      actual = await scryptAsync(
        password,
        unb64(salt!),
        expected.length,
        scryptOptions(Number(ln), Number(r), Number(p)),
      )
    } else {
      return false
    }
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

let dummy: Promise<string> | undefined
/** A real hash of a random password; verifying against it costs the same as a real login (no user enumeration). */
export function dummyHash(): Promise<string> {
  dummy ??= hashPassword(crypto.randomBytes(24).toString('base64'))
  return dummy
}

const PROBLEMS: Record<PasswordProblem, string> = {
  too_short: 'must be at least 12 characters',
  too_long: 'must be at most 1024 characters',
  contains_username: 'must not contain the username',
  too_common: 'is too common',
  repeated_char: 'must not repeat a single character',
  too_predictable: 'is too easy to guess (a sequence, a keyboard row, a repeat or a common word)',
}
export type { PasswordProblem }

/**
 * Policy problems as codes, so clients can explain them in the user's language. Password strength
 * (2026-10-28): the rules are shared with the browser's meter, so the two never disagree.
 */
export function passwordProblemCodes(password: string, username?: string): PasswordProblem[] {
  return accountPasswordProblems(password, username)
}

export function passwordProblems(password: string, username?: string): string[] {
  return passwordProblemTexts(passwordProblemCodes(password, username))
}

/** The problems' English texts, from codes already found (final review M6: one estimate a request). */
export function passwordProblemTexts(codes: readonly PasswordProblem[]): string[] {
  return codes.map((code) => PROBLEMS[code])
}
