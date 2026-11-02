import { describe, expect, it } from 'vitest'
import { staticComplete, type CompletionContext } from '../src/shell/complete/static'

/**
 * Phase 3a-2 spec §3.1: completion in the browser from the generated catalogue, the connection's
 * collections and the sampled field names. Database text is inserted only as safe code.
 */
const HOSTILE = 'a"]);db.dropDatabase();x["'
const ctx: CompletionContext = {
  collections: ['orders', 'my coll', HOSTILE],
  fields: (coll) => (coll === 'orders' ? ['name', 'a b', 'a.b', 'total'] : []),
}
const at = (text: string) => staticComplete(text, text.length, ctx)
const labels = (text: string) => at(text)?.items.map((i) => i.label) ?? null

describe('staticComplete — members', () => {
  it('offers collections first, then Database methods, after db.', () => {
    const r = at('db.')!
    expect(r.from).toBe(2)
    const first = r.items.slice(0, 3)
    expect(first.map((i) => i.kind)).toEqual(['collection', 'collection', 'collection'])
    expect(r.items.find((i) => i.label === 'orders')).toMatchObject({ insert: '.orders' })
    expect(r.items.find((i) => i.label === 'my coll')).toMatchObject({ insert: '["my coll"]' })
    expect(r.items.find((i) => i.label === 'getCollectionNames')).toMatchObject({
      kind: 'method',
      insert: '.getCollectionNames',
    })
  })

  it('inserts a hostile collection name as one quoted string (review focus 2)', () => {
    const item = at('db.')!.items.find((i) => i.label === HOSTILE)!
    expect(item.insert).toBe(`[${JSON.stringify(HOSTILE)}]`)
  })

  // CodeQL 2026-11-01: a single-quoted name is read escape by escape; \" in it no longer stops completion.
  it('follows a collection named in single quotes, whatever it escapes', () => {
    expect(labels(`db['a\\"b'].`)).toContain('find')
    expect(labels(`db['it\\'s'].`)).toContain('find')
    expect(labels(`db['tab\\tname'].`)).toContain('find')
  })

  it('reaches a collection named like a Database member through getCollection (final review M6)', () => {
    const named = (coll: string) =>
      staticComplete('db.', 3, { collections: [coll], fields: () => [] })!.items.find(
        (i) => i.kind === 'collection',
      )!
    expect(named('stats').insert).toBe('.getCollection("stats")')
    expect(named('constructor').insert).toBe('.getCollection("constructor")')
    expect(named('_name').insert).toBe('.getCollection("_name")')
    expect(named('orders').insert).toBe('.orders')
  })

  it('filters by a case-insensitive prefix, replacing from the dot', () => {
    const r = at('db.OR')!
    expect(r.from).toBe(2)
    expect(r.items[0]).toMatchObject({ label: 'orders' })
  })

  it('follows the chain to Collection, Cursor and AggregationCursor methods', () => {
    expect(labels('db.orders.')).toEqual(expect.arrayContaining(['find', 'aggregate', 'insertOne']))
    expect(labels('db["my coll"].')).toEqual(expect.arrayContaining(['find']))
    expect(labels('db.getCollection("x").')).toEqual(expect.arrayContaining(['find']))
    expect(labels('db.orders.find({a:1}).')).toEqual(expect.arrayContaining(['limit', 'sort', 'toArray']))
    expect(labels('db.orders.aggregate([{ $match: { a: "x)" } }]).')).toEqual(
      expect.arrayContaining(['toArray']),
    )
  })
})

describe('staticComplete — operators and fields', () => {
  it('offers query operators first in a find filter, stages first in a pipeline', () => {
    const find = at('db.orders.find({ $')!
    expect(find.from).toBe('db.orders.find({ '.length)
    expect(find.items[0]!.kind).toBe('operator')
    expect(find.items.map((i) => i.label)).toContain('$in')
    // $m matches a stage ($match) and a query operator ($mod): in a pipeline the stage comes first.
    const agg = labels('db.orders.aggregate([{ $m')!
    expect(agg).toContain('$mod')
    expect(agg.indexOf('$match')).toBeLessThan(agg.indexOf('$mod'))
    const filter = labels('db.orders.find({ $m')!
    expect(filter.indexOf('$mod')).toBeLessThan(filter.indexOf('$match'))
  })

  it('offers sampled field names in a key position, quoting what is not an identifier', () => {
    const r = at('db.orders.find({ na')!
    expect(r.from).toBe('db.orders.find({ '.length)
    expect(r.items).toEqual([{ label: 'name', kind: 'field', insert: 'name' }])
    const all = at('db.orders.find({ total: 1, a')!.items
    expect(all.find((i) => i.label === 'a b')).toMatchObject({ insert: '"a b"' })
    expect(all.find((i) => i.label === 'a.b')).toMatchObject({ insert: '"a.b"' })
  })
})

describe('staticComplete — commands and fall-backs', () => {
  it('completes shell commands at the start of a line', () => {
    expect(labels('sh')).toContain('show')
    expect(labels('show ')).toEqual(expect.arrayContaining(['dbs', 'collections']))
    expect(labels('db.a.find()\nsh')).toContain('show')
  })

  it('leaves use, strings and unknown receivers to the worker', () => {
    expect(at('use ')).toBeNull()
    expect(at('db.orders.find({ a: "db.')).toBeNull()
    expect(at('c.')).toBeNull()
    expect(at('db.orders.nope().')).toBeNull()
  })
})
