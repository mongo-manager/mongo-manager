import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { BSON, Decimal128, Double, Long, ObjectId } from 'bson'
import { toWire } from '@mongo-manager/shared'
import {
  READ_OPTIONS,
  ejsonHazards as hazardsOf,
  fromClient,
  hashDocument,
  toClientDocument,
} from '../src/data/ejson-io'
import { ranOutOfTime, toAppError } from '../src/data/mongo-errors'
import { AppError } from '../src/errors'
import { ConnectionError } from '../src/connections/errors'
import { resolveConfig } from '../src/config'

const KEY = randomBytes(32)

describe('EJSON I/O', () => {
  it('serializes documents losslessly and flags ones that cannot be shown', () => {
    const doc = {
      _id: new ObjectId('65f0a1b2c3d4e5f601234567'),
      d: new Double(1),
      l: Long.fromString('9007199254740993'),
      m: Decimal128.fromString('1.10'),
    }
    const item = toClientDocument(doc, (d) => hashDocument(d, KEY, 'd.c'))
    expect('document' in item && toWire(fromClient(item.document, 'doc'))).toBe(toWire(doc))
    const bad = toClientDocument({ _id: 7, nested: { when: new Date(Number.NaN) } }, (d) =>
      hashDocument(d, KEY, 'd.c'),
    )
    expect(bad).toEqual({
      unsupported: { _id: { $numberInt: '7' }, reason: expect.stringMatching(/nested\.when.*range/) },
    })
  })

  it('rejects malformed Extended JSON with a validation error', () => {
    try {
      fromClient({ n: { $numberLong: 'abc' } }, 'filter')
      expect.unreachable()
    } catch (e) {
      expect((e as AppError).code).toBe('VALIDATION_ERROR')
      expect((e as AppError).message).toMatch(/^filter/)
    }
  })
})

