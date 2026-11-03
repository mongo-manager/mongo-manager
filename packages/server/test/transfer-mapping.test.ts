import { describe, expect, it } from 'vitest'
import { Int32 } from 'bson'
import type { MappingEntry } from '@mongo-manager/shared'
import { AppError } from '../src/errors'
import { compileMapping, getPath, parseTargetPath, validateMappingShape } from '../src/transfer/mapping'
import { OmittedFields, leafPaths, outCell, rowFor } from '../src/transfer/flatten'

const now = new Date('2026-10-01T00:00:00Z')
const table = { header: ['id', 'name', 'tags[0]', 'tags[1]', 'city'], hasHeader: true }
const e = (
  source: string,
  path: string,
  type: MappingEntry['type'] = 'keep',
  extra: Partial<MappingEntry> = {},
): MappingEntry => ({
  source,
  path,
  type,
  include: true,
  empty: 'skip',
  onError: 'error',
  ...extra,
})

describe('mapping (spec §5.3)', () => {
  it('maps, converts, nests, skips and adds constants', () => {
    const m = compileMapping({
      table,
      mapping: [
        e('id', '_id', 'int32'),
        e('name', 'person.name', 'string', { empty: 'null' }),
        e('tags[0]', 'tags[0]', 'string'),
        e('tags[1]', 'tags[1]', 'string'),
        e('city', 'city', 'string', { include: false }),
      ],
      constants: [
        { path: 'importedAt', now: true },
        { path: 'batch', type: 'int32', value: '7' },
      ],
      allowUnusual: false,
      now,
    })
    expect(m.table({ n: 1, cells: ['5', '', 'a', 'b', 'Izmir'] })).toEqual({
      ok: true,
      doc: {
        _id: new Int32(5),
        person: { name: null },
        tags: ['a', 'b'],
        importedAt: now,
        batch: new Int32(7),
      },
    })
    expect(m.table({ n: 2, cells: ['x', 'Ali', '', '', ''] })).toEqual({
      ok: false,
      field: 'id',
      reason: expect.stringContaining('int32'),
    })
    expect(m.stats()[0]).toEqual({ source: 'id', converted: 1, failed: 1 })
  })

  it('applies onError: null and string', () => {
    const m = compileMapping({
      table: { header: ['a', 'b'], hasHeader: true },
      mapping: [e('a', 'a', 'int32', { onError: 'null' }), e('b', 'b', 'int32', { onError: 'string' })],
      constants: [],
      allowUnusual: false,
      now,
    })
    expect(m.table({ n: 1, cells: ['x', 'y'] })).toEqual({ ok: true, doc: { a: null, b: 'y' } })
  })

  it('refuses conflicts, bad paths, unusual names and unknown sources', () => {
    const shape = (mapping: MappingEntry[], allowUnusual = false) =>
      validateMappingShape({ mapping, constants: [], keys: ['_id'], allowUnusual })
    expect(() => shape([e('a', 'a'), e('b', 'a')])).toThrow(AppError)
    expect(() => shape([e('a', 'a'), e('b', 'a.b')])).toThrow(AppError)
    expect(() => shape([e('a', 'a[0]'), e('b', 'a.0')])).toThrow(AppError)
    expect(() => shape([e('a', '$set')])).toThrow(AppError)
    expect(shape([e('a', '$set')], true)).toEqual(['$set'])
    expect(() => shape([e('a', '__proto__.x')])).toThrow(AppError)
    expect(shape([e('a', 'a'), e('b', 'ab')])).toEqual(['a', 'ab'])
    expect(() => parseTargetPath('a[10000]', false)).toThrow(AppError)
    expect(() =>
      validateMappingShape({ mapping: [], constants: [], keys: ['$where'], allowUnusual: false }),
    ).toThrow(AppError)
    expect(() =>
      compileMapping({ table, mapping: [e('missing', 'x')], constants: [], allowUnusual: false, now }),
    ).toThrow(AppError)
    expect(() => compileMapping({ table, constants: [], allowUnusual: false, now })).toThrow(AppError)
  })

  it('sets unusual names as data when allowed, never through a prototype', () => {
    const m = compileMapping({
      table: { header: ['a'], hasHeader: true },
      mapping: [e('a', '__proto__.polluted', 'string')],
      constants: [],
      allowUnusual: true,
      now,
    })
    const out = m.table({ n: 1, cells: ['yes'] })
    expect(out.ok && Object.keys(out.doc)).toEqual(['__proto__'])
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(Object.getPrototypeOf(out.ok && out.doc)).toBe(Object.prototype)
  })

  it('maps documents: source paths, keep types, missing sources skipped; no mapping keeps the document', () => {
    const m = compileMapping({
      table: null,
      mapping: [e('a.b', 'x'), e('missing', 'y', 'string', { empty: 'null' })],
      constants: [],
      allowUnusual: false,
      now,
    })
    expect(m.doc({ n: 1, doc: { a: { b: new Int32(3) } }, raw: '' })).toEqual({
      ok: true,
      doc: { x: new Int32(3) },
    })
    const all = compileMapping({
      table: null,
      constants: [{ path: 'src', type: 'string', value: 'f' }],
      allowUnusual: false,
      now,
    })
    expect(all.doc({ n: 1, doc: { a: 1 }, raw: '' })).toEqual({ ok: true, doc: { a: 1, src: 'f' } })
    expect(getPath({ a: [{ b: 1 }, { b: 2 }] }, 'a.1.b')).toBe(2)
    expect(getPath({ a: 1 }, 'toString')).toBeUndefined()
  })
})

