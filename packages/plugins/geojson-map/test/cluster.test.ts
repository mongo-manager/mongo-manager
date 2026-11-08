// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { cluster } from '../src/cluster'
import { project } from '../src/projection'

const CITIES = [
  [27.14, 38.42],
  [32.85, 39.93],
  [28.98, 41.01],
  [29.06, 40.19],
] as const
/** The review data: 60 places, 15 around each of 4 cities. */
const SIXTY = Array.from({ length: 60 }, (_, i) => {
  const [lng, lat] = CITIES[i % 4]!
  return { lng: lng + (i % 5) / 50, lat: lat + (i % 3) / 50 }
})
const sizes = (c: Array<{ members: number[] }>) => c.map((x) => x.members.length).sort((a, b) => a - b)

describe('places close together on screen are one circle with their count (spec §2.5)', () => {
  it('draws the review data as four circles of fifteen at the country’s zoom', () => {
    const found = cluster(SIXTY, 6.5)
    expect(sizes(found)).toEqual([15, 15, 15, 15])
    // Every place is in exactly one circle.
    expect(
      found
        .flatMap((c) => c.members)
        .sort((a, b) => a - b)
        .join(),
    ).toBe(SIXTY.map((_, i) => i).join())
  })

  it('splits them as the zoom grows, until each stands alone', () => {
    expect(cluster(SIXTY, 13).length).toBe(60)
    expect(cluster(SIXTY, 2).length).toBeLessThan(4)
  })

  it('puts a circle at the middle of its places', () => {
    const [one] = cluster(
      [
        { lng: 10, lat: 10 },
        { lng: 10.0001, lat: 10.0001 },
      ],
      5,
    )
    expect(one!.lng).toBeCloseTo(10.00005, 6)
    expect(one!.lat).toBeCloseTo(10.00005, 6)
  })

  it('joins places within the radius in pixels, never those beyond it', () => {
    const zoom = 10
    const a = { lng: 0, lat: 0 }
    const at = (dx: number) => {
      const p = project(a, zoom)
      // A place `dx` pixels east of `a` at this zoom.
      return { lng: ((p.x + dx) / (256 * 2 ** zoom)) * 360 - 180, lat: 0 }
    }
    expect(cluster([a, at(27)], zoom, 28)).toHaveLength(1)
    expect(cluster([a, at(29)], zoom, 28)).toHaveLength(2)
  })

  it('joins places on both sides of the antimeridian, and centres them on it', () => {
    const found = cluster(
      [
        { lng: 179.99, lat: 0 },
        { lng: -179.99, lat: 0 },
      ],
      8,
    )
    expect(found).toHaveLength(1)
    expect(Math.abs(found[0]!.lng)).toBeCloseTo(180, 6)
  })

  it('handles many places quickly', () => {
    const many = Array.from({ length: 50_000 }, (_, i) => ({
      lng: ((i * 7919) % 36000) / 100 - 180,
      lat: ((i * 104729) % 17000) / 100 - 85,
    }))
    const started = performance.now()
    const found = cluster(many, 3)
    expect(performance.now() - started).toBeLessThan(1500)
    expect(found.reduce((n, c) => n + c.members.length, 0)).toBe(50_000)
  })

  it('has nothing to say about no places', () => {
    expect(cluster([], 4)).toEqual([])
  })
})
