// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  accountPasswordCheck,
  accountPasswordProblems,
  accountPasswordStrength,
  estimatePasswordBits,
  isEasyToGuess,
} from '../src/password-policy'

/** Password strength (2026-10-28): the account password rules and meter, the same in browser and server. */
describe('accountPasswordProblems', () => {
  it('accepts passphrases and long random passwords', () => {
    for (const p of [
      'tarçın-kavanoz-42-mavi',
      'correct-horse-battery-1',
      'a-long-password-1',
      'Xk9#mQ2$vL7!pR4w',
      'kahve bardağı mavi deniz',
      // The end-to-end tests' accounts.
      'ai-mate-password-1',
      'amber-willow-orchid-73',
      'cedar-meadow-quartz-58',
      'example-app-password',
      'plug-reader-password-1',
      'required-viewer-password-3',
      'second-admin-password-2',
      'viewer-password-1',
      'violet-harbour-quartz-58',
    ])
      expect(accountPasswordProblems(p, 'alice'), p).toEqual([])
  })

  it('keeps the earlier rules, by code', () => {
    expect(accountPasswordProblems('short1')).toContain('too_short')
    expect(accountPasswordProblems('x'.repeat(1025))).toContain('too_long')
    expect(accountPasswordProblems('alice-rocks-2026', 'Alice')).toContain('contains_username')
    expect(accountPasswordProblems('password1234')).toContain('too_common')
    expect(accountPasswordProblems('aaaaaaaaaaaaaa')).toContain('repeated_char')
  })

  it('refuses long passwords that are still easy to guess', () => {
    for (const p of [
      '234567890123',
      '1234567890abc',
      'abcabcabcabc',
      'qwertyuiopasdf',
      'Password1234!',
      'P@ssw0rd2026!',
      'aaaabbbbcccc',
      '987654321098',
      'admin2026admin',
      'asdfghjklasdfgh',
    ])
      expect(accountPasswordProblems(p), p).toContain('too_predictable')
  })

  it('gives each problem once, too short before too predictable', () => {
    expect(accountPasswordProblems('1234')).toEqual(['too_short'])
    expect(accountPasswordProblems('')).toEqual(['too_short'])
  })
})

describe('accountPasswordStrength', () => {
  it('scores from very weak to very strong, by how guessable the password is', () => {
    expect(accountPasswordStrength('').score).toBe(0)
    expect(accountPasswordStrength('123456789012').level).toBe('veryWeak')
    expect(accountPasswordStrength('a1b9c3x4e5f7').score).toBeGreaterThanOrEqual(1)
    expect(accountPasswordStrength('correct-horse-battery-1').level).toBe('veryStrong')
    const levels = [
      'abcdefgh',
      'mavi-kedi-42',
      'mavi-kedi-42-uzun-yol',
      'mavi-kedi-42-uzun-yol-Xk9#mQ2$',
    ].map((p) => accountPasswordStrength(p).score)
    expect([...levels].sort((a, b) => a - b)).toEqual(levels)
    expect(levels[0]).toBeLessThan(levels[3]!)
  })

  it('counts the username, common words, years and keyboard rows as cheap', () => {
    const plain = accountPasswordStrength('zebra-lamba-9')
    expect(accountPasswordStrength('alice-lamba-9', 'alice').bits).toBeLessThan(plain.bits)
    expect(accountPasswordStrength('admin-lamba-9').bits).toBeLessThan(plain.bits)
    expect(accountPasswordStrength('qwert-lamba-9').bits).toBeLessThan(plain.bits)
    expect(accountPasswordStrength('defgh-lamba-9').bits).toBeLessThan(plain.bits)
    expect(accountPasswordStrength('lamba-2026-9').bits).toBeLessThan(
      accountPasswordStrength('lamba-7fq2-9').bits,
    )
  })

  it('is very weak whenever a rule refuses the password', () => {
    for (const p of ['short1', 'password1234', 'aaaaaaaaaaaaaa'])
      expect(accountPasswordStrength(p).level, p).toBe('veryWeak')
    expect(accountPasswordStrength('alice-rocks-and-rolls-2026', 'alice').level).toBe('veryWeak')
  })

  it('takes a long password in reasonable time', () => {
    const started = performance.now()
    accountPasswordStrength('ab'.repeat(512))
    accountPasswordStrength('x9#'.repeat(340))
    expect(performance.now() - started).toBeLessThan(500)
  })
})