describe('flattening for CSV and xlsx (spec §5.4)', () => {
  it('turns BSON values into cells', () => {
    expect(outCell(new Int32(3))).toEqual({ t: 'num', v: 3 })
    expect(outCell(undefined)).toEqual({ t: 'empty' })
    expect(rowFor({ a: { b: 1 }, t: ['x', 'y'] }, ['a.b', 't.1', 't', 'a'])).toEqual([
      { t: 'num', v: 1 },
      { t: 'text', v: 'y' },
      { t: 'text', v: '["x","y"]' },
      { t: 'text', v: '{"b":1}' },
    ])
  })

  it("recognises the driver's BSON values by their type tag, not by class identity", () => {
    // The driver loads its own copy of bson; instanceof against ours can fail (dual package).
    // Its values are instances of its own classes: other classes than ours, carrying the same tags.
    const of = <T extends object>(fields: T) =>
      Object.assign(Object.create({ constructor: 'other bson' }), fields) as T
    const driver = of({ _bsontype: 'Long', toString: () => '9007199254740993' })
    expect(outCell(driver)).toEqual({ t: 'digits', v: '9007199254740993' })
    expect(outCell(of({ _bsontype: 'Int32', value: 4 }))).toEqual({ t: 'num', v: 4 })
    expect(outCell(of({ _bsontype: 'ObjectId', toHexString: () => 'ab' }))).toEqual({ t: 'text', v: 'ab' })
    // Review M7: a stored sub-document with a field of that name is a plain object, and data.
    expect(outCell({ _bsontype: 'Int32', value: 4 })).toEqual({
      t: 'text',
      v: '{"_bsontype":"Int32","value":4}',
    })
  })

  it('proposes leaf paths and names omitted fields (Review Focus 4)', () => {
    expect(leafPaths({ _id: 1, a: { b: 1, c: [1] } }, 10)).toEqual(['_id', 'a.b', 'a.c'])
    const o = new OmittedFields(['_id', 'a.b'])
    o.see({ _id: 1, a: { b: 1 }, extra: 1 })
    o.see({ other: 2 })
    expect(o.names()).toEqual(['extra', 'other'])
  })
})
