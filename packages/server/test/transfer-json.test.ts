import { describe, expect, it } from 'vitest'
import { Readable } from 'node:stream'
import {
  Binary,
  BSONRegExp,
  Code,
  DBRef,
  Decimal128,
  Double,
  EJSON,
  Int32,
  Long,
  MaxKey,
  MinKey,
  ObjectId,
  Timestamp,
  UUID,
} from 'bson'
import { toWire } from '@mongo-manager/shared'
import { AppError } from '../src/errors'
import { RecordError, docSource, jsonElements, parseDocument } from '../src/transfer/formats/json'
import { ndjsonLines } from '../src/transfer/formats/ndjson'
import { isFailure } from '../src/transfer/formats/types'
import { fuzz } from './support/fuzz'
import { hostile } from './support/hostile'

const every = {
  _id: new ObjectId('65a1b2c3d4e5f6a7b8c9d0e1'),
  int: new Int32(7),
  long: Long.fromString('9007199254740993'),
  double: new Double(1.5),
  integralDouble: new Double(3),
  dec: Decimal128.fromString('12345678901234567890.123'),
  date: new Date('2024-01-02T03:04:05.006Z'),
  bin: new Binary(Buffer.from('hi'), 0),
  uuid: new UUID('0f8fad5b-d9cb-469f-a165-70867728950e'),
  ts: new Timestamp({ t: 1700000000, i: 3 }),
  re: new BSONRegExp('^a', 'i'),
  min: new MinKey(),
  max: new MaxKey(),
  ref: new DBRef('orders', new ObjectId('65a1b2c3d4e5f6a7b8c9d0e2')),
  code: new Code('function () {}'),
  nested: { arr: [1, 'two', { three: null }] },
  t: true,
}

const parse = (t: string, allowUnusual = false) => parseDocument(t, { allowUnusual })
async function docs(text: string, ndjson = false) {
  const raws = ndjson ? ndjsonLines(Readable.from([text])) : jsonElements(Readable.from([text]))
  const out = []
  for await (const r of docSource(raws, { allowUnusual: false }).records) out.push(r)
  return out
}

describe('strict EJSON documents (spec §5.1, §7 T9, T10, T17)', () => {
  it('round-trips every BSON type through canonical and relaxed EJSON (Review Focus 3)', () => {
    expect(toWire(parse(EJSON.stringify(every, { relaxed: false })))).toBe(toWire(every))
    const relaxed = parse(EJSON.stringify(every, { relaxed: true }))
    expect(relaxed.date).toEqual(every.date)
    expect(relaxed._id).toEqual(every._id)
  })

  it('reads mongoexport relaxed dates and plain numbers by size', () => {
    const d = parse(
      '{"d":{"$date":"2024-01-01T00:00:00Z"},"a":5,"b":4294967296,"c":123456789012345678901234,"e":2.0,"z":-0}',
    )
    expect(d.d).toEqual(new Date('2024-01-01T00:00:00Z'))
    expect(d.a).toBe(5)
    expect(d.b).toEqual(Long.fromString('4294967296'))
    expect(d.c).toEqual(Decimal128.fromString('123456789012345678901234'))
    expect(d.e).toEqual(new Double(2))
    expect(Object.is((d.z as Double).value, -0)).toBe(true)
  })

  it('refuses duplicate keys, NUL in keys, and unusual keys unless allowed (T10)', () => {
    expect(() => parse('{"a":1,"a":2}')).toThrow(RecordError)
    expect(() => parse('{"a\\u0000b":1}')).toThrow(RecordError)
    expect(() => parse('{"$set":1}')).toThrow(RecordError)
    expect(() => parse('{"a.b":1}')).toThrow(RecordError)
    expect(parse('{"$set":1,"a.b":2}', true)).toEqual({ $set: 1, 'a.b': 2 })
  })

  it('never lets __proto__ reach a prototype (T9)', () => {
    expect(() => parse('{"__proto__":{"polluted":1}}')).toThrow(RecordError)
    const d = parse('{"__proto__":{"polluted":1},"constructor":{"prototype":{"x":1}}}', true)
    expect(Object.getPrototypeOf(d)).toBe(Object.prototype)
    expect(Object.keys(d)).toEqual(['__proto__', 'constructor'])
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('refuses depth beyond 100, lone surrogates, bad syntax and numbers out of range (T5, T11, T17)', () => {
    expect(() => parse(hostile.deepJson(101))).toThrow(RecordError)
    expect(parse(hostile.deepJson(99))).toBeTruthy()
    expect(() => parse('{"a":"\\ud800"}')).toThrow(RecordError)
    expect(() => parse('{"a":1e400}')).toThrow(RecordError)
    expect(() => parse('{"a":"x\ny"}')).toThrow(RecordError)
    expect(() => parse('{"a":01}')).toThrow(RecordError)
    expect(() => parse('{"a":1,}')).toThrow(RecordError)
    expect(() => parse('{"a":1} x')).toThrow(RecordError)
    expect(() => parse('[1]')).toThrow(RecordError)
  })

  it('reads a top-level array as records and keeps going after a bad element', async () => {
    const out = await docs('[{"a":1}, 2, {"b":{"$oid":"zz"}}, "s,t", {"c":3}]')
    expect(out.map((r) => (isFailure(r) ? `x${r.n}` : r.n))).toEqual([1, 'x2', 'x3', 'x4', 5])
    expect(await docs('{"single":true}')).toHaveLength(1)
    expect(await docs('[]')).toHaveLength(0)
    expect(await docs('[ {"a":"]"} ]')).toHaveLength(1)
  })

  it('reads NDJSON by line number, blank lines skipped', async () => {
    const out = await docs('{"a":1}\r\n\n{"a":2}\n', true)
    expect(out.map((r) => r.n)).toEqual([1, 3])
  })

  it('refuses a structurally broken file as a whole', async () => {
    await expect(docs('[{"a":1},,{"b":2}]')).rejects.toBeInstanceOf(AppError)
    await expect(docs('[{"a":1}] trailing')).rejects.toBeInstanceOf(AppError)
    await expect(docs('[{"a":1}')).rejects.toBeInstanceOf(AppError)
    await expect(docs('nope')).rejects.toBeInstanceOf(AppError)
  })

  it('survives fuzzing', async () => {
    const base = Buffer.from(EJSON.stringify([every, { a: 1 }], { relaxed: false }))
    await fuzz(5101, 500, base, async (input) => {
      for await (const _ of docSource(jsonElements(Readable.from([input.toString('latin1')])), {
        allowUnusual: false,
      }).records);
    })
  })
})
