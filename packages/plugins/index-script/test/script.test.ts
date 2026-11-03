import { describe, expect, it } from 'vitest'
import {
  creationKey,
  creationOptions,
  holdsHidden,
  literal,
  madeIndexes,
  orderUncertain,
  writeScript,
  type CollectionIndexes,
} from '../src/script'

const int = (n: number) => ({ $numberInt: String(n) })
const ORDERS: CollectionIndexes = {
  coll: 'orders',
  indexes: [
    { name: '_id_', key: { _id: int(1) }, options: {} },
    {
      name: 'customerId_1_createdAt_-1',
      key: { customerId: int(1), createdAt: int(-1) },
      options: { unique: true },
    },
    {
      name: 'paid_recent',
      key: { status: int(1) },
      options: {
        partialFilterExpression: {
          status: 'paid',
          at: { $gte: { $date: { $numberLong: String(Date.UTC(2026, 0, 1)) } } },
          by: { $oid: '65a1b2c3d4e5f60718293a4b' },
        },
      },
    },
    {
      name: 'expires_1',
      key: { expires: int(1) },
      options: { expireAfterSeconds: int(3600), ns: 'shop.orders' },
    },
    {
      name: 'text',
      key: { _fts: 'text', _ftsx: int(1) },
      options: {
        weights: { title: int(10), body: int(1) },
        default_language: 'english',
        textIndexVersion: int(3),
      },
    },
  ],
}

describe('an index as it is made again', () => {
  it('leaves the default _id index out, makes a text index from its weights, and drops what the server keeps', () => {
    expect(madeIndexes(ORDERS.indexes).map((i) => i.name)).not.toContain('_id_')
    // A clustered index is made with its collection, whatever its name (review 2026-10-28).
    expect(
      madeIndexes([{ name: 'byId', key: { _id: int(1) }, options: { unique: true, clustered: true } }]),
    ).toEqual([])
    const text = ORDERS.indexes[4]!
    expect(creationKey(text)).toEqual({ title: 'text', body: 'text' })
    expect(
      creationKey({
        name: 'c',
        key: { a: int(1), _fts: 'text', _ftsx: int(1), z: int(-1) },
        options: { weights: { t: int(1) } },
      }),
    ).toEqual({
      a: int(1),
      t: 'text',
      z: int(-1),
    })
    expect(creationOptions(ORDERS.indexes[3]!)).toEqual({ name: 'expires_1', expireAfterSeconds: int(3600) })
  })

  it('tells an index holding a value hidden from the user', () => {
    expect(holdsHidden({ partialFilterExpression: { email: '***' } })).toBe(true)
    expect(holdsHidden({ partialFilterExpression: { email: { $in: ['a', '***'] } } })).toBe(true)
    expect(holdsHidden({ partialFilterExpression: { email: 'a***' } })).toBe(false)
  })

  it('tells a key whose fields may have come in another order: names that are numbers', () => {
    expect(orderUncertain({ '2': int(1), a: int(1) })).toBe(true)
    expect(orderUncertain({ '0': int(1), a: int(1) })).toBe(true)
    expect(orderUncertain({ '2': int(1) })).toBe(false)
    // Not array indexes: an object keeps their place.
    expect(
      orderUncertain({ a: int(1), '02': int(1), '-1': int(1), '1.5': int(1), '4294967295': int(1) }),
    ).toBe(false)
  })
})

