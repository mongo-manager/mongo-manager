// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { hmacSha256, sha256, toHex } from '../src/hash'

/** Plugins wave 4 (spec §1): the consistent hash's SHA-256 and HMAC, against the published vectors. */
const utf8 = (s: string) => new TextEncoder().encode(s)

describe('SHA-256', () => {
  it('gives the published digests, over one block and several', () => {
    expect(toHex(sha256(utf8('')))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(toHex(sha256(utf8('abc')))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
    expect(toHex(sha256(utf8('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')))).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    )
    expect(toHex(sha256(utf8('a'.repeat(1000))))).toBe(
      '41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3',
    )
  })
})

describe('HMAC-SHA256', () => {
  it('gives the published codes, a long key hashed first', () => {
    expect(toHex(hmacSha256(utf8('key'), utf8('The quick brown fox jumps over the lazy dog')))).toBe(
      'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8',
    )
    // RFC 4231 test case 6: a 131-byte key.
    expect(
      toHex(
        hmacSha256(
          new Uint8Array(131).fill(0xaa),
          utf8('Test Using Larger Than Block-Size Key - Hash Key First'),
        ),
      ),
    ).toBe('60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54')
  })
})
