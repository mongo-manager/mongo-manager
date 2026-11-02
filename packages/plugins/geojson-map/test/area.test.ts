import { describe, expect, it } from 'vitest'
import {
  EARTH_RADIUS,
  MAX_CORNERS,
  circleOutline,
  cleanRing,
  continuous,
  densify,
  distance,
  distanceText,
  polygonProblem,
  withinBounds,
  withinCircle,
  withinPolygon,
} from '../src/area'
import { MAX_LAT } from '../src/projection'

// The shapes below were checked against a real MongoDB 8 (GeoJSON points and legacy pairs alike).
const n = (x: number) => ({ $numberDouble: String(x) })
type Within = {
  f: {
    $geoWithin: { $geometry: { coordinates: Array<Array<Array<{ $numberDouble: string }>>>; crs: unknown } }
  }
}
const ring = (filter: unknown) =>
  (filter as Within).f.$geoWithin.$geometry.coordinates[0]!.map(([lng, lat]) => [
    Number(lng!.$numberDouble),
    Number(lat!.$numberDouble),
  ]) as Array<[number, number]>
/** Twice its signed area, its longitudes made continuous: positive when counterclockwise. */
const area = (r: Array<[number, number]>) => {
  const pts = continuous(r.map(([lng, lat]) => ({ lng, lat })))
  let sum = 0
  for (let i = 0; i < pts.length - 1; i++)
    sum += pts[i]!.lng * pts[i + 1]!.lat - pts[i + 1]!.lng * pts[i]!.lat
  return sum
}
/** The longest step between two corners, in degrees, the short way round. */
const longest = (r: Array<[number, number]>) => {
  let most = 0
  for (let i = 0; i < r.length - 1; i++) {
    const dLng = Math.abs(((r[i + 1]![0] - r[i]![0] + 540) % 360) - 180)
    most = Math.max(most, dLng, Math.abs(r[i + 1]![1] - r[i]![1]))
  }
  return most
}
const STRICT = { type: 'name', properties: { name: 'urn:x-mongodb:crs:strictwinding:EPSG:4326' } }
const square = [
  { lng: 25, lat: 36 },
  { lng: 45, lat: 36 },
  { lng: 45, lat: 42 },
  { lng: 25, lat: 42 },
]