// Data review 2026-10-13 (I2, M1, M2): what in a stored document the app would not read back as it is
// — found by a walk, never by a round trip of the whole document.
describe('ejsonHazards', () => {
  const ejsonHazards = (doc: Parameters<typeof hazardsOf>[0]) =>
    hazardsOf(doc).map(({ path, kind }) => ({ path, kind }))
  // A raw BSON document of one field: its type byte, its name "x" and its value's bytes.
  const raw = (type: number, value: number[]) => {
    const bytes = [0, 0, 0, 0, type, 0x78, 0, ...value, 0]
    bytes[0] = bytes.length
    return BSON.deserialize(Uint8Array.from(bytes), READ_OPTIONS)
  }

  it('names each field named like Extended JSON, at any depth', () => {
    expect(
      ejsonHazards({
        _id: 1,
        a: { $numberInt: '5' },
        list: [{ ok: 1 }, { $oid: '652629f0c3e5b2a1d4f0a9b7' }],
        deep: { m: { $minKey: 1, other: 'kept' }, d: { $date: '2026-01-01' }, c: { $code: 'x' } },
        p: { $dbPointer: { $ref: 'c', $id: 1 } },
        u: { $undefined: true },
      }),
    ).toEqual([
      { path: 'a', kind: 'ejson_like' },
      { path: 'list.1', kind: 'ejson_like' },
      { path: 'deep.m', kind: 'ejson_like' },
      { path: 'deep.d', kind: 'ejson_like' },
      { path: 'deep.c', kind: 'ejson_like' },
      { path: 'p', kind: 'ejson_like' },
      { path: 'u', kind: 'ejson_like' },
    ])
  })

  it('leaves what reads back as it is: typed values, other $-names, a $ref with no $id', () => {
    expect(
      ejsonHazards({
        _id: new ObjectId(),
        n: new Double(1),
        l: Long.fromString('9007199254740993'),
        d: Decimal128.fromString('1.5'),
        $foo: 1,
        nested: { $foo: { bar: 1 }, $ref: 'c', $date: null, $numberInt: null },
        when: new Date(0),
        re: /x/i,
      }),
    ).toEqual([])
  })

  it('reads $undefined as bson does: only a true one is undefined', () => {
    expect(ejsonHazards({ a: { $undefined: false }, b: { $undefined: 0 } })).toEqual([])
    expect(ejsonHazards({ a: { $undefined: 1 } })).toEqual([{ path: 'a', kind: 'ejson_like' }])
  })

  // Round 2 (M13): an _id the app would read as another value is never given out as that value —
  // a delete by it would remove the other document. (MongoDB 5+ refuses to store one; older
  // servers did not.)
  it('gives out no document whose _id it would misread', () => {
    const item = toClientDocument({ _id: { $numberInt: '5' }, a: 1 }, () => 'h')
    expect(item).toEqual({ unsupported: { _id: null, reason: expect.stringContaining('shell') } })
    expect(toClientDocument({ _id: 5, a: { $numberInt: '5' } }, () => 'h')).toMatchObject({
      caution: { kind: 'ejson_like', field: 'a' },
    })
  })

  it('takes any NaN as the NaN it is', () => {
    // 0xFFF8000000000000 (.NET, x86 0/0) and 0x7FF8000000000001 (Go): not the standard NaN's bits.
    expect(ejsonHazards(raw(0x01, [0, 0, 0, 0, 0, 0, 0xf8, 0xff]))).toEqual([])
    expect(ejsonHazards(raw(0x01, [1, 0, 0, 0, 0, 0, 0xf8, 0x7f]))).toEqual([])
  })

  it('gives each its field names as a personal-data rule names them, without array positions', () => {
    expect(hazardsOf({ list: [{ a: { $oid: '652629f0c3e5b2a1d4f0a9b7' } }] })).toEqual([
      { path: 'list.0.a', fields: ['list', 'a'], kind: 'ejson_like' },
    ])
  })

  it('names an undefined value apart: it reads back as null', () => {
    expect(ejsonHazards(raw(0x06, []))).toEqual([{ path: 'x', kind: 'undefined' }])
    expect(ejsonHazards({ list: [1, undefined] })).toEqual([{ path: 'list.1', kind: 'undefined' }])
  })

  it('is quick on a large document', () => {
    const big = {
      rows: Array.from({ length: 50_000 }, (_, i) => ({ i, name: `row ${i}`, tags: ['a', 'b'] })),
    }
    const started = performance.now()
    expect(ejsonHazards(big)).toEqual([])
    expect(performance.now() - started).toBeLessThan(500)
  })

  it('takes a document deeper than it walks as one it cannot read back', () => {
    let deep: Record<string, unknown> = { leaf: 1 }
    for (let i = 0; i < 400; i++) deep = { d: deep }
    expect(ejsonHazards(deep)).toHaveLength(1)
  })
})

