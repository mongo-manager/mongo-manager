// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { gunzipSync } from 'node:zlib'

/** A file of a `.tgz`. */
export interface TarEntry {
  path: string
  mode: number
  data: Buffer
}

export type TarErrorCode =
  'not_gzip' | 'too_large' | 'too_many' | 'damaged' | 'special' | 'path' | 'duplicate'

/** Why an archive was refused; the message is plain English, the code is for callers' own words. */
export class TarError extends Error {
  constructor(
    readonly code: TarErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'TarError'
  }
}

export interface TarLimits {
  /** The files' bytes in all. */
  maxBytes: number
  maxFiles: number
  /** 'plain' (default) refuses paths that escape or are not plain, and a path given twice; 'raw' leaves that to the caller. */
  paths?: 'plain' | 'raw'
}

const BLOCK = 512
/** A pax or long-name record set: a name and a few fields, never more (4b review I3). */
const META_BYTES = 64 * 1024

const damaged = (detail = '') => new TarError('damaged', `The archive is damaged${detail}`)

/** A NUL-ended field of a header. */
const text = (h: Buffer, start: number, length: number) => {
  const field = h.subarray(start, start + length)
  const end = field.indexOf(0)
  return field.subarray(0, end === -1 ? length : end).toString('utf8')
}
const octal = (h: Buffer, start: number, length: number): number => {
  const field = text(h, start, length).trim()
  // Base-256 sizes (first byte 0x80) are for files far past any limit here.
  if ((h[start]! & 0x80) !== 0 || !/^[0-7]*$/.test(field)) throw damaged()
  return field ? parseInt(field, 8) : 0
}
function checksumOk(h: Buffer): boolean {
  let sum = 0
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i]!
  return sum === octal(h, 148, 8)
}

/** Pax records: "len key=value\n" each, read by their byte lengths in one pass. */
function paxPath(data: Buffer): string | undefined {
  let path: string | undefined
  let at = 0
  while (at < data.length) {
    const space = data.indexOf(0x20, at)
    const len = space > at && space - at <= 7 ? Number(data.toString('latin1', at, space)) : NaN
    if (
      !Number.isInteger(len) ||
      len <= space - at + 1 ||
      at + len > data.length ||
      data[at + len - 1] !== 0x0a
    )
      throw damaged()
    const kv = data.toString('utf8', space + 1, at + len - 1)
    const eq = kv.indexOf('=')
    const key = kv.slice(0, eq)
    if (key === 'path') path = kv.slice(eq + 1)
    // A size or link given in a record is past what is read here: refused, never half-read.
    if (key === 'size' || key === 'linkpath')
      throw new TarError('special', 'Links, devices and special files are refused')
    at += len
  }
  return path
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/
const plainPath = (p: string) =>
  p !== '' &&
  !p.startsWith('/') &&
  !/^[A-Za-z]:/.test(p) &&
  !p.includes('\\') &&
  !CONTROL.test(p) &&
  p.split('/').every((s) => s !== '' && s !== '.' && s !== '..')

/** Each path once, in any case, and never both a file and a folder. */
function checkPaths(entries: TarEntry[]): void {
  const files = new Set<string>()
  const folders = new Set<string>()
  for (const e of entries) {
    if (!plainPath(e.path))
      throw new TarError('path', `Not a plain path: ${JSON.stringify(e.path.slice(0, 120))}`)
    const key = e.path.toLowerCase()
    if (files.has(key) || folders.has(key)) throw new TarError('duplicate', 'A path is given twice')
    files.add(key)
    const parts = key.split('/')
    for (let i = 1; i < parts.length; i++) {
      const folder = parts.slice(0, i).join('/')
      if (files.has(folder)) throw new TarError('duplicate', 'A path is given twice, as a file and a folder')
      folders.add(folder)
    }
  }
}

/**
 * A `.tgz` read in memory with every limit checked as it goes (moved from the plugin reader,
 * 2026-11-03): regular files only (folders implied), links, devices and special entries refused,
 * ustar prefixes, pax and GNU long names followed. A leading "./" is taken off each path.
 */
export function readTar(archive: Buffer, limits: TarLimits): TarEntry[] {
  let tarball: Buffer
  try {
    // Inflated only as far as the limit: a compression bomb stops here, never held whole.
    tarball = gunzipSync(archive, { maxOutputLength: limits.maxBytes + (limits.maxFiles + 64) * BLOCK * 4 })
  } catch (e) {
    if (e instanceof RangeError || (e as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE')
      throw new TarError('too_large', 'The archive is too large')
    throw new TarError('not_gzip', 'Not a gzip archive (.tgz)')
  }
  const entries: TarEntry[] = []
  let bytes = 0
  let longName: string | undefined
  let offset = 0
  for (;;) {
    if (offset + BLOCK > tarball.length) throw damaged(': it ends early')
    const h = tarball.subarray(offset, offset + BLOCK)
    if (h.every((b) => b === 0)) break
    if (!checksumOk(h)) throw damaged(': a bad checksum')
    const size = octal(h, 124, 12)
    const start = offset + BLOCK
    const end = start + size
    if (end > tarball.length) throw damaged(': an entry runs past its end')
    offset = start + Math.ceil(size / BLOCK) * BLOCK
    const data = tarball.subarray(start, end)
    const type = String.fromCharCode(h[156]!)
    if ((type === 'x' || type === 'g' || type === 'L') && size > META_BYTES)
      throw damaged(': a header record is too large')
    if (type === 'x') {
      longName = paxPath(data) ?? longName
      continue
    }
    if (type === 'g') continue
    if (type === 'L') {
      longName = text(data, 0, data.length)
      continue
    }
    const prefix = text(h, 345, 155)
    let path = longName ?? (prefix ? `${prefix}/${text(h, 0, 100)}` : text(h, 0, 100))
    longName = undefined
    if (type === '5') continue
    if (type !== '0' && type !== '\0' && type !== '7')
      throw new TarError('special', 'Links, devices and special files are refused')
    path = path.replace(/^(\.\/)+/, '')
    bytes += size
    if (bytes > limits.maxBytes) throw new TarError('too_large', 'The archive is too large')
    entries.push({ path, mode: octal(h, 100, 8) & 0o7777, data: Buffer.from(data) })
    if (entries.length > limits.maxFiles) throw new TarError('too_many', 'The archive holds too many files')
  }
  if (limits.paths !== 'raw') checkPaths(entries)
  return entries
}
