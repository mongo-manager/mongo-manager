// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
/**
 * What a file's first bytes say it is, for a preview (user request 2026-10-10): the raster images,
 * sounds and videos a browser shows safely. Never the type it was stored with — a file named
 * `photo.png` holding HTML is no image — and never markup (SVG, HTML): those are shown as text.
 */
export interface MediaType {
  type: string
  kind: 'image' | 'audio' | 'video'
}

const at = (b: Buffer, offset: number, text: string) =>
  b.length >= offset + text.length && b.toString('latin1', offset, offset + text.length) === text

export function sniffMedia(b: Buffer): MediaType | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return { type: 'image/png', kind: 'image' }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)
    return { type: 'image/jpeg', kind: 'image' }
  if (at(b, 0, 'GIF87a') || at(b, 0, 'GIF89a')) return { type: 'image/gif', kind: 'image' }
  if (at(b, 0, 'RIFF') && at(b, 8, 'WEBP')) return { type: 'image/webp', kind: 'image' }
  if (at(b, 0, 'RIFF') && at(b, 8, 'WAVE')) return { type: 'audio/wav', kind: 'audio' }
  if (at(b, 4, 'ftyp') && b.length >= 12) {
    const brand = b.toString('latin1', 8, 12)
    // The major brand, or one of the compatible brands after it (an AVIF may say "mif1" first).
    const box = Math.min(b.readUInt32BE(0), b.length, 256)
    const brands = [brand]
    for (let o = 16; o + 4 <= box; o += 4) brands.push(b.toString('latin1', o, o + 4))
    if (brands.includes('avif') || brands.includes('avis')) return { type: 'image/avif', kind: 'image' }
    if (brand === 'M4A ' || brand === 'M4B ') return { type: 'audio/mp4', kind: 'audio' }
    // HEIC and other image brands are no video; browsers show none of them.
    if (['heic', 'heix', 'mif1', 'msf1', 'hevc', 'crx '].includes(brand)) return null
    return { type: 'video/mp4', kind: 'video' }
  }
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3)
    return { type: 'video/webm', kind: 'video' }
  if (at(b, 0, 'ID3') || (b.length >= 2 && b[0] === 0xff && [0xfb, 0xf3, 0xf2, 0xfa].includes(b[1]!)))
    return { type: 'audio/mpeg', kind: 'audio' }
  if (at(b, 0, 'OggS')) return { type: 'audio/ogg', kind: 'audio' }
  return null
}

/** The bytes cut where a UTF-8 character would be split (the end of a page of text). */
export function wholeCharacters(b: Buffer): Buffer {
  let i = b.length - 1
  while (i >= 0 && b.length - i < 4 && (b[i]! & 0xc0) === 0x80) i--
  if (i < 0) return b
  const lead = b[i]!
  const size = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1
  return b.length - i < size ? b.subarray(0, i) : b
}

/** Text that reads as UTF-8 and holds no NUL byte (a binary file is no text), or null. */
export function asText(b: Buffer): string | null {
  if (b.includes(0)) return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b)
  } catch {
    return null
  }
}
