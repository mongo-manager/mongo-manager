// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { idText, imageFields, imagesIn, pageFilter } from '../src/images'

/** Plugins wave 3 (spec §8): the images a document holds, and the pages of a collection's. */
const PNG_B64 = btoa(
  String.fromCharCode(
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    0,
    0,
    0,
    13,
    73,
    72,
    68,
    82,
    0,
    0,
    0,
    2,
    0,
    0,
    0,
    3,
    8,
  ),
)
const GIF_B64 = btoa('GIF89a\u0004\u0000\u0005\u0000\u0000')
const bin = (base64: string, subType = '00') => ({ $binary: { base64, subType } })

describe('the images a document holds', () => {
  const doc = {
    _id: { $oid: '65a1b2c3d4e5f60718293a01' },
    avatar: bin(PNG_B64),
    photos: [bin(GIF_B64), bin(btoa('%PDF-1.7'))],
    profile: { banner: bin(PNG_B64) },
    token: bin('AAAAAAAAAAAAAAAAAAAAAA==', '04'),
    note: 'x',
  }

  it('finds each image with its place, type, size and length — never a UUID or another file', () => {
    expect(imagesIn(doc)).toEqual([
      { path: 'avatar', kind: 'png', mime: 'image/png', base64: PNG_B64, length: 25, width: 2, height: 3 },
      { path: 'photos.0', kind: 'gif', mime: 'image/gif', base64: GIF_B64, length: 11, width: 4, height: 5 },
      {
        path: 'profile.banner',
        kind: 'png',
        mime: 'image/png',
        base64: PNG_B64,
        length: 25,
        width: 2,
        height: 3,
      },
    ])
    expect(imagesIn({ a: '***', b: null })).toEqual([])
    // A UUID (or an old one) is an id, whatever its bytes look like.
    expect(imagesIn({ u: bin(PNG_B64, '04'), old: bin(PNG_B64, '03') })).toEqual([])
  })

  it('names the top-level fields that held images, to read only those', () => {
    expect(imageFields([doc, { _id: 1, cover: bin(GIF_B64) }])).toEqual([
      'avatar',
      'photos',
      'profile',
      'cover',
    ])
    expect(imageFields([{ _id: 1, note: 'x' }])).toEqual([])
  })
})

describe('a page of a collection’s images', () => {
  it('goes on after the last _id, within the Documents filter', () => {
    const later = (types: string[]) => ({ _id: { $type: types } })
    // No page shown yet.
    expect(pageFilter({}, undefined)).toEqual({})
    expect(pageFilter({}, { $oid: 'a' })).toEqual({
      $or: [{ _id: { $gt: { $oid: 'a' } } }, later(['bool', 'date', 'timestamp', 'regex', 'maxKey'])],
    })
    expect(pageFilter({ status: 'x' }, { $oid: 'a' })).toEqual({
      $and: [
        { status: 'x' },
        { $or: [{ _id: { $gt: { $oid: 'a' } } }, later(['bool', 'date', 'timestamp', 'regex', 'maxKey'])] },
      ],
    })
  })

  // Wave 3 review: "$gt" compares within one kind of value only — past the last string, a
  // collection's ObjectIds were never reached.
  it('goes on to the _ids of the kinds MongoDB sorts after the last one shown', () => {
    const next = (after: unknown) =>
      (pageFilter({}, after) as { $or: Array<{ _id: { $type?: string[] } }> }).$or[1]!._id.$type
    const ALL_AFTER_NUMBERS = [
      'string',
      'symbol',
      'object',
      'binData',
      'objectId',
      'bool',
      'date',
      'timestamp',
      'regex',
      'maxKey',
    ]
    expect(next(5)).toEqual(ALL_AFTER_NUMBERS)
    expect(next({ $numberLong: '5' })).toEqual(ALL_AFTER_NUMBERS)
    expect(next('a')).toEqual(ALL_AFTER_NUMBERS.slice(2))
    expect(next({ a: 1 })).toEqual(ALL_AFTER_NUMBERS.slice(3))
    expect(next({ $binary: { base64: '', subType: '00' } })).toEqual(ALL_AFTER_NUMBERS.slice(4))
    expect(next({ $uuid: '00000000-0000-0000-0000-000000000000' })).toEqual(ALL_AFTER_NUMBERS.slice(4))
    expect(next(true)).toEqual(ALL_AFTER_NUMBERS.slice(6))
    expect(next({ $date: { $numberLong: '0' } })).toEqual(ALL_AFTER_NUMBERS.slice(7))
    // A null _id is a value, sorted before every number: never the start again.
    expect(next(null)).toEqual(['number', ...ALL_AFTER_NUMBERS])
    // After the last kind: only $gt.
    expect(pageFilter({}, { $maxKey: 1 })).toEqual({ _id: { $gt: { $maxKey: 1 } } })
  })

  it('says an _id as the app would', () => {
    expect(idText({ $oid: '65a1b2c3d4e5f60718293a01' })).toBe('65a1b2c3d4e5f60718293a01')
    expect(idText({ $numberInt: '7' })).toBe('7')
    expect(idText('a')).toBe('a')
    expect(idText({ a: 1 })).toBe('{"a":1}')
  })
})
