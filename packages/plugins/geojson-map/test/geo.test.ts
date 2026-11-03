import { describe, expect, it } from 'vitest'
import { cellText, featuresOf, fieldOf, MAX_PARTS, MAX_VERTICES, plain, thinLines } from '../src/geo'

const n = (x: number) => ({ $numberDouble: String(x) })

describe('the map plugin finds shapes in documents (phase 4b §4)', () => {
  it('reads canonical Extended JSON numbers as numbers', () => {
    expect(plain({ a: [n(1.5), { $numberInt: '2' }, { $numberLong: '3' }], b: 'x' })).toEqual({
      a: [1.5, 2, 3],
      b: 'x',
    })
  })

  it('finds GeoJSON geometries, features and collections, and legacy [lng, lat] pairs, at any depth', () => {
    const doc = {
      _id: { $oid: '6ac625df13a09509ca0da14f' },
      home: { type: 'Point', coordinates: [n(29.01), n(41.02)] },
      route: {
        type: 'LineString',
        coordinates: [
          [n(29), n(41)],
          [n(30), n(40)],
        ],
      },
      zone: {
        type: 'Feature',
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 0],
            ],
          ],
        },
        properties: { name: 'z' },
      },
      many: {
        type: 'FeatureCollection',
        features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [1, 2] }, properties: null }],
      },
      place: { loc: [n(28.97), n(41.01)] },
      notGeo: { type: 'Point' },
      outOfRange: [200, 100],
      text: 'Point',
    }
    const found = featuresOf(doc)
    expect(found.map((f) => f.geometry.type).sort()).toEqual([
      'LineString',
      'Point',
      'Point',
      'Point',
      'Polygon',
    ])
    // Each shape keeps the document it came from, and where.
    expect(found.every((f) => JSON.stringify(f.properties._id) === JSON.stringify(doc._id))).toBe(true)
    expect(found.find((f) => f.properties.field === 'place.loc')!.geometry).toEqual({
      type: 'Point',
      coordinates: [28.97, 41.01],
    })
  })

  it('names a shape by its document (name, title or label), plainly and briefly', () => {
    const [named] = featuresOf({ _id: 1, name: 'Istanbul', loc: [28.97, 41.01] })
    expect(named!.properties.label).toBe('Istanbul')
    const [titled] = featuresOf({ _id: 2, title: 'x'.repeat(100), loc: [1, 1] })
    expect(titled!.properties.label).toHaveLength(60)
    const [unnamed] = featuresOf({ _id: 3, name: { first: 'a' }, loc: [1, 1] })
    expect(unnamed!.properties.label).toBeNull()
  })

  it('takes [lng, lat] pairs only from fields named for a place, and never walks into a broken shape', () => {
    const found = featuresOf({
      _id: 1,
      version: [2, 1],
      size: [10, 20],
      matrix: [
        [1, 2],
        [3, 4],
      ],
      position: [29, 41],
      geo: { coords: [30, 40] },
      broken: {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [500, 0],
            [1, 1],
            [0, 0],
          ],
        ],
      },
    })
    expect(found.map((f) => f.properties.field).sort()).toEqual(['geo.coords', 'position'])
  })

  it('shows the point of a Feature in a cell too', () => {
    expect(
      cellText({ type: 'Feature', geometry: { type: 'Point', coordinates: [1, 2] }, properties: {} }),
    ).toEqual({
      text: '2.00000, 1.00000',
      tone: 'info',
    })
  })

  it('stops at a sane depth and size', () => {
    let deep: Record<string, unknown> = { type: 'Point', coordinates: [1, 2] }
    for (let i = 0; i < 20; i++) deep = { x: deep }
    expect(featuresOf({ _id: 1, deep })).toEqual([])
  })

  it('shows a point as "lat, lng" in a cell, and nothing for other values', () => {
    expect(cellText({ type: 'Point', coordinates: [n(29.0123456), n(41.0098765)] })).toEqual({
      text: '41.00988, 29.01235',
      tone: 'info',
    })
    expect(
      cellText({
        type: 'LineString',
        coordinates: [
          [0, 0],
          [1, 1],
        ],
      }),
    ).toBeNull()
    expect(cellText({ type: 'Point', coordinates: [500, 0] })).toBeNull()
    expect(cellText('text')).toBeNull()
  })

  it('names the field a shape is in without its positions in arrays (the field picker)', () => {
    expect(fieldOf('location')).toBe('location')
    expect(fieldOf('locs.3')).toBe('locs')
    expect(fieldOf('stops.2.loc')).toBe('stops.loc')
    expect(fieldOf('zones.features.4')).toBe('zones')
    expect(fieldOf('features')).toBe('features')
  })
})

describe('a huge shape is drawn thinned (review 2026-10-10)', () => {
  const ring = (n: number, lng = 0) =>
    Array.from({ length: n }, (_, i) => [
      lng + Math.cos((2 * Math.PI * i) / n),
      Math.sin((2 * Math.PI * i) / n),
    ])
  const count = (lines: number[][][]) => lines.reduce((sum, l) => sum + l.length, 0)

  it('leaves a shape within the limits as it is', () => {
    const lines = [ring(500), ring(40, 5)]
    expect(thinLines(lines)).toBe(lines)
  })

  it('keeps at most MAX_VERTICES of 250,000, evenly, each part with its first and last', () => {
    const big = ring(250_000)
    const out = thinLines([big])
    expect(count(out)).toBeLessThanOrEqual(MAX_VERTICES)
    expect(count(out)).toBeGreaterThan(MAX_VERTICES / 2)
    expect(out[0]![0]).toEqual(big[0])
    expect(out[0]!.at(-1)).toEqual(big.at(-1))
    // Even: the gaps between kept vertices are all the same step (but the last).
    const index = new Map(big.map((p, i) => [p, i]))
    const kept = out[0]!.slice(0, -1).map((p) => index.get(p)!)
    expect(new Set(kept.slice(1).map((at, i) => at - kept[i]!)).size).toBe(1)
  })

  it('keeps at most MAX_PARTS parts, and still at most MAX_VERTICES', () => {
    const many = Array.from({ length: 100_000 }, (_, i) => ring(4, i / 1000))
    const out = thinLines(many)
    expect(out.length).toBe(MAX_PARTS)
    expect(count(out)).toBeLessThanOrEqual(MAX_VERTICES)
    expect(out[0]![0]).toEqual(many[0]![0])
    expect(out.every((l) => l.length >= 2)).toBe(true)
  })

  it('stays within MAX_VERTICES with one huge part among many small ones', () => {
    const mixed = [ring(250_000), ...Array.from({ length: MAX_PARTS - 1 }, (_, i) => ring(2, i))]
    const out = thinLines(mixed)
    expect(count(out)).toBeLessThanOrEqual(MAX_VERTICES)
    expect(out.slice(1).every((l) => l.length === 2)).toBe(true)
  })
})
