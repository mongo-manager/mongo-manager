// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { binaryAnswer, bytesOfBase64, sizeText, sniff } from '../src/sniff'

/**
 * Plugins wave 3 (spec §8): what a binary value holds, told from its first bytes — an image's kind
 * and size, a document, an archive — or its subtype and length.
 */
const bytes = (...parts: Array<number[] | string>) =>
  new Uint8Array(parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)))
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
const le16 = (n: number) => [n & 255, (n >>> 8) & 255]
const le32 = (n: number) => [...le16(n & 0xffff), ...le16(n >>> 16)]
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u))

const PNG = bytes(
  [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  be32(13),
  'IHDR',
  be32(320),
  be32(200),
  [8, 6, 0, 0, 0],
)
const GIF = bytes('GIF89a', le16(64), le16(48), [0, 0, 0])
const BMP = bytes('BM', le32(1000), [0, 0, 0, 0], le32(54), le32(40), le32(30), le32(20))
const JPEG = bytes(
  [0xff, 0xd8, 0xff, 0xe0],
  [0x00, 0x10],
  'JFIF\0',
  [1, 1, 0, 0, 1, 0, 1, 0, 0],
  [0xff, 0xc0, 0x00, 0x11, 0x08],
  [0x01, 0xe0],
  [0x02, 0x80],
  [3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1],
)
const WEBP_VP8X = bytes('RIFF', le32(100), 'WEBP', 'VP8X', le32(10), [0, 0, 0, 0], [99, 0, 0], [49, 0, 0])

describe('what a binary value holds', () => {
  it('knows images and their size', () => {
    expect(sniff(PNG)).toEqual({ kind: 'png', mime: 'image/png', image: true, width: 320, height: 200 })
    expect(sniff(GIF)).toMatchObject({ kind: 'gif', image: true, width: 64, height: 48 })
    expect(sniff(BMP)).toMatchObject({ kind: 'bmp', image: true, width: 30, height: 20 })
    expect(sniff(JPEG)).toMatchObject({
      kind: 'jpeg',
      mime: 'image/jpeg',
      image: true,
      width: 640,
      height: 480,
    })
    expect(sniff(WEBP_VP8X)).toMatchObject({ kind: 'webp', image: true, width: 100, height: 50 })
    expect(sniff(bytes('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toMatchObject(
      {
        kind: 'svg',
        mime: 'image/svg+xml',
        image: true,
      },
    )
    // A JPEG whose size marker is past the bytes read: an image all the same, its size unknown.
    expect(sniff(bytes([0xff, 0xd8, 0xff, 0xe1, 0x40, 0x00]))).toEqual({
      kind: 'jpeg',
      mime: 'image/jpeg',
      image: true,
    })
  })

  // Wave 3 review: what the sniffer took for what it is not.
  it('takes for a BMP only what has a BMP header, for an SVG only a document whose root is <svg>', () => {
    expect(sniff(bytes('BMW is a car, not a bitmap image'))).toEqual({ kind: 'unknown', image: false })
    expect(sniff(bytes('BM', le32(1000), [0, 0, 0, 0], le32(26), le32(12), le16(16), le16(9)))).toMatchObject(
      {
        kind: 'bmp',
        width: 16,
        height: 9,
      },
    )
    // A byte order mark before it.
    expect(sniff(bytes([0xef, 0xbb, 0xbf], '<svg xmlns="http://www.w3.org/2000/svg"/>'))).toMatchObject({
      kind: 'svg',
      image: true,
    })
    // Comments and a doctype before it.
    expect(
      sniff(bytes('<?xml version="1.0"?>\n<!-- made by hand -->\n<!DOCTYPE svg [ <!ENTITY a "b"> ]>\n<svg>')),
    ).toMatchObject({ kind: 'svg' })
    // A web page holding an <svg> is no SVG image, nor is <svgfoo>.
    expect(sniff(bytes('<!DOCTYPE html><html><body><svg></svg></body></html>'))).toEqual({
      kind: 'unknown',
      image: false,
    })
    expect(sniff(bytes('<!-- <svg> --><html></html>'))).toEqual({ kind: 'unknown', image: false })
    expect(sniff(bytes('<svgfoo>'))).toEqual({ kind: 'unknown', image: false })
  })

  // Wave 3 second review: a doctype whose subset ends "] >", and OS/2 bitmaps.
  it('reads a doctype whose internal subset ends with a space before ">", and an OS/2 bitmap', () => {
    expect(sniff(bytes('<!DOCTYPE svg [ <!ENTITY a "b"> ] >\n<svg>'))).toMatchObject({ kind: 'svg' })
    expect(sniff(bytes('<!DOCTYPE svg [\n<!ENTITY a "b">\n]\n>\n<svg>'))).toMatchObject({ kind: 'svg' })
    // OS/2 2.x with its short (16-byte) header: 32-bit sizes as Windows' 40-byte one.
    const os2 = bytes('BM', le32(1000), [0, 0, 0, 0], le32(30), le32(16), le32(12), le32(8), [0, 0, 0, 0])
    expect(sniff(os2)).toMatchObject({ kind: 'bmp', image: true, width: 12, height: 8 })
    // OS/2 2.x with its full (64-byte) header.
    const os2Full = bytes('BM', le32(1000), [0, 0, 0, 0], le32(78), le32(64), le32(7), le32(5), [0, 0, 0, 0])
    expect(sniff(os2Full)).toMatchObject({ kind: 'bmp', width: 7, height: 5 })
  })

  it('tells the files of the ISO family apart by their brand', () => {
    const ftyp = (brand: string, ...compatible: string[]) =>
      bytes(be32(16 + compatible.length * 4), 'ftyp', brand, [0, 0, 0, 0], ...compatible)
    // Wave 3 review: a browser draws an AVIF picture, so the gallery shows it.
    expect(sniff(ftyp('avif', 'mif1'))).toMatchObject({ kind: 'avif', mime: 'image/avif', image: true })
    expect(sniff(ftyp('mif1', 'avif'))).toMatchObject({ kind: 'avif' })
    expect(sniff(ftyp('heic', 'mif1'))).toMatchObject({ kind: 'heic', image: false })
    expect(sniff(ftyp('mif1', 'heic'))).toMatchObject({ kind: 'heic' })
    // An AVIF picture sequence, and a bare HEIF picture (mif1 with nothing else said).
    expect(sniff(ftyp('avis', 'msf1'))).toMatchObject({ kind: 'avif', mime: 'image/avif', image: true })
    expect(sniff(ftyp('mif1'))).toMatchObject({ kind: 'heic', image: false })
    expect(sniff(ftyp('qt  '))).toMatchObject({ kind: 'mov', image: false })
    expect(sniff(ftyp('3gp5', 'isom'))).toMatchObject({ kind: '3gp', image: false })
    expect(sniff(ftyp('M4A ', 'isom'))).toMatchObject({ kind: 'm4a', image: false })
    expect(sniff(ftyp('isom', 'mp41'))).toMatchObject({ kind: 'mp4', image: false })
    expect(
      binaryAnswer({ $binaryHead: { base64: b64(ftyp('heic')), subType: '00', length: 2048 } }, 'en'),
    ).toEqual({ text: 'HEIC image · 2 KB', tone: 'info' })
    expect(
      binaryAnswer({ $binaryHead: { base64: b64(ftyp('qt  ')), subType: '00', length: 2048 } }, 'tr'),
    ).toEqual({ text: 'QuickTime videosu · 2 KB', tone: 'info' })
  })

  it('knows documents, archives and media that are not drawn', () => {
    expect(sniff(bytes('%PDF-1.7'))).toMatchObject({ kind: 'pdf', image: false })
    expect(sniff(bytes('PK', [3, 4]))).toMatchObject({ kind: 'zip', image: false })
    expect(sniff(bytes([0x1f, 0x8b, 8]))).toMatchObject({ kind: 'gzip', image: false })
    expect(sniff(bytes('ID3', [4, 0]))).toMatchObject({ kind: 'mp3', image: false })
    expect(sniff(bytes([0, 0, 0, 0x20], 'ftypisom'))).toMatchObject({ kind: 'mp4', image: false })
    expect(sniff(bytes('II*', [0]))).toMatchObject({ kind: 'tiff', image: false })
    expect(sniff(bytes('hello'))).toEqual({ kind: 'unknown', image: false })
    expect(sniff(new Uint8Array())).toEqual({ kind: 'unknown', image: false })
  })

  it('says a size in the reader’s language', () => {
    expect(sizeText(512, 'en')).toBe('512 bytes')
    expect(sizeText(24 * 1024, 'en')).toBe('24 KB')
    expect(sizeText(1.5 * 1024 * 1024, 'tr')).toBe('1,5 MB')
    expect(sizeText(1, 'tr')).toBe('1 bayt')
  })
})

describe('a binary cell’s answer', () => {
  const head = (u: Uint8Array, length = u.length, subType = '00') => ({
    $binaryHead: { base64: b64(u), subType, length },
  })

  it('says the kind, the size in pixels and the length, in the app’s language', () => {
    expect(binaryAnswer(head(PNG, 24 * 1024), 'en')).toEqual({
      text: 'PNG image · 320 × 200 · 24 KB',
      tone: 'info',
    })
    expect(binaryAnswer(head(PNG, 24 * 1024), 'tr')).toEqual({
      text: 'PNG görseli · 320 × 200 · 24 KB',
      tone: 'info',
    })
    expect(binaryAnswer(head(bytes('%PDF-1.7'), 2048), 'en')!.text).toBe('PDF document · 2 KB')
  })

  it('says the subtype and length of what it does not know, and nothing of what is no binary head', () => {
    expect(binaryAnswer(head(bytes('hello'), 5, '05'), 'en')).toEqual({
      text: 'Binary · subtype 05 · 5 bytes',
      tone: 'neutral',
    })
    expect(binaryAnswer(head(bytes('hello'), 5, '80'), 'tr')!.text).toBe('İkili veri · alt tür 80 · 5 bayt')
    for (const v of [
      'x',
      null,
      { $binary: { base64: 'AA==', subType: '00' } },
      { $binaryHead: { base64: '%%', subType: '00', length: 1 } },
    ])
      expect(binaryAnswer(v, 'en'), JSON.stringify(v)).toBeNull()
  })

  it('reads base64 that is cut short, as a head may be', () => {
    expect(bytesOfBase64(b64(PNG).slice(0, 12))).toEqual(PNG.slice(0, 9))
    expect(bytesOfBase64('not base64!')).toBeNull()
  })
})