describe('a drawn polygon', () => {
  it('selects what lies within it: counterclockwise, closed, its edges as the map draws them', () => {
    const filter = withinPolygon('f', square)!
    expect((filter as Within).f.$geoWithin.$geometry.crs).toEqual(STRICT)
    const r = ring(filter)
    expect(r[0]).toEqual([25, 36])
    expect(r.at(-1)).toEqual([25, 36])
    expect(area(r)).toBeGreaterThan(0)
    expect(longest(r)).toBeLessThanOrEqual(1)
    // Its corners, in order.
    expect(r.filter(([lng, lat]) => square.some((p) => p.lng === lng && p.lat === lat)).slice(0, 4)).toEqual([
      [25, 36],
      [45, 36],
      [45, 42],
      [25, 42],
    ])
    // A parallel stays a parallel (the globe's shortest way would bow north, review I1).
    expect(r.filter(([lng]) => lng > 25 && lng < 45).every(([, lat]) => lat === 36 || lat === 42)).toBe(true)
    // Drawn the other way round: the same area, turned counterclockwise.
    const reversed = ring(withinPolygon('f', [...square].reverse()))
    expect(area(reversed)).toBeGreaterThan(0)
    expect(new Set(reversed.map(String))).toEqual(new Set(r.map(String)))
  })

  it('keeps its corners together when the map was moved across the antimeridian between them', () => {
    // Placed as the map reads them after a pan east past 180: the second corner comes 360° away.
    const across = [
      { lng: 170, lat: 0 },
      { lng: -170, lat: 0 },
      { lng: -170, lat: 10 },
      { lng: 170, lat: 10 },
    ]
    const r = ring(withinPolygon('f', across))
    expect(area(r)).toBeGreaterThan(0)
    expect(longest(r)).toBeLessThanOrEqual(1)
    expect(r.every(([lng]) => lng >= -180 && lng <= 180)).toBe(true)
    // The 20° drawn, not the 340° of the rest of the world.
    expect(r.filter(([lng]) => lng > -170 && lng < 170)).toEqual([])
    expect(continuous(across).map((p) => p.lng)).toEqual([170, 190, 190, 170])
    // 180 stays 180.
    expect(
      ring(
        withinPolygon('f', [
          { lng: 170, lat: 0 },
          { lng: 180, lat: 0 },
          { lng: 180, lat: 10 },
        ]),
      ),
    ).toContainEqual([180, 0])
  })

  it('leaves out repeated corners and a closing copy, and makes no area of a line or a bow tie', () => {
    expect(cleanRing([square[0]!, square[0]!, square[1]!, square[2]!, square[0]!])).toEqual([
      square[0],
      square[1],
      square[2],
    ])
    expect(polygonProblem(square)).toBeNull()
    expect(polygonProblem(square.slice(0, 2))).toBe('corners')
    // Corners on one line of the map (a parallel here): no size.
    expect(
      polygonProblem([
        { lng: 0, lat: 10 },
        { lng: 5, lat: 10 },
        { lng: 10, lat: 10 },
      ]),
    ).toBe('empty')
    const bowTie = [
      { lng: 0, lat: 0 },
      { lng: 10, lat: 10 },
      { lng: 10, lat: 0 },
      { lng: 0, lat: 10 },
    ]
    expect(polygonProblem(bowTie)).toBe('crossing')
    // Edges cross on the map, where they are drawn straight, though not in degrees of latitude.
    expect(
      polygonProblem([
        { lng: 0, lat: 0 },
        { lng: 10, lat: 80 },
        { lng: 6, lat: 55 },
        { lng: 4, lat: 55 },
      ]),
    ).toBe('crossing')
    expect(withinPolygon('f', bowTie)).toBeNull()
    expect(withinPolygon('f', square.slice(0, 2))).toBeNull()
  })

  it('takes a building’s outline for an area, and no spike or touching edges', () => {
    // A square of about 10 m at the equator, and of 1 m near the pole the map shows.
    const tiny = (lng: number, lat: number, d: number) => [
      { lng, lat },
      { lng: lng + d, lat },
      { lng: lng + d, lat: lat + d },
      { lng, lat: lat + d },
    ]
    expect(polygonProblem(tiny(0, 0, 0.00009))).toBeNull()
    expect(polygonProblem(tiny(10, 80, 0.000009))).toBeNull()
    expect(withinPolygon('f', tiny(0, 0, 0.00009))).not.toBeNull()
    // A spike: an edge going back along the one before.
    expect(
      polygonProblem([
        { lng: 0, lat: 0 },
        { lng: 10, lat: 0 },
        { lng: 5, lat: 0 },
        { lng: 5, lat: 5 },
      ]),
    ).toBe('crossing')
    // A corner on another edge (a T): each way round.
    expect(
      polygonProblem([
        { lng: 5, lat: 0 },
        { lng: 10, lat: 10 },
        { lng: 0, lat: 10 },
        { lng: 0, lat: 0 },
        { lng: 10, lat: 0 },
      ]),
    ).toBe('crossing')
    expect(
      polygonProblem([
        { lng: 0, lat: 0 },
        { lng: 10, lat: 0 },
        { lng: 10, lat: 10 },
        { lng: 5, lat: 0 },
      ]),
    ).toBe('crossing')
    // Two edges meeting at a corner they do not share: a figure of eight.
    expect(
      polygonProblem([
        { lng: 0, lat: 0 },
        { lng: 10, lat: 0 },
        { lng: 5, lat: 5 },
        { lng: 10, lat: 10 },
        { lng: 0, lat: 10 },
        { lng: 5, lat: 5 },
      ]),
    ).toBe('crossing')
  })

  it('goes in longer steps past MAX_CORNERS', () => {
    const wide = densify([
      { lng: -170, lat: -80 },
      { lng: 170, lat: -80 },
      { lng: 170, lat: 80 },
      { lng: -170, lat: 80 },
    ])
    expect(wide.length).toBeLessThanOrEqual(MAX_CORNERS + 4)
    expect(wide.length).toBeGreaterThan(MAX_CORNERS / 2)
  })
})

