// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { createGunzip, gzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { EJSON, Int32 } from 'bson'
import { MIGRATIONS } from '../src/store/migrations'
import { TransferFiles } from '../src/transfer/files'
import { MiB, type TransferLimits } from '../src/transfer/limits'
import { openSource, preview } from '../src/transfer/source'
import { XlsxWriter } from '../src/transfer/formats/xlsx'
import { isFailure } from '../src/transfer/formats/types'
import { PassThrough } from 'node:stream'

let dir: string
let db: DatabaseSync
let files: TransferFiles
const limits: TransferLimits = { maxUpload: 64 * MiB, quota: 256 * MiB, ttlMs: 3600_000, maxJobMs: 3600_000 }
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mm-src-'))
  db = new DatabaseSync(':memory:')
  for (const m of MIGRATIONS) db.exec(m.sql)
  files = new TransferFiles(db, join(dir, 't'), limits, () => 1)
  files.init()
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})
const upload = (bytes: Buffer | string) =>
  files.receive({ owner: 'u1', connectionId: 'c1', name: 'f', body: Readable.from([Buffer.from(bytes)]) })
const look = async (bytes: Buffer | string, dialect = {}) =>
  preview(await upload(bytes), files, { dialect }, limits)

async function workbook(
  rows: Array<Array<{ t: 'text'; v: string } | { t: 'num'; v: number }>>,
): Promise<Buffer> {
  const out = new PassThrough()
  const parts: Buffer[] = []
  out.on('data', (c: Buffer) => parts.push(c))
  const w = new XlsxWriter(out)
  await w.start()
  for (const r of rows) await w.row(r)
  await w.finish()
  out.end()
  return Buffer.concat(parts)
}

