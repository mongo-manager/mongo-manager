// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { FileHandle } from 'node:fs/promises'
import { PassThrough, Readable, type Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { once } from 'node:events'
import { createDeflateRaw, createInflateRaw, crc32 } from 'node:zlib'
import { AppError, Errors } from '../../errors'
import { MAX_ZIP_ENTRIES, MAX_ZIP_ENTRY } from '../limits'

export interface ZipEntry {
  name: string
  method: 0 | 8
  compressedSize: number
  size: number
  crc: number
  dataStart: number
}

const badWith = (label: string) => (what: string) => Errors.badFile(`${label}: ${what}`, { reason: 'zip' })
const WORKBOOK = 'The workbook is damaged'
const bad = badWith(WORKBOOK)

/** Phase 3d-3a: what a reader of another kind of zip (a mongodump folder) changes; 3d-1 defaults otherwise. */
export interface ZipOptions {
  maxEntries?: number
  maxEntry?: number
  /** The start of every error message. */
  label?: string
  /** Refuse entries a Unix zip marks as symbolic links (S_IFLNK in the external attributes). */
  refuseLinks?: boolean
}
const MAX_CENTRAL_DIRECTORY = 16 * 1024 * 1024

/** Spec §7 T4: inflated bytes across a whole file. */
export class InflateBudget {
  private used = 0
  constructor(private readonly limit: number) {}
  take(n: number): void {
    this.used += n
    if (this.used > this.limit) throw Errors.badFile('The file expands too much', { reason: 'inflate' })
  }
}

async function readAtFile(
  handle: FileHandle,
  length: number,
  position: number,
  fail: (what: string) => Error = bad,
): Promise<Buffer> {
  const buf = Buffer.alloc(length)
  const { bytesRead } = await handle.read(buf, 0, length, position)
  if (bytesRead !== length) throw fail('truncated')
  return buf
}

/**
 * Spec §7 T8: a zip read from its central directory, never extracted to disk. Refused: multi-disk and
 * ZIP64 archives, encrypted entries, methods other than stored/deflate, duplicate names, local headers
 * that disagree with the central directory, overlapping entries, entries past the directory, and
 * entries declared larger than MAX_ZIP_ENTRY.
 */
export class ZipReader {
  /** Compressed bytes read so far: an import's progress through a workbook. */
  bytesRead = 0

  private constructor(
    private readonly handle: FileHandle,
    private readonly entries: ReadonlyMap<string, ZipEntry>,
    private readonly bad: (what: string) => Error,
  ) {}

  static async open(handle: FileHandle, fileSize: number, opts: ZipOptions = {}): Promise<ZipReader> {
    const bad = badWith(opts.label ?? WORKBOOK)
    const readAt = (h: FileHandle, length: number, position: number) => readAtFile(h, length, position, bad)
    if (fileSize < 22) throw bad('no end of central directory')
    const tailSize = Math.min(fileSize, 65_557)
    const tail = await readAt(handle, tailSize, fileSize - tailSize)
    let eocd = -1
    for (let i = tailSize - 22; i >= 0; i--)
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i
        break
      }
    if (eocd < 0) throw bad('no end of central directory')
    const disk = tail.readUInt16LE(eocd + 4)
    const cdDisk = tail.readUInt16LE(eocd + 6)
    const count = tail.readUInt16LE(eocd + 10)
    const cdSize = tail.readUInt32LE(eocd + 12)
    const cdOffset = tail.readUInt32LE(eocd + 16)
    if (disk !== 0 || cdDisk !== 0 || count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff)
      throw bad('multi-disk or ZIP64 archives are not supported')
    if (count > (opts.maxEntries ?? MAX_ZIP_ENTRIES)) throw bad('too many entries')
    const eocdAt = fileSize - tailSize + eocd
    if (cdOffset + cdSize > eocdAt || cdSize > MAX_CENTRAL_DIRECTORY)
      throw bad('central directory out of place')
    const cd = await readAt(handle, cdSize, cdOffset)
    const entries = new Map<string, ZipEntry>()
    const ranges: Array<[number, number]> = []
    let p = 0
    for (let i = 0; i < count; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) throw bad('central directory entry')
      const flags = cd.readUInt16LE(p + 8)
      const method = cd.readUInt16LE(p + 10)
      const crc = cd.readUInt32LE(p + 16)
      const compressedSize = cd.readUInt32LE(p + 20)
      const size = cd.readUInt32LE(p + 24)
      const nameLen = cd.readUInt16LE(p + 28)
      const extraLen = cd.readUInt16LE(p + 30)
      const commentLen = cd.readUInt16LE(p + 32)
      const madeBy = cd.readUInt8(p + 5)
      const external = cd.readUInt32LE(p + 38)
      const localOffset = cd.readUInt32LE(p + 42)
      if (p + 46 + nameLen > cd.length) throw bad('central directory entry')
      const name = cd.toString(flags & 0x0800 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLen)
      p += 46 + nameLen + extraLen + commentLen
      if (flags & 0x0041) throw bad('encrypted entries')
      if (method !== 0 && method !== 8) throw bad('unsupported compression')
      if (name === '' || name.includes('\0') || entries.has(name))
        throw bad('duplicate or invalid entry names')
      if (opts.refuseLinks && madeBy === 3 && ((external >>> 16) & 0o170000) === 0o120000)
        throw bad('symbolic links are not allowed')
      if (size > (opts.maxEntry ?? MAX_ZIP_ENTRY))
        throw Errors.badFile('A part of the workbook is too large', { reason: 'inflate' })
      if (method === 0 && compressedSize !== size) throw bad('stored entry sizes differ')
      if (localOffset + 30 > cdOffset) throw bad('entry past the directory')
      const local = await readAt(handle, 30, localOffset)
      if (local.readUInt32LE(0) !== 0x04034b50) throw bad('local header')
      const lFlags = local.readUInt16LE(6)
      const lNameLen = local.readUInt16LE(26)
      const lExtraLen = local.readUInt16LE(28)
      if (localOffset + 30 + lNameLen > cdOffset) throw bad('entry past the directory')
      const lName = (await readAt(handle, lNameLen, localOffset + 30)).toString(
        lFlags & 0x0800 ? 'utf8' : 'latin1',
      )
      if (local.readUInt16LE(8) !== method || lName !== name)
        throw bad('local header disagrees with the directory')
      if (
        !(lFlags & 0x0008) &&
        (local.readUInt32LE(18) !== compressedSize || local.readUInt32LE(22) !== size)
      )
        throw bad('local header sizes disagree with the directory')
      const dataStart = localOffset + 30 + lNameLen + lExtraLen
      if (dataStart + compressedSize > cdOffset) throw bad('entry past the directory')
      ranges.push([localOffset, dataStart + compressedSize])
      entries.set(name, { name, method: method as 0 | 8, compressedSize, size, crc, dataStart })
    }
    ranges.sort((a, b) => a[0] - b[0])
    for (let i = 1; i < ranges.length; i++)
      if (ranges[i]![0] < ranges[i - 1]![1]) throw bad('overlapping entries')
    return new ZipReader(handle, entries, bad)
  }

  has(name: string): boolean {
    return this.entries.has(name)
  }

  names(): string[] {
    return [...this.entries.keys()]
  }

  entry(name: string): ZipEntry | undefined {
    return this.entries.get(name)
  }

  private async *compressed(e: ZipEntry): AsyncGenerator<Buffer> {
    let at = e.dataStart
    let left = e.compressedSize
    while (left > 0) {
      const n = Math.min(left, 64 * 1024)
      const buf = await readAtFile(this.handle, n, at, this.bad)
      at += n
      left -= n
      this.bytesRead += n
      yield buf
    }
  }

  /** An entry's bytes, inflated as they are read, checked against its size and CRC. */
  async *read(name: string, budget: InflateBudget): AsyncGenerator<Buffer> {
    const e = this.entries.get(name)
    if (!e) throw this.bad(`missing part ${name.slice(0, 100)}`)
    const src = Readable.from(this.compressed(e))
    // pipeline, not pipe: a read that fails (the file closed or gone) ends the loop below with its
    // error instead of leaving it waiting forever (final review M2).
    let data: Readable = src
    if (e.method === 8) {
      const out = new PassThrough()
      pipeline(src, createInflateRaw(), out).catch(() => undefined)
      data = out
    }
    let count = 0
    let crc = 0
    try {
      for await (const chunk of data as AsyncIterable<Buffer>) {
        count += chunk.length
        if (count > e.size) throw this.bad('an entry is larger than declared')
        budget.take(chunk.length)
        crc = crc32(chunk, crc)
        yield chunk
      }
    } catch (err) {
      if (err instanceof AppError) throw err
      throw this.bad('compressed data')
    } finally {
      data.destroy()
      src.destroy()
    }
    if (count !== e.size || crc >>> 0 !== e.crc >>> 0) throw this.bad('an entry does not match its checksum')
  }

  async readAll(name: string, budget: InflateBudget, max: number): Promise<Buffer> {
    const parts: Buffer[] = []
    let n = 0
    for await (const chunk of this.read(name, budget)) {
      n += chunk.length
      if (n > max) throw Errors.badFile(`The part ${name.slice(0, 100)} is too large`, { reason: 'inflate' })
      parts.push(chunk)
    }
    return Buffer.concat(parts)
  }
}

