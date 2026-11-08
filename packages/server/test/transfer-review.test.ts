// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { DBRef, Double } from 'bson'
import { AppError } from '../src/errors'
import { isDateFormat } from '../src/transfer/formats/xlsx'
import { CsvParser } from '../src/transfer/formats/csv'
import { RecordError, jsonElements, parseDocument } from '../src/transfer/formats/json'
import { xmlEvents } from '../src/transfer/formats/xml'
import { InflateBudget, ZipReader } from '../src/transfer/formats/zip'
import { convert } from '../src/transfer/infer'
import { leafPaths } from '../src/transfer/flatten'
import { personalLocations, restoreReplacement } from '../src/masking/gate/write'
import { compileRules } from '../src/masking/match'
import { sourceShape } from '../src/masking/gate/pipeline'
import { newCtx } from '../src/masking/gate/context'
import { csvLine } from '../src/transfer/formats/csv'
import { rawZip } from './support/hostile'

/** Phase 3d-1 final review: the parsers and helpers, each finding pinned by a test. */
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mm-review-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const heap = () => process.memoryUsage().heapUsed

describe('final review, parsers (phase 3d-1)', () => {
  it('C2: a number format of many "[" is decided at once', () => {
    const started = Date.now()
    expect(isDateFormat('['.repeat(200_000))).toBe(false)
    expect(isDateFormat(`[${'a'.repeat(300)}]dd`)).toBe(false)
    expect(Date.now() - started).toBeLessThan(200)
    expect(isDateFormat('[$-409]dd/mm/yyyy')).toBe(true)
    expect(isDateFormat('[Red]0.00')).toBe(false)
  })

  it('C3: a 16-million-character CSV field and JSON record do not blow up the heap', async () => {
    const big = 'é'.repeat(8_000_000)
    const before = heap()
    const p = new CsvParser(',')
    const out: string[][] = []
    for (let i = 0; i < big.length; i += 65_536) out.push(...p.feed(big.slice(i, i + 65_536)))
    out.push(...p.end())
    expect(out[0]![0]!.length).toBe(8_000_000)
    expect(heap() - before).toBeLessThan(200 * 1024 * 1024)
    const before2 = heap()
    const raws: string[] = []
    const text = `[{"a":"${big}"}]`
    const chunks = Array.from({ length: Math.ceil(text.length / 65_536) }, (_, i) =>
      text.slice(i * 65_536, (i + 1) * 65_536),
    )
    for await (const r of jsonElements(Readable.from(chunks))) raws.push((r as { raw: string }).raw)
    expect(raws[0]!.length).toBe(text.length - 2)
    expect(heap() - before2).toBeLessThan(200 * 1024 * 1024)
  })

  it('I10: a huge integer is a record error at once, not a BigInt of millions of digits', () => {
    const started = Date.now()
    expect(() => parseDocument(`{"a":${'9'.repeat(12_000_000)}}`, { allowUnusual: false })).toThrow(
      RecordError,
    )
    expect(Date.now() - started).toBeLessThan(500)
    expect(parseDocument(`{"a":${'9'.repeat(30)}}`, { allowUnusual: false }).a).toBeTruthy()
  })

  it('I5: an invalid EJSON date is a record error, never 1970', () => {
    expect(() => parseDocument('{"d":{"$date":"garbage"}}', { allowUnusual: false })).toThrow(RecordError)
    expect(convert(new Date(Number.NaN), 'keep', { allowUnusual: false }).ok).toBe(false)
  })

  it('I2: DBRef fields are checked for unusual names', () => {
    expect(() => parseDocument('{"r":{"$ref":"c","$id":1,"a.b":1}}', { allowUnusual: false })).toThrow(
      RecordError,
    )
    expect(parseDocument('{"r":{"$ref":"c","$id":1,"note":1}}', { allowUnusual: false }).r).toBeInstanceOf(
      DBRef,
    )
  })

  it('I2: personal values inside a DBRef are found by the write gate', async () => {
    const masker = compileRules([{ db: 'crm', coll: 'users', field: 'customer.phone' }])
    const deps = { masker, view: async () => null, indexes: async () => [] }
    const shape = await sourceShape('crm', 'users', newCtx(deps, 'crm'))
    expect(
      personalLocations({ customer: new DBRef('x', 1 as never, undefined, { phone: '1' }) }, shape),
    ).toEqual([['customer', 'phone']])
  })

  it('I2: a replacement puts the stored personal value back inside a DBRef, and refuses changing it', async () => {
    const masker = compileRules([{ db: 'crm', coll: 'users', field: 'customer.phone' }])
    const deps = { masker, view: async () => null, indexes: async () => [] }
    const ref = (phone: string, city: string) => new DBRef('x', 1 as never, undefined, { phone, city })
    const current = { _id: 1, customer: ref('secret', 'A') }
    const out = await restoreReplacement('crm', 'users', current, { _id: 1, customer: ref('***', 'B') }, deps)
    expect((out.customer as DBRef).fields).toEqual({ phone: 'secret', city: 'B' })
    // The caller's object is not changed.
    expect(current.customer.fields.phone).toBe('secret')
    await expect(
      restoreReplacement('crm', 'users', current, { _id: 1, customer: ref('other', 'B') }, deps),
    ).rejects.toThrow()
  })

  it('M8: a double target refuses an overflow to Infinity, keeps an explicit Infinity', () => {
    expect(convert('1e999', 'double', { allowUnusual: false }).ok).toBe(false)
    expect(convert('Infinity', 'double', { allowUnusual: false })).toEqual({
      ok: true,
      value: new Double(Infinity),
    })
  })

  it('M5: leaf paths walk null-prototype documents (masked output) like plain ones', () => {
    const masked = Object.assign(Object.create(null) as Record<string, unknown>, { phone: '***', city: 'X' })
    expect(leafPaths({ _id: 1, customer: masked }, 10)).toEqual(['_id', 'customer.phone', 'customer.city'])
  })

  it('M7: a CSV line can be written without the formula guard (rejected records go back as they were)', () => {
    expect(csvLine([{ t: 'text', v: '=x' }], ',', '\n', { guard: false })).toBe('=x\n')
    expect(csvLine([{ t: 'text', v: '=x' }], ',', '\n')).toBe("'=x\n")
  })

  it('M1: a long token split in small chunks is read in linear time', async () => {
    const value = 'v'.repeat(8 * 1024 * 1024)
    const text = `<a b="${value}"/>`
    const chunks = Array.from({ length: Math.ceil(text.length / 8192) }, (_, i) =>
      text.slice(i * 8192, (i + 1) * 8192),
    )
    const started = Date.now()
    const events = []
    for await (const e of xmlEvents(Readable.from(chunks))) events.push(e)
    expect(events[0]).toMatchObject({ type: 'open', name: 'a' })
    expect(Date.now() - started).toBeLessThan(3_000)
  })

  it('M2: a zip read whose file goes away fails instead of hanging', async () => {
    const bytes = rawZip([{ name: 'a', data: Buffer.from('x'.repeat(200_000)) }])
    const path = join(dir, 'z.zip')
    writeFileSync(path, bytes)
    const handle = await open(path, 'r')
    const zip = await ZipReader.open(handle, bytes.length)
    await handle.close()
    const outcome = await Promise.race([
      zip.readAll('a', new InflateBudget(1e9), 1e9).then(
        () => 'ok',
        (e: unknown) => (e instanceof AppError ? 'app-error' : 'other-error'),
      ),
      new Promise((r) => setTimeout(() => r('hang'), 2_000)),
    ])
    expect(outcome).toBe('app-error')
  })
})