describe('detecting and previewing (spec §4.1, §5.1)', () => {
  it('detects CSV with a semicolon, JSON, NDJSON, gzip and xlsx', async () => {
    expect((await look('ad;tutar\nAli;1,5\n')).dialect.delimiter).toBe(';')
    expect((await look('[{"a":1}]')).format).toBe('json')
    expect((await look('{"a":1}\n{"a":2}\n')).format).toBe('ndjson')
    expect((await look('{"a":\n1}')).format).toBe('json')
    expect(await look(gzipSync('a,b\n1,2\n'))).toMatchObject({ format: 'csv', gzip: true })
    const xlsx = await look(await workbook([[{ t: 'text', v: 'id' }], [{ t: 'num', v: 7 }]]))
    expect(xlsx).toMatchObject({
      format: 'xlsx',
      sheets: ['Export'],
      fields: [{ source: 'id', suggestedType: 'int32' }],
    })
    const xlsxGz = await look(gzipSync(await workbook([[{ t: 'text', v: 'id' }], [{ t: 'num', v: 7 }]])))
    expect(xlsxGz).toMatchObject({ format: 'xlsx', gzip: true })
    // The inflated workbook was temporary.
    expect(readdirSync(join(dir, 't', 'u1')).filter((n) => n.endsWith('.tmp'))).toEqual([])
  })

  // Security audit 2026-10-16 (minor): a gzipped workbook is inflated once — not to disk again at each
  // preview — and its parts expand no more than a plain workbook's may, whatever the gzip step gave.
  it('inflates a gzipped workbook once, in place, still saying it came gzipped', async () => {
    const book = await workbook([[{ t: 'text', v: 'id' }], [{ t: 'num', v: 7 }]])
    const file = await upload(gzipSync(book))
    const first = await preview(file, files, { dialect: {} }, limits)
    expect(first).toMatchObject({ format: 'xlsx', gzip: true, fields: [{ source: 'id' }] })
    const stored = files.get('u1', file.id)!
    expect(stored.size).toBe(book.length)
    expect(readFileSync(files.pathOf(stored)).equals(book)).toBe(true)
    // The second preview reads the workbook as it is now: nothing inflated again.
    const again = await preview(stored, files, { dialect: {} }, limits)
    expect(again).toMatchObject({ format: 'xlsx', gzip: true, fields: [{ source: 'id' }] })
    expect(readdirSync(join(dir, 't', 'u1')).filter((n) => n.endsWith('.tmp'))).toEqual([])
  })

  it('inflates an upload once when two readers open it together', async () => {
    const book = await workbook([[{ t: 'text', v: 'id' }], [{ t: 'num', v: 7 }]])
    const file = await upload(gzipSync(book))
    let inflated = 0
    const gunzip = () => {
      inflated++
      return createGunzip()
    }
    const [a, b] = await Promise.all([files.inflateInPlace(file, gunzip), files.inflateInPlace(file, gunzip)])
    expect([a.size, b.size]).toEqual([book.length, book.length])
    expect(inflated).toBe(1)
    expect(readFileSync(files.pathOf(a)).equals(book)).toBe(true)
  })

  it('bounds a gzipped workbook’s parts by the upload limit, not 20 × its inflated size', async () => {
    // Parts that expand a few times their workbook: within 20 × the inflated workbook (what was
    // allowed), past 20 × an upload limit of a 19th of it; the gunzip step itself stays within bounds.
    // Fewer rows than a preview reads, so every part is read.
    const hex = (i: number) => createHash('sha256').update(String(i)).digest('hex')
    const big = await workbook(Array.from({ length: 900 }, (_, i) => [{ t: 'text', v: hex(i) }]))
    const small = { ...limits, maxUpload: Math.ceil(big.length / 19) }
    const gz = gzipSync(big)
    expect(big.length).toBeLessThan(gz.length * 20)
    const file = await upload(gz)
    await expect(preview(file, files, { dialect: {} }, small)).rejects.toMatchObject({
      details: { reason: 'inflate' },
    })
    // The same workbook under the old limit opened: the bound is what refused it.
    expect(await preview(files.get('u1', file.id)!, files, { dialect: {} }, limits)).toMatchObject({
      format: 'xlsx',
    })
  })

  it('suggests fields, types and records', async () => {
    const p = await look('id,name,code,when\n1,Ali,007,2024-01-02\n2,Veli,010,2024-01-03\n')
    expect(p.fields.map((f) => [f.source, f.suggestedType])).toEqual([
      ['id', 'int32'],
      ['name', 'string'],
      ['code', 'string'],
      ['when', 'date'],
    ])
    expect(p.records[0]).toEqual({
      id: { $numberInt: '1' },
      name: 'Ali',
      code: '007',
      when: { $date: { $numberLong: '1704153600000' } },
    })
  })

  it('marks unusual field names and leaves them out of the sample records', async () => {
    const p = await look('id,$set,__proto__\n1,x,y\n')
    expect(p.fields.map((f) => [f.source, f.unusual])).toEqual([
      ['id', false],
      ['$set', true],
      ['__proto__', true],
    ])
    expect(p.records[0]).toEqual({ id: { $numberInt: '1' } })
  })

  it('reads a file without a header with generated names', async () => {
    const p = await look('1,Ali\n2,Veli\n', { header: false })
    expect(p.fields.map((f) => f.source)).toEqual(['field1', 'field2'])
  })

  it('warns when the text is not UTF-8 (Review Focus 1)', async () => {
    const p = await look(
      Buffer.from([0x61, 0x3b, 0x62, 0x0a, 0x49, 0xfe, 0x3b, 0x31, 0x0a, 0x6f, 0x6b, 0x3b, 0x32, 0x0a]),
    )
    expect(p.warnings.join(' ')).toMatch(/UTF-8/)
    expect(p.warnings.join(' ')).toMatch(/Record 1/)
    // The bad row is refused, the good one is read: no mojibake reaches a record.
    expect(p.records).toEqual([{ a: 'ok', b: { $numberInt: '2' } }])
  })

  it('opens JSON as documents and reads every record', async () => {
    const file = await upload(EJSON.stringify([{ a: new Int32(1) }, { b: 2 }], { relaxed: false }))
    const o = await openSource(file, files, { format: 'json', dialect: {}, allowUnusual: false }, limits)
    const out = []
    if (o.source.kind === 'docs')
      for await (const r of o.source.records) out.push(isFailure(r) ? r.error : r.doc)
    await o.close()
    expect(out).toEqual([{ a: new Int32(1) }, { b: new Int32(2) }])
    expect(o.consumed()).toBeGreaterThan(0)
  })

  it('refuses an old .xls or encrypted workbook with a clear reason', async () => {
    const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0])
    await expect(look(ole)).rejects.toMatchObject({ details: { reason: 'xlsx_encrypted' } })
  })
})