describe('toAppError', () => {
  const mongo = (code: number, extra: object = {}) =>
    Object.assign(new Error('boom mongodb://u:p@h/x'), { name: 'MongoServerError', code, ...extra })

  it('maps well-known server errors', () => {
    const dup = toAppError(mongo(11000, { keyValue: { email: 'a@b' }, keyPattern: { email: 1 } })) as AppError
    expect([dup.statusCode, dup.code]).toEqual([409, 'CONFLICT'])
    expect(dup.details).toMatchObject({ keyValue: { email: 'a@b' } })
    expect((toAppError(mongo(50)) as AppError).statusCode).toBe(504)
    expect((toAppError(mongo(13)) as AppError).code).toBe('FORBIDDEN')
    expect((toAppError(mongo(26)) as AppError).statusCode).toBe(404)
    expect((toAppError(mongo(48)) as AppError).statusCode).toBe(409)
    // A server, a shard or a primary not there for now: try again, not a bad request (review of the
    // agent's gate, nit).
    for (const code of [6, 91, 133, 189, 202, 9001, 10107, 11600, 11602])
      expect((toAppError(mongo(code)) as AppError).statusCode).toBe(503)
    // ExceededTimeLimit is a time limit.
    expect((toAppError(mongo(262)) as AppError).statusCode).toBe(504)
    // A gate's failed index listing is answered as the failure it was.
    const listing = Object.assign(new Error('listing'), { name: 'IndexListingFailed', cause: mongo(50) })
    expect((toAppError(listing) as AppError).statusCode).toBe(504)
    const other = toAppError(mongo(2)) as AppError
    expect([other.statusCode, other.code]).toEqual([400, 'MONGO_ERROR'])
    expect(other.message).not.toContain('u:p@h')
  })

  const timedOut = (message: string, cause?: object) =>
    Object.assign(new Error(message), { name: 'MongoOperationTimeoutError', ...(cause ? { cause } : {}) })
  const selection = (after: number) =>
    Object.assign(new Error(`Server selection timed out after ${after} ms`), {
      name: 'MongoServerSelectionError',
    })

  it('maps an operation’s own time limit (timeoutMS, set by the app on a few commands) as the server’s', () => {
    const bare = timedOut('Timed out during socket read (2000ms)')
    const answer = toAppError(bare) as AppError
    expect([answer.statusCode, answer.message, answer.details]).toEqual([
      504,
      'The operation exceeded its time limit',
      undefined,
    ])
    expect(ranOutOfTime(bare)).toBe(true)
    const server = toAppError(
      timedOut('Server reported a timeout error', mongo(50, { codeName: 'MaxTimeMSExpired' })),
    ) as AppError
    expect([server.statusCode, server.details]).toEqual([504, { code: 50, codeName: 'MaxTimeMSExpired' }])
    // Only MongoDB's own time limit is named in the details: another cause is not.
    const conflict = toAppError(
      timedOut('Timed out during withTransaction', mongo(112, { codeName: 'WriteConflict' })),
    ) as AppError
    expect([conflict.statusCode, conflict.details]).toEqual([504, undefined])
    expect(ranOutOfTime(mongo(50))).toBe(true)
    expect(ranOutOfTime(mongo(2))).toBe(false)
  })

  it('maps a timeoutMS spent failing to reach the server as not reaching it', () => {
    const e = timedOut('Timed out during server selection', selection(3000))
    const answer = toAppError(e) as AppError
    expect([answer.statusCode, answer.details]).toEqual([502, { kind: 'network' }])
    expect(ranOutOfTime(e)).toBe(false)
  })

  it('maps a selection begun with no time left as the time limit', () => {
    // The driver's words when the operation's time was gone before it could select a server.
    const e = timedOut('Timed out during server selection', selection(0))
    expect((toAppError(e) as AppError).statusCode).toBe(504)
    expect(ranOutOfTime(e)).toBe(true)
  })

  it('maps a full connection pool as busy, with or without timeoutMS', () => {
    const wait = Object.assign(new Error('Timed out while checking out a connection from connection pool'), {
      name: 'MongoWaitQueueTimeoutError',
    })
    for (const e of [wait, timedOut('Timed out during connection checkout', wait)]) {
      const answer = toAppError(e) as AppError
      expect([answer.statusCode, answer.message, answer.details]).toEqual([
        503,
        'No connection to the MongoDB server was free in time; try again shortly',
        { kind: 'pool' },
      ])
      expect(ranOutOfTime(e)).toBe(false)
    }
  })

  it('maps connection failures to 502 and leaves unrelated errors alone', () => {
    expect((toAppError(new ConnectionError('network', 'down')) as AppError).statusCode).toBe(502)
    const plain = new TypeError('x')
    expect(toAppError(plain)).toBe(plain)
  })
})

describe('allowServerJs setting', () => {
  it('defaults to false and reads MM_ALLOW_SERVER_JS', () => {
    expect(resolveConfig({}).allowServerJs).toBe(false)
    expect(resolveConfig({ env: { MM_ALLOW_SERVER_JS: '1' } }).allowServerJs).toBe(true)
  })
})
