// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
/**
 * User request 2026-10-11: the plugin starter, saved as one zip that every system opens. Files are
 * stored as they are (no compression: the starter is small), names in UTF-8, one fixed time.
 */
export interface ZipFile {
  path: string
  data: Uint8Array
}

const TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

/** The CRC-32 a zip reader checks each file against. */
export function crc32(data: Uint8Array): number {
  let c = 0xffffffff
  for (const byte of data) c = TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** 2026-10-11 00:00 in MS-DOS time and date, as zip headers keep them. */
const DOS_TIME = 0
const DOS_DATE = ((2026 - 1980) << 9) | (10 << 5) | 11
/** Bit 11: the names are UTF-8. */
const UTF8 = 0x0800

export function zipStored(files: readonly ZipFile[]): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder()
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0
  for (const file of files) {
    const name = encoder.encode(file.path)
    const crc = crc32(file.data)
    const local = new Uint8Array(30 + name.length)
    const l = new DataView(local.buffer)
    l.setUint32(0, 0x04034b50, true)
    l.setUint16(4, 20, true)
    l.setUint16(6, UTF8, true)
    l.setUint16(8, 0, true)
    l.setUint16(10, DOS_TIME, true)
    l.setUint16(12, DOS_DATE, true)
    l.setUint32(14, crc, true)
    l.setUint32(18, file.data.length, true)
    l.setUint32(22, file.data.length, true)
    l.setUint16(26, name.length, true)
    local.set(name, 30)
    const central = new Uint8Array(46 + name.length)
    const c = new DataView(central.buffer)
    c.setUint32(0, 0x02014b50, true)
    c.setUint16(4, 20, true)
    c.setUint16(6, 20, true)
    c.setUint16(8, UTF8, true)
    c.setUint16(10, 0, true)
    c.setUint16(12, DOS_TIME, true)
    c.setUint16(14, DOS_DATE, true)
    c.setUint32(16, crc, true)
    c.setUint32(20, file.data.length, true)
    c.setUint32(24, file.data.length, true)
    c.setUint16(28, name.length, true)
    c.setUint32(42, offset, true)
    central.set(name, 46)
    locals.push(local, file.data)
    centrals.push(central)
    offset += local.length + file.data.length
  }
  const directory = centrals.reduce((n, c) => n + c.length, 0)
  const end = new Uint8Array(22)
  const e = new DataView(end.buffer)
  e.setUint32(0, 0x06054b50, true)
  e.setUint16(8, files.length, true)
  e.setUint16(10, files.length, true)
  e.setUint32(12, directory, true)
  e.setUint32(16, offset, true)
  const out = new Uint8Array(offset + directory + end.length)
  let at = 0
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, at)
    at += part.length
  }
  return out
}
