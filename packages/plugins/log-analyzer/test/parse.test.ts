// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { parseLine, shapeOf } from '../src/parse'

/**
 * Plugins wave 3 (spec §7; mtools' mloginfo, NoSQLBooster's log parser): a log line read — the
 * structured JSON of 4.4 and later, and the legacy text best-effort — and a query's shape, its
 * values replaced by ?.
 */
const slow = JSON.stringify({
  t: { $date: '2026-10-26T10:00:01.123+00:00' },
  s: 'I',
  c: 'COMMAND',
  id: 51803,
  ctx: 'conn42',
  msg: 'Slow query',
  attr: {
    type: 'command',
    ns: 'shop.orders',
    command: {
      find: 'orders',
      filter: { status: 'paid', total: { $gt: 100 }, userId: { $in: [1, 2, 3] } },
      sort: { at: -1 },
      $db: 'shop',
    },
    planSummary: 'COLLSCAN',
    keysExamined: 0,
    docsExamined: 5000,
    nreturned: 12,
    durationMillis: 230,
  },
})

describe('a log line', () => {
  it('reads a slow operation of the structured log, its values left out of its shape', () => {
    expect(parseLine(slow)).toEqual({
      kind: 'slow',
      at: Date.parse('2026-10-26T10:00:01.123Z'),
      severity: 'I',
      component: 'COMMAND',
      ns: 'shop.orders',
      op: 'find',
      shape: '{"filter":{"status":"?","total":{"$gt":"?"},"userId":{"$in":"?"}},"sort":{"at":-1}}',
      ms: 230,
      plan: 'COLLSCAN',
      keysExamined: 0,
      docsExamined: 5000,
      returned: 12,
    })
  })

  it('reads connections, errors and the server it came from', () => {
    const line = (o: Record<string, unknown>) =>
      JSON.stringify({
        t: { $date: '2026-10-26T10:00:00.000Z' },
        s: 'I',
        c: 'NETWORK',
        ctx: 'listener',
        ...o,
      })
    expect(
      parseLine(
        line({
          id: 22943,
          msg: 'Connection accepted',
          attr: { remote: '10.1.2.3:51234', connectionCount: 7 },
        }),
      ),
    ).toMatchObject({
      kind: 'connection',
      event: 'opened',
      client: '10.1.2.3',
      count: 7,
    })
    expect(
      parseLine(line({ id: 22944, msg: 'Connection ended', attr: { remote: '10.1.2.3:51234' } })),
    ).toMatchObject({ kind: 'connection', event: 'ended', client: '10.1.2.3' })
    expect(
      parseLine(
        line({
          id: 51800,
          msg: 'client metadata',
          attr: { remote: '10.1.2.3:51234', doc: { application: { name: 'billing' } } },
        }),
      ),
    ).toMatchObject({
      kind: 'connection',
      event: 'metadata',
      client: '10.1.2.3',
      app: 'billing',
    })
    expect(
      parseLine(line({ s: 'E', c: 'STORAGE', id: 22435, msg: 'WiredTiger error', attr: { error: 28 } })),
    ).toMatchObject({
      kind: 'message',
      severity: 'E',
      id: 22435,
      msg: 'WiredTiger error',
    })
    expect(
      parseLine(line({ id: 23403, msg: 'Build Info', attr: { buildInfo: { version: '8.0.4' } } })),
    ).toMatchObject({ kind: 'server', version: '8.0.4' })
    expect(
      parseLine(line({ id: 4615611, msg: 'MongoDB starting', attr: { host: 'db1', pid: 1 } })),
    ).toMatchObject({ kind: 'server', host: 'db1' })
  })

  it('reads the legacy text log, best-effort', () => {
    const legacy =
      '2020-01-01T10:00:00.000+0000 I COMMAND  [conn9] command shop.orders command: find { find: "orders", filter: { status: "paid" } } planSummary: IXSCAN { status: 1 } keysExamined:3 docsExamined:3 numYields:0 nreturned:3 reslen:500 105ms'
    expect(parseLine(legacy)).toMatchObject({
      kind: 'slow',
      at: Date.parse('2020-01-01T10:00:00.000Z'),
      ns: 'shop.orders',
      op: 'find',
      ms: 105,
      plan: 'IXSCAN { status: 1 }',
      keysExamined: 3,
      docsExamined: 3,
      returned: 3,
      shape: '{ find: ?, filter: { status: ? } }',
    })
    expect(parseLine('2020-01-01T10:00:00.000+0000 W NETWORK  [conn9] something odd')).toMatchObject({
      kind: 'message',
      severity: 'W',
      msg: 'something odd',
    })
  })

  it('takes a line that is no log line for unreadable, and an ordinary one for an event', () => {
    for (const line of ['', 'hello', '{not json', '\u0000\u0001binary'])
      expect(parseLine(line), line).toEqual({ kind: 'unreadable' })
    expect(
      parseLine(
        JSON.stringify({ t: { $date: '2026-10-26T10:00:00Z' }, s: 'I', c: 'CONTROL', id: 1, msg: 'x' }),
      ),
    ).toMatchObject({ kind: 'event', severity: 'I' })
  })
})

