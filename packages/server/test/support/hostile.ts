// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { crc32, deflateRawSync, gzipSync } from 'node:zlib'

/** Phase 3d-1 spec §10: hostile inputs built by code (no binary fixtures in the repository). */
export const hostile = {
  /** gzip of zeros: `ratio` × 64 KiB of inflated data from very few compressed bytes. */
  gzipBomb(ratio: number): Buffer {
    return gzipSync(Buffer.alloc(64 * 1024 * ratio), { level: 9 })
  },
  deepJson(depth: number): string {
    return `${'{"a":'.repeat(depth)}1${'}'.repeat(depth)}`
  },
  deepArray(depth: number): string {
    return `[${'['.repeat(depth)}${']'.repeat(depth)}]`
  },
  longLine(chars: number): string {
    return 'x'.repeat(chars)
  },
}

export interface RawEntry {
  name: string
  data: Buffer
  method?: 0 | 8
  /** A size other than the data's: a lie the reader must catch. */
  declaredSize?: number
  crc?: number
  flags?: number
  /** A local header name different from the central one (header mismatch). */
  localName?: string
}

/** A zip built byte by byte, able to lie: wrong sizes, wrong CRCs, duplicate names, other local names. */
export function rawZip(entries: RawEntry[], opts: { overlapSecondOntoFirst?: boolean } = {}): Buffer {
  const parts: Buffer[] = []
  const central: Buffer[] = []
  const offsets: number[] = []
  let offset = 0
  for (const e of entries) {
    const method = e.method ?? 8
    const body = method === 8 ? deflateRawSync(e.data) : e.data
    const crc = e.crc ?? crc32(e.data)
    const size = e.declaredSize ?? e.data.length
    const name = Buffer.from(e.localName ?? e.name)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE((e.flags ?? 0) | 0x0800, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc >>> 0, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(size, 22)
    local.writeUInt16LE(name.length, 26)
    offsets.push(offset)
    parts.push(local, name, body)
    offset += 30 + name.length + body.length
    const cname = Buffer.from(e.name)
    const c = Buffer.alloc(46)
    c.writeUInt32LE(0x02014b50, 0)
    c.writeUInt16LE(20, 4)
    c.writeUInt16LE(20, 6)
    c.writeUInt16LE((e.flags ?? 0) | 0x0800, 8)
    c.writeUInt16LE(method, 10)
    c.writeUInt32LE(crc >>> 0, 16)
    c.writeUInt32LE(body.length, 20)
    c.writeUInt32LE(size, 24)
    c.writeUInt16LE(cname.length, 28)
    const at = opts.overlapSecondOntoFirst && central.length === 1 ? offsets[0]! : offsets.at(-1)!
    c.writeUInt32LE(at, 42)
    central.push(Buffer.concat([c, cname]))
  }
  const cd = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, cd, end])
}

/** One honest entry of 64 MiB of zeros in well under a MiB: only the inflate budget stops it. */
export function zipBomb(): Buffer {
  return rawZip([{ name: 'xl/worksheets/sheet1.xml', data: Buffer.alloc(64 * 1024 * 1024) }])
}