describe('a drawn circle', () => {
  it('selects what lies within its radius on the sphere, and is drawn as the sphere holds it', () => {
    expect(withinCircle('f', { lng: 27, lat: 38.5 }, 100_000)).toEqual({
      f: { $geoWithin: { $centerSphere: [[n(27), n(38.5)], n(100_000 / EARTH_RADIUS)] } },
    })
    expect(withinCircle('f', { lng: 0, lat: 0 }, 0)).toBeNull()
    expect(withinCircle('f', { lng: 0, lat: 0 }, Number.NaN)).toBeNull()
    const center = { lng: 10, lat: 60 }
    const outline = circleOutline(center, 500_000)
    expect(outline).toHaveLength(64)
    for (const p of outline) expect(distance(center, p) / 500_000).toBeCloseTo(1, 3)
    // All the way round it.
    expect(Math.min(...outline.map((p) => p.lng))).toBeLessThan(center.lng - 4)
    expect(Math.max(...outline.map((p) => p.lng))).toBeGreaterThan(center.lng + 4)
    expect(Math.min(...outline.map((p) => p.lat))).toBeLessThan(center.lat - 4)
    expect(Math.max(...outline.map((p) => p.lat))).toBeGreaterThan(center.lat + 4)
  })

  it('measures its radius along the great circle', () => {
    // Izmir to Ankara: about 520 km.
    expect(distance({ lng: 27.14, lat: 38.42 }, { lng: 32.85, lat: 39.93 }) / 1000).toBeCloseTo(520, -1)
    expect(distance({ lng: 0, lat: 0 }, { lng: 0, lat: 0 })).toBe(0)
    expect(distanceText(850, 'en')).toBe('850 m')
    expect(distanceText(12_345, 'tr')).toBe(
      `${new Intl.NumberFormat('tr', { maximumFractionDigits: 1 }).format(12.345)} km`,
    )
  })
})

describe('the area in view', () => {
  it('is a polygon of its edges as the map shows them', () => {
    const r = ring(withinBounds('f', { west: 5, east: 15, south: 46.6, north: 55 }))
    expect(area(r)).toBeGreaterThan(0)
    expect(longest(r)).toBeLessThanOrEqual(1)
    // Its south edge is the parallel the map shows, not the great circle's bow (review I1).
    const south = r.filter(([lng, lat]) => lng > 5 && lng < 15 && lat < 50)
    expect(south.every(([, lat]) => lat === 46.6)).toBe(true)
    expect(south.length).toBe(9)
  })

  it('stops short of the antimeridian when it is the whole width of the world, and at the map’s own poles', () => {
    const world = ring(withinBounds('f', { west: -300, east: 400, south: -95, north: 95 }))
    const lngs = world.map(([lng]) => lng)
    expect(Math.min(...lngs)).toBe(-180)
    expect(Math.max(...lngs)).toBeLessThan(180)
    expect(Math.min(...world.map(([, lat]) => lat))).toBe(-MAX_LAT)
    expect(Math.max(...world.map(([, lat]) => lat))).toBe(MAX_LAT)
    expect(area(world)).toBeGreaterThan(0)
    // Longer steps (MAX_CORNERS in all), never near half the world.
    expect(longest(world)).toBeLessThan(5)
  })

  it('is none when it has no size', () => {
    expect(withinBounds('f', { west: 10, east: 10, south: 0, north: 5 })).toBeNull()
    expect(withinBounds('f', { west: 0, east: 10, south: 5, north: 5 })).toBeNull()
  })
})
