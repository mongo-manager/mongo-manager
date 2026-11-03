import { describe, expect, it } from 'vitest'
import { parse } from 'acorn'
import ts from 'typescript'
import { Long, ObjectId } from 'bson'
import { SchemaAnalyser, type SchemaAnalysis } from '../src/schema/analyse'
import { toJsonSchema, toMongoose, toTypeScript, typeName } from '../src/schema/export'

const analyse = (docs: Array<Record<string, unknown>>): SchemaAnalysis => {
  const a = new SchemaAnalyser()
  for (const d of docs) a.add(d)
  return a.result()
}

const ORDERS = analyse([
  {
    _id: new ObjectId(),
    name: 'Ada',
    qty: 6,
    tags: ['a'],
    address: { city: 'Izmir' },
    meta: 1,
    at: new Date(0),
  },
  { _id: new ObjectId(), name: 'Bob', tags: [], address: { city: 'Ankara' }, meta: 'x', at: new Date(1) },
])

describe('schema export (phase 1i spec §6)', () => {
  it('names types from collection names', () => {
    expect(typeName('order_items')).toBe('OrderItems')
    expect(typeName('orders')).toBe('Orders')
    expect(typeName('2026-logs')).toBe('T2026Logs')
    expect(typeName('---')).toBe('Document')
  })

  it('writes a MongoDB $jsonSchema with required fields, unions, nested objects and arrays', () => {
    expect(toJsonSchema(ORDERS)).toEqual({
      bsonType: 'object',
      required: ['_id', 'address', 'at', 'meta', 'name', 'tags'],
      properties: {
        _id: { bsonType: 'objectId' },
        address: { bsonType: 'object', required: ['city'], properties: { city: { bsonType: 'string' } } },
        at: { bsonType: 'date' },
        meta: { bsonType: ['number', 'string'] },
        name: { bsonType: 'string' },
        qty: { bsonType: 'number' },
        tags: { bsonType: 'array', items: { bsonType: 'string' } },
      },
    })
  })

  it('writes a Mongoose schema', () => {
    expect(toMongoose(ORDERS, 'Orders')).toBe(
      [
        "import { Schema } from 'mongoose'",
        '',
        'export const OrdersSchema = new Schema({',
        '  address: new Schema({ city: { type: String, required: true } }, { _id: false }),',
        '  at: { type: Date, required: true },',
        '  meta: { type: Schema.Types.Mixed, required: true },',
        '  name: { type: String, required: true },',
        '  qty: Number,',
        '  tags: [String],',
        '})',
        '',
      ].join('\n'),
    )
  })

  it('writes a TypeScript interface, importing only the bson types it uses', () => {
    expect(toTypeScript(ORDERS, 'Orders')).toBe(
      [
        "import type { ObjectId } from 'bson'",
        '',
        'export interface Orders {',
        '  _id: ObjectId',
        '  address: {',
        '    city: string',
        '  }',
        '  at: Date',
        '  meta: number | string',
        '  name: string',
        '  qty?: number',
        '  tags: string[]',
        '}',
        '',
      ].join('\n'),
    )
  })

  it('keeps hostile field names inert in every format (Review Focus 4)', () => {
    const hostile = analyse([
      {
        ['__proto__']: 1,
        'a-b': 'x',
        '"q"': 'x',
        'line\nbreak': 'x',
        '`tick`': 'x',
        $x: 'x',
        'a.b': 'x',
        constructor: 'x',
        'x\u2028y': 'x',
      },
    ])
    // Built with a real own "__proto__" key, as documents from the driver have.
    const withProto = analyse([JSON.parse('{"__proto__": {"polluted": true}}') as Record<string, unknown>])
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined()

    for (const a of [hostile, withProto]) {
      const source = toTypeScript(a, 'Hostile')
      const file = ts.createSourceFile('x.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
      expect((file as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics, source).toEqual([])

      const mongoose = toMongoose(a, 'Hostile')
      expect(() => parse(mongoose, { ecmaVersion: 'latest', sourceType: 'module' }), mongoose).not.toThrow()
      expect(mongoose).not.toMatch(/^\s*"?__proto__"?\s*:/m)

      const schema = toJsonSchema(a)
      const again = JSON.parse(JSON.stringify(schema)) as { properties: Record<string, unknown> }
      expect(Object.keys(again.properties).sort()).toEqual(Object.keys(schema.properties as object).sort())
      expect(Object.getPrototypeOf(schema.properties)).not.toHaveProperty('polluted')
    }
    expect(Object.keys(toJsonSchema(withProto).properties as object)).toEqual(['__proto__'])
    expect(toTypeScript(hostile, 'H')).toContain('"line\\nbreak": string')
  })
})

describe('final review 1i: export fidelity', () => {
  it('keeps null in a JSON Schema type, leaves unknown types open, and accepts any number (Important 3)', () => {
    const a = analyse([
      { s: 'x', n: 1, odd: 'y' },
      { s: null, n: 2.5, odd: new Date(0) },
      { s: 'z', n: 3, odd: { deep: 1 } },
    ])
    const deep = analyse([{ v: 1 }])
    deep.fields[0]!.types = { string: 1, other: 1 }
    expect((toJsonSchema(a).properties as Record<string, unknown>).s).toEqual({
      bsonType: ['null', 'string'],
    })
    expect((toJsonSchema(a).properties as Record<string, unknown>).n).toEqual({ bsonType: 'number' })
    expect((toJsonSchema(deep).properties as Record<string, unknown>).v).toEqual({})
    // Null present: not required either.
    expect(toJsonSchema(a).required).toEqual(['n', 'odd'])
  })

  it('leaves dotted keys out of Mongoose, maps Long to BigInt, and types long as number | Long (Minors 9-11)', () => {
    const a = analyse([{ 'a.b': 'x', big: Long.fromNumber(7), ok: 1 }])
    const mongoose = toMongoose(a, 'T')
    expect(mongoose).toContain('// "a.b" is left out: Mongoose reads a dot as a nested path.')
    expect(mongoose).not.toMatch(/^\s*"a\.b":/m)
    expect(mongoose).toContain('big: { type: BigInt, required: true }')
    const typescript = toTypeScript(a, 'T')
    expect(typescript).toContain('big: number | Long')
    expect(typescript).toContain("import type { Long } from 'bson'")
  })
})