describe('values as each language writes them', () => {
  it('writes the typed values of mongosh, Node.js and Python', () => {
    const v = {
      i: int(5),
      d: { $numberDouble: '2' },
      f: { $numberDouble: '1.5' },
      l: { $numberLong: '9007199254740993' },
      m: { $numberDecimal: '1.10' },
      o: { $oid: '65a1b2c3d4e5f60718293a4b' },
      t: { $date: { $numberLong: '0' } },
      b: true,
      n: null,
      'odd key': 'x',
    }
    expect(literal(v, 'js')).toBe(
      '{ i: 5, d: 2.0, f: 1.5, l: NumberLong("9007199254740993"), m: NumberDecimal("1.10"), o: ObjectId("65a1b2c3d4e5f60718293a4b"), t: ISODate("1970-01-01T00:00:00.000Z"), b: true, n: null, "odd key": "x" }',
    )
    expect(literal(v, 'node')).toBe(
      '{ i: 5, d: 2.0, f: 1.5, l: Long.fromString("9007199254740993"), m: Decimal128.fromString("1.10"), o: new ObjectId("65a1b2c3d4e5f60718293a4b"), t: new Date("1970-01-01T00:00:00.000Z"), b: true, n: null, "odd key": "x" }',
    )
    expect(literal(v, 'python')).toBe(
      '{ "i": 5, "d": 2.0, "f": 1.5, "l": Int64(9007199254740993), "m": Decimal128("1.10"), "o": ObjectId("65a1b2c3d4e5f60718293a4b"), "t": datetime.fromisoformat("1970-01-01T00:00:00.000+00:00"), "b": True, "n": None, "odd key": "x" }',
    )
    expect(literal({ $numberDouble: 'NaN' }, 'python')).toBe('float("NaN")')
    expect(literal({ $numberDouble: '-Infinity' }, 'js')).toBe('-Infinity')
  })

  it('writes binary data, timestamps and the min and max keys as their own types', () => {
    // "AQI=" is the bytes 01 02.
    const v = {
      bin: { $binary: { base64: 'AQI=', subType: '04' } },
      ts: { $timestamp: { t: 1700000000, i: 2 } },
      lo: { $minKey: 1 },
      hi: { $maxKey: 1 },
    }
    expect(literal(v, 'js')).toBe(
      '{ bin: BinData(4, "AQI="), ts: Timestamp({ t: 1700000000, i: 2 }), lo: MinKey(), hi: MaxKey() }',
    )
    expect(literal(v, 'node')).toBe(
      '{ bin: new Binary(Buffer.from("0102", "hex"), 4), ts: new Timestamp({ t: 1700000000, i: 2 }), lo: new MinKey(), hi: new MaxKey() }',
    )
    expect(literal(v, 'python')).toBe(
      '{ "bin": Binary(bytes.fromhex("0102"), 4), "ts": Timestamp(1700000000, 2), "lo": MinKey(), "hi": MaxKey() }',
    )
    // Malformed ones stay as they came, never as code.
    expect(literal({ $binary: { base64: '"); x("', subType: '04' } }, 'js')).toBe(
      '{ $binary: { base64: "\\"); x(\\"", subType: "04" } }',
    )
    expect(literal({ $binary: { base64: 'AQI=', subType: 'zz' } }, 'python')).toBe(
      '{ "$binary": { "base64": "AQI=", "subType": "zz" } }',
    )
    expect(literal({ $timestamp: { t: '1); x(', i: 2 } }, 'node')).toBe(
      '{ $timestamp: { t: "1); x(", i: 2 } }',
    )
    // A date past what JavaScript holds does not stop the script: it is written as it came.
    expect(literal({ $date: { $numberLong: '9223372036854775807' } }, 'js')).toBe(
      '{ $date: NumberLong("9223372036854775807") }',
    )
  })

  it('writes a number only as digits, anything else as it came', () => {
    expect(literal({ $numberInt: '1); x(' }, 'js')).toBe('{ $numberInt: "1); x(" }')
    expect(literal({ $numberLong: '2); x(' }, 'python')).toBe('{ "$numberLong": "2); x(" }')
    expect(literal({ $numberLong: '-7' }, 'python')).toBe('Int64(-7)')
  })

  it('writes a field named __proto__ as a field, never as the prototype', () => {
    // As the app hands it: read from JSON, an own field.
    expect(literal(JSON.parse('{"__proto__": {"$numberInt": "1"}, "a": 1}'), 'js')).toBe(
      '{ ["__proto__"]: 1, a: 1 }',
    )
    expect(literal(JSON.parse('{"__proto__": 1}'), 'node')).toBe('{ ["__proto__"]: 1 }')
    expect(literal(JSON.parse('{"__proto__": 1}'), 'python')).toBe('{ "__proto__": 1 }')
    // An index on such a field keeps it in its key (checked on a real MongoDB with the Node.js driver).
    const proto = JSON.parse('{"name": "proto_1", "key": {"__proto__": {"$numberInt": "1"}}, "options": {}}')
    expect(writeScript([{ coll: 'c', indexes: [proto] }], 'node').text).toContain(
      'await db.collection("c").createIndex({ ["__proto__"]: 1 }, { name: "proto_1" })',
    )
    const text = JSON.parse(
      '{"name": "t", "key": {"_fts": "text", "_ftsx": {"$numberInt": "1"}}, "options": {"weights": {"__proto__": {"$numberInt": "1"}}}}',
    )
    expect(Object.keys(creationKey(text))).toEqual(['__proto__'])
  })

  it('quotes every string, so no text becomes code', () => {
    expect(literal('a"); dropDatabase(); ("', 'js')).toBe('"a\\"); dropDatabase(); (\\""')
    expect(literal({ 'a"b': 1 }, 'python')).toBe('{ "a\\"b": 1 }')
    // JavaScript ends a line at U+2028 and U+2029 too: they are written as escapes.
    expect(literal('a\u2028b\u2029c\u0085d', 'js')).toBe('"a\\u2028b\\u2029c\\u0085d"')
  })

  it('keeps an index name with a line break in its comment line, so no part of it becomes code', () => {
    for (const end of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
      const name = `vip${end}print("harmless")`
      const masked: CollectionIndexes = {
        coll: 'users',
        indexes: [{ name, key: { email: int(1) }, options: { partialFilterExpression: { email: '***' } } }],
      }
      for (const format of ['mongosh', 'node', 'python'] as const) {
        const text = writeScript([masked], format).text
        const lines = text.split(/\r\n|[\n\r\u2028\u2029]/)
        // Every line is a comment, an import, empty, or one making an index.
        for (const line of lines) expect(line).toMatch(/^(|\/\/ .*|# .*|import .*|from .*|db.*|await db.*)$/)
        expect(lines.filter((l) => l.includes('print('))).toHaveLength(2)
        expect(lines.some((l) => l.startsWith('print('))).toBe(false)
      }
    }
  })
})

describe('the script', () => {
  it('in mongosh: one createIndex a line, keys in order, options with the name first', () => {
    const { text, count, hidden } = writeScript([ORDERS], 'mongosh')
    expect(count).toBe(4)
    expect(hidden).toEqual([])
    expect(text.split('\n')).toEqual([
      'db.getCollection("orders").createIndex({ customerId: 1, createdAt: -1 }, { name: "customerId_1_createdAt_-1", unique: true })',
      'db.getCollection("orders").createIndex({ status: 1 }, { name: "paid_recent", partialFilterExpression: { status: "paid", at: { $gte: ISODate("2026-01-01T00:00:00.000Z") }, by: ObjectId("65a1b2c3d4e5f60718293a4b") } })',
      'db.getCollection("orders").createIndex({ expires: 1 }, { name: "expires_1", expireAfterSeconds: 3600 })',
      'db.getCollection("orders").createIndex({ title: "text", body: "text" }, { name: "text", weights: { title: 10, body: 1 }, default_language: "english", textIndexVersion: 3 })',
      '',
    ])
  })

  it('for Node.js and Python, with what the code needs', () => {
    const node = writeScript([ORDERS], 'node').text
    expect(node).toContain(
      "import { Binary, Decimal128, Long, MaxKey, MinKey, MongoClient, ObjectId, Timestamp } from 'mongodb'",
    )
    expect(node).toContain('// const db = new MongoClient(uri).db("…")')
    expect(node).toContain(
      'await db.collection("orders").createIndex({ customerId: 1, createdAt: -1 }, { name: "customerId_1_createdAt_-1", unique: true })',
    )
    expect(node).toContain('by: new ObjectId("65a1b2c3d4e5f60718293a4b")')
    const python = writeScript([ORDERS], 'python').text
    expect(python).toContain(
      'from bson import Binary, Decimal128, Int64, MaxKey, MinKey, ObjectId, Timestamp',
    )
    expect(python).toContain('from pymongo import MongoClient')
    expect(python).toContain(
      'db["orders"].create_index([("customerId", 1), ("createdAt", -1)], name="customerId_1_createdAt_-1", unique=True)',
    )
    expect(python).toContain(
      'db["orders"].create_index([("expires", 1)], name="expires_1", expireAfterSeconds=3600)',
    )
    // An option named as no Python identifier goes in a dict.
    const odd = writeScript(
      [{ coll: 'c', indexes: [{ name: 'a_1', key: { a: int(1) }, options: { 'odd-option': true } }] }],
      'python',
    )
    expect(odd.text).toContain('db["c"].create_index([("a", 1)], name="a_1", **{ "odd-option": True })')
  })

  it('makes an index whose options the driver’s createIndex would leave out with the createIndexes command', () => {
    const prepared: CollectionIndexes = {
      coll: 'users',
      indexes: [{ name: 'email_1', key: { email: int(1) }, options: { sparse: true, prepareUnique: true } }],
    }
    expect(writeScript([prepared], 'mongosh').text).toBe(
      'db.runCommand({ createIndexes: "users", indexes: [{ key: { email: 1 }, name: "email_1", sparse: true, prepareUnique: true }] })\n',
    )
    expect(writeScript([prepared], 'node').text).toContain(
      'await db.command({ createIndexes: "users", indexes: [{ key: { email: 1 }, name: "email_1", sparse: true, prepareUnique: true }] })',
    )
    // PyMongo passes every option on.
    expect(writeScript([prepared], 'python').text).toContain(
      'db["users"].create_index([("email", 1)], name="email_1", sparse=True, prepareUnique=True)',
    )
  })

  it('says when a key’s fields may be in another order', () => {
    const odd: CollectionIndexes = {
      coll: 'c',
      indexes: [{ name: 'a_1_2_1', key: { a: int(1), '2': int(1) }, options: {} }],
    }
    const script = writeScript([odd], 'mongosh')
    expect(script.unordered).toEqual(['c.a_1_2_1'])
    expect(script.text).toContain(
      '// "a_1_2_1": its key\'s fields may be in another order (names that are numbers come first once read)',
    )
    expect(writeScript([ORDERS], 'mongosh').unordered).toEqual([])
  })

  it('says when a date JavaScript cannot hold is written as it came, and flags an uncertain key order in JSON', () => {
    const far: CollectionIndexes = {
      coll: 'c',
      indexes: [
        {
          name: 'far',
          key: { at: int(1) },
          options: {
            partialFilterExpression: { at: { $gt: { $date: { $numberLong: '9223372036854775807' } } } },
          },
        },
        { name: 'a_1_2_1', key: { a: int(1), '2': int(1) }, options: {} },
      ],
    }
    expect(writeScript([far], 'mongosh').text).toContain(
      '// "far": a date past what JavaScript holds is written as it came: set it by hand',
    )
    expect(writeScript([far], 'python').text).toContain('# "far": a date past what JavaScript holds')
    const json = JSON.parse(writeScript([far], 'json').text)
    expect(json[1].keyOrderUncertain).toBe(true)
    expect(json[0].farDate).toBe(true)
    expect(json[1].farDate).toBeUndefined()
    expect(json[0].keyOrderUncertain).toBeUndefined()
  })

  it('names at its top the collections whose indexes could not be read', () => {
    expect(writeScript([ORDERS], 'mongosh', ['logs', 'a"b']).text.split('\n')[0]).toBe(
      '// Not in this script: the indexes of "logs", "a\\"b" could not be read',
    )
    expect(writeScript([ORDERS], 'python', ['logs']).text).toContain(
      '# Not in this script: the indexes of "logs" could not be read',
    )
    expect(writeScript([ORDERS], 'mongosh').text).not.toContain('Not in this script')
  })

  it('as JSON: every collection’s indexes, exact, as canonical Extended JSON', () => {
    const json = JSON.parse(
      writeScript(
        [ORDERS, { coll: 'users', indexes: [{ name: 'email_1', key: { email: int(1) }, options: {} }] }],
        'json',
      ).text,
    )
    expect(json).toHaveLength(5)
    expect(json[0]).toEqual({
      collection: 'orders',
      key: { customerId: int(1), createdAt: int(-1) },
      options: { name: 'customerId_1_createdAt_-1', unique: true },
    })
    expect(json[4]).toEqual({ collection: 'users', key: { email: int(1) }, options: { name: 'email_1' } })
  })

  it('says which indexes hold values hidden from the user, and writes them so', () => {
    const masked: CollectionIndexes = {
      coll: 'users',
      indexes: [
        { name: 'vip', key: { email: int(1) }, options: { partialFilterExpression: { email: '***' } } },
      ],
    }
    const script = writeScript([masked], 'mongosh')
    expect(script.hidden).toEqual(['users.vip'])
    expect(script.text).toContain(
      '// "vip" holds values hidden from you, written as "***": not the index as it is',
    )
    expect(writeScript([masked], 'python').text).toContain('# "vip" holds values hidden from you')
    expect(JSON.parse(writeScript([masked], 'json').text)[0].hiddenValues).toBe(true)
  })
})