describe('a query’s shape', () => {
  it('keeps keys and operators, replaces values, and stays short', () => {
    expect(shapeOf({ a: 1, b: { $in: [1, 2] }, c: [{ d: 'x' }], e: null })).toEqual({
      a: '?',
      b: { $in: '?' },
      c: [{ d: '?' }],
      e: '?',
    })
    expect(shapeOf([{ $match: { x: 5 } }, { $group: { _id: '$k', n: { $sum: 1 } } }])).toEqual([
      { $match: { x: '?' } },
      { $group: { _id: '?', n: { $sum: '?' } } },
    ])
  })

  // Wave 3 review: a list of ObjectIds made a shape of each length.
  it('takes a list of Extended JSON values for one value, whatever its length', () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => ({ $oid: `65a1b2c3d4e5f6071829300${i}` }))
    expect(shapeOf({ _id: { $in: ids(2) } })).toEqual({ _id: { $in: '?' } })
    expect(shapeOf({ _id: { $in: ids(5) } })).toEqual(shapeOf({ _id: { $in: ids(2) } }))
    expect(
      shapeOf({ at: { $in: [{ $date: '2026-01-01T00:00:00Z' }, { $numberLong: '5' }, 'x', 3] } }),
    ).toEqual({ at: { $in: '?' } })
    // A list holding a document still keeps it.
    expect(shapeOf({ $or: [{ $oid: 'x' }, { a: 1 }] })).toEqual({ $or: ['?', { a: '?' }] })
  })
})

describe('the legacy text log, review fixes', () => {
  const head = '2020-01-01T10:00:00.000+0000 I COMMAND  [conn9] '
  it('keeps no value in a legacy shape: numbers in lists, regular expressions, true, false, null', () => {
    const line = parseLine(
      `${head}command shop.orders command: find { find: "orders", filter: { a: { $in: [ 1, 2, 3 ] }, b: /^ada/i, c: true, d: null, e: 'x' } } planSummary: COLLSCAN keysExamined:0 docsExamined:9 nreturned:1 reslen:5 120ms`,
    )
    expect(line).toMatchObject({ kind: 'slow' })
    const shape = (line as { shape: string }).shape
    expect(shape).toBe('{ find: ?, filter: { a: { $in: ? }, b: ?, c: ?, d: ?, e: ? } }')
    for (const value of ['1', '2', '3', 'ada', 'true', 'null', "'x'"]) expect(shape).not.toContain(value)
  })

  it('shapes the legacy query, update and remove lines by their query', () => {
    expect(
      parseLine(
        `${head}query shop.orders query: { status: "paid", total: { $gt: 5 } } planSummary: COLLSCAN ntoreturn:0 ntoskip:0 nscanned:9 keysExamined:0 docsExamined:9 nreturned:1 reslen:5 150ms`,
      ),
    ).toMatchObject({ kind: 'slow', op: 'query', shape: '{ status: ?, total: { $gt: ? } }', ms: 150 })
    expect(
      parseLine(
        `${head}update shop.orders query: { _id: ObjectId('65a1b2c3d4e5f60718293a00') } update: { $set: { a: 1 } } keysExamined:1 docsExamined:1 nMatched:1 nModified:1 130ms`,
      ),
    ).toMatchObject({ kind: 'slow', op: 'update', shape: '{ _id: ? }' })
  })

  it('groups legacy messages by their wording, the values in them left out', () => {
    const a = parseLine(
      `${head.replace(' I ', ' W ')}Connection to 10.0.0.1:27017 failed after 3 tries ("timeout")`,
    )
    const b = parseLine(
      `${head.replace(' I ', ' W ')}Connection to 10.0.0.9:27018 failed after 12 tries ("refused")`,
    )
    expect(a).toMatchObject({ kind: 'message', msg: 'Connection to ? failed after ? tries (?)' })
    expect((b as { msg: string }).msg).toBe((a as { msg: string }).msg)
    expect(
      parseLine(`${head.replace(' I ', ' E ')}Assertion 0x1f3a at 65a1b2c3d4e5f60718293a00 code 11000`),
    ).toMatchObject({ msg: 'Assertion ? at ? code ?' })
  })
})
