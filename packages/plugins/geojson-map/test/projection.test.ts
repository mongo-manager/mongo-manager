import { describe, expect, it } from 'vitest'
import {
  boundsOf,
  clampCenter,
  fitView,
  lngSpan,
  MAX_LAT,
  minZoomFor,
  project,
  unproject,
  unwrapLine,
  worldSize,
  wrapLng,
} from '../src/projection'

const close = (a: number, b: number, digits = 6) => expect(a).toBeCloseTo(b, digits)

describe('Web Mercator, as tile servers cut the world (map redesign)', () => {
  it('puts the world in a 256 px square at zoom 0, twice as large each zoom', () => {
    expect(worldSize(0)).toBe(256)
    expect(worldSize(3)).toBe(2048)
    expect(project({ lng: -180, lat: 0 }, 0)).toEqual({ x: 0, y: 128 })
    expect(project({ lng: 0, lat: 0 }, 1)).toEqual({ x: 256, y: 256 })
    // The poles are cut where the square ends, never beyond it (no NaN, no Infinity).
    close(project({ lng: 0, lat: 90 }, 0).y, 0, 3)
    close(project({ lng: 0, lat: -90 }, 0).y, 256, 3)
    close(project({ lng: 0, lat: MAX_LAT }, 0).y, 0, 3)
  })

  it('reads back what it projects', () => {
    for (const p of [
      { lng: 28.97, lat: 41.01 },
      { lng: -122.42, lat: 37.77 },
      { lng: 179.9, lat: -60 },
    ]) {
      const back = unproject(project(p, 7.5), 7.5)
      close(back.lng, p.lng)
      close(back.lat, p.lat)
    }
  })

  it('wraps a longitude into [-180, 180)', () => {
    expect(wrapLng(190)).toBe(-170)
    expect(wrapLng(-190)).toBe(170)
    expect(wrapLng(180)).toBe(-180)
    expect(wrapLng(540)).toBe(-180)
    expect(wrapLng(12.5)).toBe(12.5)
  })
})

describe('the longitudes a set of places spans, across the antimeridian too', () => {
  it('spans west to east where the places do not cross it', () => {
    expect(lngSpan([29, 32.85, 27.14])).toEqual({ west: 27.14, east: 32.85 })
  })

  it('takes the short way across the antimeridian (Fiji, not the whole world)', () => {
    expect(lngSpan([179, -179, 178.5])).toEqual({ west: 178.5, east: 181 })
  })

  it('gives the bounds of points, null for none', () => {
    expect(boundsOf([])).toBeNull()
    expect(
      boundsOf([
        { lng: 10, lat: 5 },
        { lng: 20, lat: -5 },
      ]),
    ).toEqual({ west: 10, east: 20, south: -5, north: 5 })
  })

  it('unwraps a line that crosses the antimeridian so it is drawn the short way', () => {
    expect(
      unwrapLine([
        [179, 0],
        [-179, 1],
        [-178, 2],
      ]),
    ).toEqual([
      [179, 0],
      [181, 1],
      [182, 2],
    ])
    expect(
      unwrapLine([
        [-179, 0],
        [179, 1],
      ]),
    ).toEqual([
      [-179, 0],
      [-181, 1],
    ])
    expect(
      unwrapLine([
        [10, 0],
        [20, 0],
      ]),
    ).toEqual([
      [10, 0],
      [20, 0],
    ])
  })
})

describe('fitting the view to the places', () => {
  const size = { width: 800, height: 480 }
  const limits = { padding: 48, minZoom: 1, maxZoom: 15 }

  it('centres the places and zooms as far as they still fit with the padding', () => {
    const b = { west: 27.14, east: 32.93, south: 38.42, north: 41.05 }
    const { center, zoom } = fitView(b, size, limits)
    // Everything inside the padded view at that zoom...
    const nw = project({ lng: b.west, lat: b.north }, zoom)
    const se = project({ lng: b.east, lat: b.south }, zoom)
    expect(se.x - nw.x).toBeLessThanOrEqual(size.width - 2 * limits.padding)
    expect(se.y - nw.y).toBeLessThanOrEqual(size.height - 2 * limits.padding)
    // ...and a quarter step more would not fit.
    const nw2 = project({ lng: b.west, lat: b.north }, zoom + 0.25)
    const se2 = project({ lng: b.east, lat: b.south }, zoom + 0.25)
    expect(se2.x - nw2.x > size.width - 96 || se2.y - nw2.y > size.height - 96).toBe(true)
    expect(zoom % 0.25).toBe(0)
    const c = project(center, zoom)
    close(c.x, (nw.x + se.x) / 2, 3)
    close(c.y, (nw.y + se.y) / 2, 3)
  })

  it('zooms to the most it allows on a single place', () => {
    expect(fitView({ west: 29, east: 29, south: 41, north: 41 }, size, limits)).toEqual({
      center: { lng: 29, lat: 41 },
      zoom: 15,
    })
  })

  it('never zooms out beyond the least it allows', () => {
    const world = { west: -180, east: 180, south: -80, north: 80 }
    expect(fitView(world, size, limits).zoom).toBe(1)
    expect(fitView(world, size, { ...limits, minZoom: 2 }).zoom).toBe(2)
  })

  it('centres a span across the antimeridian on it', () => {
    const { center, zoom } = fitView({ west: 178, east: 182, south: -18, north: -16 }, size, limits)
    close(Math.abs(center.lng), 180, 6)
    expect(zoom).toBeGreaterThan(5)
  })

  it('fits a frame that has no size yet without breaking', () => {
    const v = fitView({ west: 0, east: 10, south: 0, north: 10 }, { width: 0, height: 0 }, limits)
    expect(Number.isFinite(v.zoom)).toBe(true)
    expect(v.zoom).toBe(1)
  })
})

describe('zoom limits', () => {
  it('lets the world fill the view at the least zoom, from zoom 0 for a small view', () => {
    expect(minZoomFor({ width: 800, height: 512 })).toBe(1)
    expect(minZoomFor({ width: 200, height: 100 })).toBe(0)
    expect(minZoomFor({ width: 800, height: 0 })).toBe(0)
  })

  it('keeps the poles at the edges: no empty band above or below the world', () => {
    const size = { width: 800, height: 512 }
    const top = clampCenter({ lng: 10, lat: 84 }, 1, size)
    expect(project(top, 1).y).toBeCloseTo(256, 6)
    expect(top.lng).toBe(10)
    // A world taller than the view: the centre stops half a view from the top and the bottom.
    expect(project(clampCenter({ lng: 0, lat: 84 }, 2, size), 2).y).toBeCloseTo(256, 6)
    expect(project(clampCenter({ lng: 0, lat: -84 }, 2, size), 2).y).toBeCloseTo(1024 - 256, 6)
    const inside = clampCenter({ lng: 10, lat: 20 }, 4, size)
    expect(inside.lat).toBeCloseTo(20, 9)
    // Longitudes wrap rather than stop.
    expect(clampCenter({ lng: 200, lat: 0 }, 4, size).lng).toBeCloseTo(-160, 9)
  })
})
