// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { EMPTY_SHA256, canonicalQuery, canonicalUri, signRequest } from '../src/backup/destinations/s3-sign'

const credentials = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
}
const now = new Date(Date.UTC(2013, 4, 24))
const sig = (h: Record<string, string>) => /Signature=([0-9a-f]{64})$/.exec(h.authorization!)![1]
const sign = (method: string, url: string, headers: Record<string, string>, payloadHash: string) =>
  signRequest({ method, url: new URL(url), headers, payloadHash, region: 'us-east-1', now, credentials })

describe('SigV4 (phase 3d-3b spec §2.3) — AWS published S3 examples', () => {
  it('GET object with a range', () => {
    const h = sign(
      'GET',
      'https://examplebucket.s3.amazonaws.com/test.txt',
      { Range: 'bytes=0-9' },
      EMPTY_SHA256,
    )
    expect(sig(h)).toBe('f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41')
    expect(h.authorization).toContain('SignedHeaders=host;range;x-amz-content-sha256;x-amz-date')
    expect(h['x-amz-date']).toBe('20130524T000000Z')
  })

  it('PUT object with a payload and an encoded key', () => {
    const body = 'Welcome to Amazon S3.'
    const h = sign(
      'PUT',
      'https://examplebucket.s3.amazonaws.com/test$file.text',
      { Date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' },
      createHash('sha256').update(body).digest('hex'),
    )
    expect(sig(h)).toBe('98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd')
  })

  it('GET bucket lifecycle (a key-only query)', () => {
    expect(sig(sign('GET', 'https://examplebucket.s3.amazonaws.com/?lifecycle', {}, EMPTY_SHA256))).toBe(
      'fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543',
    )
  })

  it('GET bucket listing with sorted query parameters', () => {
    expect(
      sig(sign('GET', 'https://examplebucket.s3.amazonaws.com/?prefix=J&max-keys=2', {}, EMPTY_SHA256)),
    ).toBe('34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7')
  })

  it('encodes paths and queries once, RFC 3986 style', () => {
    expect(canonicalUri('/a%20b/c+d/e~f')).toBe('/a%20b/c%2Bd/e~f')
    expect(canonicalQuery(new URLSearchParams('b=2&a=1&a=0&c=x y'))).toBe('a=0&a=1&b=2&c=x%20y')
  })
})