/** Writes a zip sequentially: deflated entries with data descriptors, then the directory (no ZIP64). */
export class ZipWriter {
  private offset = 0
  private readonly central: Buffer[] = []
  private count = 0

  constructor(private readonly out: Writable) {}

  private async write(buf: Buffer): Promise<void> {
    this.offset += buf.length
    if (this.offset > 0xffffffff)
      throw Errors.badFile('The workbook is too large for xlsx; export CSV instead', { reason: 'xlsx_size' })
    if (!this.out.write(buf)) await once(this.out, 'drain')
  }

  async add(name: string, data: string | Buffer | AsyncIterable<string | Buffer>): Promise<void> {
    const nameBytes = Buffer.from(name)
    const start = this.offset
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0808, 6) // data descriptor, UTF-8 name
    local.writeUInt16LE(8, 8)
    local.writeUInt16LE(0x0021, 12) // 1980-01-01
    local.writeUInt16LE(nameBytes.length, 26)
    await this.write(Buffer.concat([local, nameBytes]))
    const deflate = createDeflateRaw()
    let size = 0
    let compressed = 0
    let crc = 0
    const pump = (async () => {
      for await (const chunk of deflate as AsyncIterable<Buffer>) {
        compressed += chunk.length
        await this.write(chunk)
      }
    })()
    const feed = async (piece: string | Buffer) => {
      const buf = typeof piece === 'string' ? Buffer.from(piece) : piece
      size += buf.length
      crc = crc32(buf, crc)
      if (!deflate.write(buf)) await once(deflate, 'drain')
    }
    try {
      if (typeof data === 'string' || Buffer.isBuffer(data)) await feed(data)
      else for await (const piece of data) await feed(piece)
      deflate.end()
      await pump
    } catch (e) {
      deflate.destroy()
      await pump.catch(() => undefined)
      throw e
    }
    if (size > 0xffffffff)
      throw Errors.badFile('The workbook is too large for xlsx; export CSV instead', { reason: 'xlsx_size' })
    const descriptor = Buffer.alloc(16)
    descriptor.writeUInt32LE(0x08074b50, 0)
    descriptor.writeUInt32LE(crc >>> 0, 4)
    descriptor.writeUInt32LE(compressed, 8)
    descriptor.writeUInt32LE(size, 12)
    await this.write(descriptor)
    const c = Buffer.alloc(46)
    c.writeUInt32LE(0x02014b50, 0)
    c.writeUInt16LE(20, 4)
    c.writeUInt16LE(20, 6)
    c.writeUInt16LE(0x0808, 8)
    c.writeUInt16LE(8, 10)
    c.writeUInt16LE(0x0021, 14)
    c.writeUInt32LE(crc >>> 0, 16)
    c.writeUInt32LE(compressed, 20)
    c.writeUInt32LE(size, 24)
    c.writeUInt16LE(nameBytes.length, 28)
    c.writeUInt32LE(start, 42)
    this.central.push(Buffer.concat([c, nameBytes]))
    this.count++
  }

  /** Writes the directory; returns the bytes written in all. */
  async finish(): Promise<number> {
    const cd = Buffer.concat(this.central)
    const at = this.offset
    await this.write(cd)
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0)
    end.writeUInt16LE(this.count, 8)
    end.writeUInt16LE(this.count, 10)
    end.writeUInt32LE(cd.length, 12)
    end.writeUInt32LE(at, 16)
    await this.write(end)
    return this.offset
  }
}
