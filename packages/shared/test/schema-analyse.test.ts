import { describe, expect, it, vi } from 'vitest'
import { Binary, Double, Int32, Long, ObjectId } from 'bson'
import { SchemaAnalyser, type SchemaAnalysis } from '../src/schema/analyse'

const analyse = (docs: Array<Record<string, unknown>>): SchemaAnalysis => {
  const a = new SchemaAnalyser()
  for (const d of docs) a.add(d)
  return a.result()
}
const field = (r: SchemaAnalysis, path: string) => r.fields.find((f) => f.path === path)!

describe('schema analysis (phase 1i spec §5)', () => {
  it('walks nested objects and arrays, counting presence and types', () => {
    const r = analyse([
      { a: { b: 1 }, tags: ['x', 'y'], n: new Int32(1) },
      { a: { b: 'two' }, n: new Double(2.5) },
      { tags: [] },
      { n: null },
    ])
    expect(r.sampled).toBe(4)
    expect(r.fields.map((f) => f.path)).toEqual(['a', 'a.b', 'n', 'tags', 'tags[]'])
    expect(field(r, 'a')).toMatchObject({ count: 2, types: { object: 2 }, keys: ['a'] })
    expect(field(r, 'a.b')).toMatchObject({ count: 2, types: { int: 1, string: 1 }, keys: ['a', 'b'] })
    expect(field(r, 'n').types).toEqual({ int: 1, double: 1, null: 1 })
    expect(field(r, 'tags')).toMatchObject({ count: 2, arrays: { minLength: 0, maxLength: 2, avgLength: 1 } })
    expect(field(r, 'tags[]')).toMatchObject({ count: 2, types: { string: 2 }, keys: ['tags', null] })
    expect(r.truncated).toBe(false)
  })

  it('keeps a dotted key apart from a nested path', () => {
    const r = analyse([{ 'a.b': 1, a: { b: 'x' } }])
    const dotted = r.fields.filter((f) => f.path === 'a.b')
    expect(dotted.map((f) => f.keys)).toEqual([['a', 'b'], ['a.b']])
  })

  it('bins numbers and dates into 10, with a single-value range in the first bin', () => {
    const r = analyse(
      Array.from({ length: 100 }, (_, i) => ({ v: i, same: 5, at: new Date(Date.UTC(2026, 0, 1 + i)) })),
    )
    const v = field(r, 'v').numbers!
    expect([v.min, v.max, v.bins.length]).toEqual([0, 99, 10])
    expect(v.bins.reduce((a, b) => a + b, 0)).toBe(100)
    expect(field(r, 'same').numbers!.bins).toEqual([100, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    const at = field(r, 'at').dates!
    expect(at.min).toBe('2026-01-01T00:00:00.000Z')
    expect(at.bins.reduce((a, b) => a + b, 0)).toBe(100)
    expect(field(r, 'v').types).toEqual({ int: 100 })
  })

  it('lists the ten most common values, cutting long strings, with ObjectIds as hex', () => {
    const id = new ObjectId('0123456789abcdef01234567')
    const docs = [
      ...Array.from({ length: 5 }, () => ({ s: 'b', id })),
      ...Array.from({ length: 5 }, () => ({ s: 'a' })),
      ...Array.from({ length: 12 }, (_, i) => ({ s: `x${i}` })),
      { s: 'y'.repeat(300), flag: true },
    ]
    const r = analyse(docs)
    const top = field(r, 's').top!
    expect(top).toHaveLength(10)
    expect(top.slice(0, 2)).toEqual([
      { value: 'a', count: 5, type: 'string' },
      { value: 'b', count: 5, type: 'string' },
    ])
    expect(field(r, 'id').top).toEqual([{ value: '0123456789abcdef01234567', count: 5, type: 'objectId' }])
    expect(field(r, 'flag').top).toEqual([{ value: 'true', count: 1, type: 'bool' }])
    expect(analyse([{ s: 'y'.repeat(300) }]).fields[0]!.top![0]!.value).toHaveLength(100)
  })

  // W2 (2026-10-16): a top value is a filter condition in the Schema tab, so its type is kept and a
  // value cut to 100 characters says so (an equality on the cut would match nothing).
  it('keeps each top value with its type, never merging "true" the string with true the boolean', () => {
    const r = analyse([{ v: 'true' }, { v: true }, { v: true }, { v: 'z'.repeat(150) }])
    expect(field(r, 'v').top).toEqual([
      { value: 'true', count: 2, type: 'bool' },
      { value: 'true', count: 1, type: 'string' },
      { value: 'z'.repeat(100), count: 1, type: 'string', cut: true },
    ])
  })

  it('finds GeoJSON points and legacy coordinate pairs, with how many values were places', () => {
    const r = analyse([
      { at: { type: 'Point', coordinates: [29.0, 41.0] }, loc: [13.4, 52.5], ll: { lng: -74, lat: 40.7 } },
      { at: { type: 'Point', coordinates: [new Double(2.35), new Int32(48)] }, loc: [200, 1] },
      {
        at: {
          type: 'MultiPoint',
          coordinates: [
            [1, 2],
            [3, 4],
          ],
        },
        loc: [1, 2, 3],
      },
      { at: { type: 'Point', coordinates: [10, 95] }, notGeo: { a: 1, b: 2 } },
      { at: 'nowhere' },
    ])
    expect(field(r, 'at').geo).toEqual({
      points: [
        [29, 41],
        [2.35, 48],
        [1, 2],
        [3, 4],
      ],
      count: 3,
      geojson: 3,
    })
    expect(field(r, 'loc').geo).toEqual({ points: [[13.4, 52.5]], count: 1, geojson: 0 })
    expect(field(r, 'll').geo).toEqual({ points: [[-74, 40.7]], count: 1, geojson: 0 })
    expect(field(r, 'notGeo').geo).toBeUndefined()
    expect(field(r, 'at.coordinates').geo).toBeUndefined()
  })

  // W2 review (minor 4): a field always holding two small numbers is no map unless its name says place.
  it('takes a bare pair for a place only under a name that says so', () => {
    const r = analyse([
      {
        size: [10, 20],
        range: [1, 2],
        loc: [29, 41],
        homeLocation: [13.4, 52.5],
        geo_point: [1, 2],
        LatLng: [3, 4],
        coords: [[5, 6]],
      },
    ])
    expect(field(r, 'size').geo).toBeUndefined()
    expect(field(r, 'range').geo).toBeUndefined()
    for (const p of ['loc', 'homeLocation', 'geo_point', 'LatLng', 'coords[]'])
      expect(field(r, p).geo, p).toBeDefined()
  })

  // Re-review (minor 6): whole words of the name count — gps yes; endpoint, checkpoint, repos no.
  it('reads the words of a name, camelCase and snake_case, not its last letters', () => {
    const r = analyse([
      {
        gps: [29, 41],
        gpsFix: [1, 2],
        last_position: [3, 4],
        endpoint: [5, 6],
        checkpoint: [7, 8],
        repos: [9, 10],
      },
    ])
    for (const p of ['gps', 'gpsFix', 'last_position']) expect(field(r, p).geo, p).toBeDefined()
    for (const p of ['endpoint', 'checkpoint', 'repos']) expect(field(r, p).geo, p).toBeUndefined()
  })

  it('keeps at most 10,000 places in all, however many fields hold pairs', () => {
    const doc = Object.fromEntries(Array.from({ length: 30 }, (_, f) => [`p${f}Location`, [f, 1]]))
    const r = analyse(Array.from({ length: 1000 }, () => doc))
    const kept = r.fields.reduce((n, f) => n + (f.geo?.points.length ?? 0), 0)
    expect(kept).toBe(10_000)
    const pairs = r.fields.filter((f) => !f.keys.includes(null))
    expect(pairs).toHaveLength(30)
    expect(pairs.every((f) => f.geo?.count === 1000)).toBe(true)
  })

  it('keeps at most 1,000 places per field, still counting the rest', () => {
    const r = analyse(Array.from({ length: 1200 }, (_, i) => ({ loc: [i % 180, 0] })))
    expect(field(r, 'loc').geo!.points).toHaveLength(1000)
    expect(field(r, 'loc').geo!.count).toBe(1200)
  })

  it('stops at depth 8, at 500 paths, and at 1000 tracked values, and never reads binary data', () => {
    let deep: Record<string, unknown> = { leaf: 1 }
    for (let i = 0; i < 10; i++) deep = { d: deep }
    const r = analyse([deep])
    expect(Math.max(...r.fields.map((f) => f.keys.length))).toBe(8)
    expect(r.fields.find((f) => f.keys.length === 8)!.types).toEqual({ other: 1 })

    const wide = Object.fromEntries(Array.from({ length: 600 }, (_, i) => [`f${i}`, i]))
    const w = analyse([wide])
    expect([w.fields.length, w.truncated]).toEqual([500, true])

    const many = analyse(Array.from({ length: 1500 }, (_, i) => ({ s: `v${i}` })))
    expect(many.fields[0]!.top).toHaveLength(10)
    expect(many.fields[0]!.count).toBe(1500)

    const secret = new Binary(Buffer.from('top secret'))
    Object.defineProperty(secret, 'buffer', {
      get() {
        throw new Error('binary content was read')
      },
    })
    const b = analyse([{ blob: secret, big: Long.fromNumber(7) }])
    expect(field(b, 'blob')).toMatchObject({ types: { binData: 1 } })
    expect(field(b, 'blob').top).toBeUndefined()
    expect(field(b, 'big').types).toEqual({ long: 1 })
  })

  it('takes plain JavaScript values too: whole numbers as int, others as double', () => {
    const r = analyse([{ n: 1 }, { n: 1.5 }, { n: 10n }])
    expect(field(r, 'n').types).toEqual({ int: 1, double: 1, long: 1 })
  })
})

describe('final review 1i: analyser limits', () => {
  it('keeps no more than the cut of a long value alive (Important 1)', () => {
    const gc = (globalThis as { gc?: () => void }).gc!
    const used = () => {
      gc()
      const m = process.memoryUsage()
      return m.heapUsed + m.external
    }
    const before = used()
    const a = new SchemaAnalyser()
    for (let i = 0; i < 200; i++) a.add({ s: `${i}:`.padEnd(1_000_000, 'x') })
    // The documents are gone; only what the analyser kept remains.
    const kept = used() - before
    expect(a.result().fields[0]!.top).toHaveLength(10)
    expect(kept).toBeLessThan(20_000_000)
  })

  it('tells an array element from a field literally named "[]" (Minor 12)', () => {
    const r = analyse([{ a: { '[]': 1 } }, { a: [2] }])
    const paths = r.fields.map((f) => f.keys)
    expect(paths).toEqual([['a'], ['a', null], ['a', '[]']])
    expect(r.fields.find((f) => f.keys[1] === null)!.path).toBe('a[]')
  })

  it('keeps counts when numbers span the whole double range (Minor 13)', () => {
    const r = analyse([{ v: -1.7e308 }, { v: 1.7e308 }, { v: 0 }])
    expect(r.fields[0]!.numbers!.bins.reduce((x, y) => x + y, 0)).toBe(3)
  })

  it('looks up an array’s element path once per array, not once per element (Minor 14)', () => {
    const stringify = vi.spyOn(JSON, 'stringify')
    analyse([{ list: Array.from({ length: 1000 }, (_, i) => i) }])
    expect(stringify.mock.calls.length).toBeLessThan(10)
    stringify.mockRestore()
  })
})
