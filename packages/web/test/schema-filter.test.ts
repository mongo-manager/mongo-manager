// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { SchemaAnalyser, parseQueryObject, type FieldStats } from '@mongo-manager/shared/browser'
import {
  addCondition,
  areaCondition,
  binCondition,
  queryPath,
  topCondition,
  typeCondition,
} from '../src/schema/conditions'
import { decodeValue, toShell } from '../src/documents/values'

const fieldOf = (docs: Array<Record<string, unknown>>, path: string): FieldStats => {
  const a = new SchemaAnalyser()
  for (const d of docs) a.add(d)
  return a.result().fields.find((f) => f.path === path)!
}
const shell = (v: unknown) => toShell(v, 0)

/** W2 (2026-10-16): a click on a Schema field's value, range or type adds it to the Documents filter. */
describe('schema conditions', () => {
  it('writes a field path the way a query names it, or none when it cannot be named', () => {
    expect(queryPath(['a', 'b'])).toBe('a.b')
    // An array's elements are matched through the array's own path.
    expect(queryPath(['items', null, 'sku'])).toBe('items.sku')
    expect(queryPath(['tags', null])).toBe('tags')
    // A dotted key or a $ key cannot be written as a path: nothing to add.
    expect(queryPath(['a.b'])).toBeNull()
    expect(queryPath(['$weird'])).toBeNull()
    expect(queryPath(['ok', ''])).toBeNull()
  })

  it('matches a top value with its own type, and never a value that was cut', () => {
    expect(shell(topCondition({ value: 'Ada', count: 2, type: 'string' }))).toBe('"Ada"')
    expect(shell(topCondition({ value: 'true', count: 2, type: 'bool' }))).toBe('true')
    expect(shell(topCondition({ value: 'false', count: 2, type: 'bool' }))).toBe('false')
    expect(shell(topCondition({ value: '0123456789abcdef01234567', count: 2, type: 'objectId' }))).toBe(
      'ObjectId("0123456789abcdef01234567")',
    )
    expect(topCondition({ value: 'x'.repeat(100), count: 1, type: 'string', cut: true })).toBeNull()
    expect(topCondition({ value: 'not-hex', count: 1, type: 'objectId' })).toBeNull()
  })

  it('matches a histogram bar as its range, the last one closed at the maximum', () => {
    const f = fieldOf(
      Array.from({ length: 10 }, (_, i) => ({ v: i * 10 })),
      'v',
    )
    expect(shell(binCondition(f, 0))).toBe('{ $gte: 0, $lt: 9 }')
    expect(shell(binCondition(f, 9))).toBe('{ $gte: 81, $lte: 90 }')
    const d = fieldOf(
      [{ at: new Date('2026-01-01T00:00:00Z') }, { at: new Date('2026-01-11T00:00:00Z') }],
      'at',
    )
    expect(shell(binCondition(d, 0))).toBe(
      '{ $gte: ISODate("2026-01-01T00:00:00.000Z"), $lt: ISODate("2026-01-02T00:00:00.000Z") }',
    )
    expect(binCondition(d, 10)).toBeNull()
  })

  it('matches a type with its $type alias, and nothing for what has none', () => {
    expect(shell(typeCondition('objectId'))).toBe('{ $type: "objectId" }')
    expect(shell(typeCondition('bool'))).toBe('{ $type: "bool" }')
    expect(typeCondition('other')).toBeNull()
  })

  it('writes an area as $geoWithin for GeoJSON or legacy pairs, never for a mix', () => {
    const bounds = { west: 10, south: 20, east: 30, north: 40 }
    const geometry = (
      areaCondition(bounds, 'geojson') as {
        $geoWithin: { $geometry: { type: string; coordinates: number[][][] } }
      }
    ).$geoWithin.$geometry
    expect(geometry.type).toBe('Polygon')
    const ring = geometry.coordinates[0]!
    expect(ring[0]).toEqual([10, 20])
    expect(ring.at(-1)).toEqual([10, 20])
    for (const corner of [
      [30, 20],
      [30, 40],
      [10, 40],
    ])
      expect(ring).toContainEqual(corner)
    expect(shell(areaCondition(bounds, 'legacy'))).toBe('{ $geoWithin: { $box: [[10, 20], [30, 40]] } }')
    // A GeoJSON polygon wider than a hemisphere would be read the other way round: none is written.
    expect(areaCondition({ west: -170, south: -10, east: 170, north: 10 }, 'geojson')).toBeNull()
  })

  // W2 review (I2): a GeoJSON edge is a great circle, and the map's are lines of latitude: an edge
  // from (0, 40) to (100, 40) bows up to some 50° north and would drop places shown inside the box.
  it('follows the map’s edges: no edge of the polygon strays from its line of latitude', () => {
    const toRad = (d: number) => (d * Math.PI) / 180
    /** The latitude in the middle of the great circle between two places. */
    const midLatitude = ([lng1, lat1]: number[], [lng2, lat2]: number[]) => {
      const v = (lng: number, lat: number) => [
        Math.cos(toRad(lat)) * Math.cos(toRad(lng)),
        Math.cos(toRad(lat)) * Math.sin(toRad(lng)),
        Math.sin(toRad(lat)),
      ]
      const a = v(lng1!, lat1!)
      const b = v(lng2!, lat2!)
      const m = a.map((x, i) => x + b[i]!)
      return (Math.asin(m[2]! / Math.hypot(m[0]!, m[1]!, m[2]!)) * 180) / Math.PI
    }
    const geometry = (
      areaCondition({ west: 0, south: 40, east: 100, north: 60 }, 'geojson') as {
        $geoWithin: { $geometry: { coordinates: number[][][] } }
      }
    ).$geoWithin.$geometry
    const ring = geometry.coordinates[0]!
    let worst = 0
    for (let i = 0; i + 1 < ring.length; i++) {
      const [a, b] = [ring[i]!, ring[i + 1]!]
      if (a[1] !== b[1]) continue // a meridian is a great circle already
      worst = Math.max(worst, Math.abs(midLatitude(a, b) - a[1]!))
    }
    expect(worst).toBeLessThan(0.01)
    // A place just inside the south edge, in the middle, stays inside every edge.
    expect(midLatitude([0, 40], [100, 40])).toBeGreaterThan(45) // what a bare corner would do
  })

  it('adds a condition to the filter typed so far, AND-ing it with one already on that field', () => {
    const add = (filter: string, path: string, cond: unknown) => {
      const r = addCondition(filter, path, cond)
      return 'text' in r ? r.text : r
    }
    expect(add('', 'name', 'Ada')).toBe('{ name: "Ada" }')
    expect(add('{ qty: { $gt: 1 } }', 'name', 'Ada')).toBe('{ qty: { $gt: 1 }, name: "Ada" }')
    expect(add('{ name: "Bob" }', 'name', 'Ada')).toBe('{ name: "Bob", $and: [{ name: "Ada" }] }')
    expect(add('{ name: "Bob", $and: [{ a: 1 }] }', 'name', 'Ada')).toBe(
      '{ name: "Bob", $and: [{ a: 1 }, { name: "Ada" }] }',
    )
    // What is written is read back as the same filter.
    const text = add('{ at: { $gte: 1 } }', 'at', decodeValue({ $date: '2026-01-01T00:00:00Z' }))
    expect(Object.keys(parseQueryObject(text as string))).toEqual(['at', '$and'])
    // A filter that does not parse is left as it is, and says so.
    expect(addCondition('{ broken', 'name', 'Ada')).toEqual({ error: expect.any(String) })
  })
})