describe('isEasyToGuess', () => {
  it('judges guessability alone, whatever the length', () => {
    expect(isEasyToGuess('abc')).toBe(true)
    // On the common list, though it looks random.
    expect(isEasyToGuess('1q2w3e4r5t6y')).toBe(true)
    // Runs of the alphabet, either way.
    expect(isEasyToGuess('lmnopqrstuvw')).toBe(true)
    expect(isEasyToGuess('zyxwvutsrqpo')).toBe(true)
    expect(isEasyToGuess('password1234')).toBe(true)
    expect(isEasyToGuess('aaaaaaaaaaaaaa')).toBe(true)
    expect(isEasyToGuess('qwertyuiopasdf')).toBe(true)
    expect(isEasyToGuess('Xk9#mQ2$')).toBe(false)
    expect(isEasyToGuess('correct-horse-battery-1')).toBe(false)
  })
})

describe('the final review', () => {
  const predictable = (p: string) => expect(accountPasswordProblems(p), p).toContain('too_predictable')

  it('knows the Shift row and the Turkish and column walks (I1)', () => {
    for (const p of ['!@#$%^&*()_+', 'Qwerty!@#$%^', '1qaz!QAZ2wsx@WSX', "!'^+%&/()=?!"]) predictable(p)
  })

  it('knows two runs woven together (I2)', () => {
    for (const p of ['a1b2c3d4e5f6', '1a2b3c4d5e6f', 'f6e5d4c3b2a1']) predictable(p)
  })

  it('knows reversed words, names, Turkish words and look-alikes either way (M1)', () => {
    for (const p of [
      'drowssap2026',
      'Ahmet1234567',
      'ga1atasaray1905',
      'he11o-he11o!',
      'askim2026askim',
      'sevgilim1234',
    ])
      predictable(p)
  })

  it('counts characters as the user sees them, on the composed form (M5)', () => {
    // Six emoji are six characters, not twelve.
    expect(accountPasswordProblems('🐶🍕🚀🌈🎸🦊')).toEqual(['too_short'])
    expect(accountPasswordCheck('🐶🍕🚀🌈🎸🦊🐶🍕🚀🌈🎸🦊').rules.length).toBe(true)
    // The same word typed decomposed reads the same.
    const composed = 'şifre2026şifre'
    const decomposed = composed.normalize('NFD')
    expect(decomposed).not.toBe(composed)
    expect(accountPasswordCheck(decomposed)).toEqual(accountPasswordCheck(composed))
    predictable(composed)
    // A dotted capital I, a dotless i and a lone surrogate change nothing about the indexes.
    predictable('İSTANBUL2026!!')
    predictable('ıstanbul19531953')
    expect(() => accountPasswordCheck('abc\uD800def-ghi-jkl')).not.toThrow()
  })

  it('gives the meter the rules exactly as the server refuses', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), fc.option(fc.string({ maxLength: 8 })), (p, user) => {
        const check = accountPasswordCheck(p, user ?? undefined)
        const allMet = check.rules.length && check.rules.username && check.rules.guessable
        expect(allMet).toBe(check.problems.length === 0)
        expect(check.strength.score === 0).toBe(check.problems.length > 0)
      }),
      { numRuns: 500 },
    )
  })

  it('says too long apart from too short', () => {
    expect(accountPasswordCheck('x9#'.repeat(400))).toMatchObject({ tooLong: true, rules: { length: false } })
    expect(accountPasswordCheck('x9#')).toMatchObject({ tooLong: false, rules: { length: false } })
  })

  it('stays fast on the longest and most repetitive inputs (M6)', () => {
    let seed = 7
    const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31
    const noise = Array.from({ length: 1024 }, () =>
      String.fromCharCode(33 + Math.floor(random() * 94)),
    ).join('')
    for (const p of [
      'ab'.repeat(512),
      'a'.repeat(1024),
      '1qaz'.repeat(256),
      'abcdefghij'.repeat(102),
      'passwordpassword'.repeat(64),
      'a1b2'.repeat(256),
      ('ab'.repeat(16) + 'x').repeat(31),
      noise,
    ]) {
      const started = performance.now()
      accountPasswordCheck(p, 'someone')
      expect(performance.now() - started, p.slice(0, 12)).toBeLessThan(250)
    }
  })

  it('lends its estimate to the other meters', () => {
    expect(estimatePasswordBits('Password1234!')).toBeLessThan(30)
    expect(estimatePasswordBits('correct-horse-battery-1')).toBeGreaterThan(100)
  })
})
