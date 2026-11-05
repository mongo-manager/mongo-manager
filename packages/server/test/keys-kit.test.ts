// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import {
  KitError,
  backupKeyFingerprint,
  kitCheckGroup,
  kitFileName,
  kitLine,
  kitText,
  parseKit,
} from '../src/backup/keys/kit'

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const reason = (text: string): string => {
  try {
    parseKit(text)
    return 'ok'
  } catch (e) {
    expect(e).toBeInstanceOf(KitError)
    return (e as KitError).reason
  }
}
const regroup = (chars: string) => `MMKEY1-${chars.match(/.{4}/g)!.join('-')}`

describe('recovery kits (phase 3d-3c spec §1.1, plan ruling 7, D7)', () => {
  it('round-trips a key through its line and its whole text', () => {
    for (let i = 0; i < 50; i++) {
      const key = randomBytes(32)
      const line = kitLine(key)
      expect(line).toMatch(/^MMKEY1(-[0-9A-HJKMNP-TV-Z]{4}){14}$/)
      expect(line.endsWith(kitCheckGroup(key))).toBe(true)
      expect(parseKit(line)).toEqual(key)
      const text = kitText({
        host: 'mm.example.com',
        username: 'alice',
        name: 'Key 1',
        fingerprint: backupKeyFingerprint(key),
        createdAt: Date.UTC(2026, 9, 4),
        key,
      })
      expect(parseKit(text)).toEqual(key)
    }
  })

  it('reads a kit typed by hand: lower case, spaces, O for 0, I or L for 1', () => {
    const key = randomBytes(32)
    const body = kitLine(key)
      .slice(7)
      .toLowerCase()
      .replaceAll('-', ' ')
      .replaceAll('0', 'o')
      .replaceAll('1', 'l')
    expect(parseKit(`mmkey1-${body}`)).toEqual(key)
  })

  it('names every malformed form (D7)', () => {
    const key = randomBytes(32)
    const line = kitLine(key)
    const chars = line.slice(7).replaceAll('-', '')
    expect(reason('')).toBe('kit_format')
    expect(reason('hello')).toBe('kit_format')
    expect(reason(line.slice(0, -1))).toBe('kit_format')
    expect(reason(`${line}A`)).toBe('kit_format')
    expect(reason(regroup(`UUUU${chars.slice(4)}`))).toBe('kit_format')
    expect(reason('x'.repeat(8193))).toBe('kit_format')
    // A changed character in the key fails the checksum.
    const swapped = chars[2] === 'A' ? 'B' : 'A'
    expect(reason(regroup(chars.slice(0, 2) + swapped + chars.slice(3)))).toBe('kit_checksum')
    // The four padding bits after the 256 key bits must be zero.
    const v = ALPHABET.indexOf(chars[51]!)
    expect(reason(regroup(chars.slice(0, 51) + ALPHABET[v ^ 1]! + chars.slice(52)))).toBe('kit_format')
  })

  it('never puts the key in an error message (D1)', () => {
    const key = randomBytes(32)
    const line = kitLine(key)
    for (const bad of [line.slice(0, -2), `${line.slice(0, -4)}ZZZZ`])
      try {
        parseKit(bad)
      } catch (e) {
        expect((e as Error).message).not.toContain(line.slice(7, 30))
      }
  })

  it('writes the kit with what helps a person find the key again, on clean lines', () => {
    const key = randomBytes(32)
    const text = kitText({
      host: 'mm.example.com\u0007',
      username: 'alice\nMMKEY1-AAAA',
      name: 'Key 1',
      fingerprint: backupKeyFingerprint(key),
      createdAt: Date.UTC(2026, 9, 4),
      key,
    })
    expect(text).toContain('Installation: mm.example.com')
    expect(text).toContain(`Fingerprint:  ${backupKeyFingerprint(key)}`)
    expect(text).toContain('Created:      2026-10-04')
    expect(text).toContain('mongo-manager backup decrypt')
    expect(text).not.toContain('\u0007')
    expect(text.split('\n').filter((l) => l.startsWith('User:'))).toHaveLength(1)
    // The one key line is the kit's own, whatever a name holds.
    expect(text.match(/MMKEY1-/g)).toHaveLength(1)
    expect(parseKit(text)).toEqual(key)
    expect(backupKeyFingerprint(key)).toMatch(/^K-[0-9a-f]{8}$/)
    expect(kitFileName('K-1a2b3c4d')).toBe('mongo-manager-backup-key-K-1a2b3c4d.txt')
  })
})
