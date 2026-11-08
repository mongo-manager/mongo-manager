// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import GeoMap from '../src/schema/geo/GeoMap.vue'
import land from '../src/schema/geo/land-110m.json'
import { MAX_ZOOM, areaOf, fitPoints, landPath, panBy, settle, zoomAt } from '../src/schema/geo/view'
import { i18n } from '../src/i18n'
import { mountApp } from './support/app'

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  document.body.innerHTML = ''
})

/** W2 (2026-10-16): the Schema tab's offline map. */
describe('the offline world map', () => {
  it('bundles a small world outline, drawn without any request', () => {
    // Natural Earth 1:110m land, tenth-degree steps: a few tens of kilobytes, not a tile set.
    expect(JSON.stringify(land).length).toBeLessThan(150_000)
    const d = landPath()
    expect(d.startsWith('M')).toBe(true)
    // Every point is on the world: longitudes within ±180, latitudes (negated) within ±90.
    const numbers = d.match(/-?\d+(\.\d+)?/g)!.map(Number)
    expect(Math.max(...numbers.map(Math.abs))).toBeLessThanOrEqual(180)
  })

  it('fits the places, keeps the view on the world and within the zoom limits', () => {
    const view = fitPoints([
      [28, 40],
      [30, 42],
    ])
    expect(view.cx).toBeCloseTo(29)
    expect(view.cy).toBeCloseTo(-41)
    const area = areaOf(view)
    expect(area.west).toBeLessThan(28)
    expect(area.east).toBeGreaterThan(30)
    expect(area.south).toBeLessThan(40)
    expect(area.north).toBeGreaterThan(42)
    expect(settle({ cx: 500, cy: 500, zoom: 1 })).toEqual({ cx: 0, cy: 0, zoom: 1 })
    expect(zoomAt({ cx: 0, cy: 0, zoom: 1 }, 1e6).zoom).toBe(MAX_ZOOM)
    expect(panBy({ cx: 0, cy: 0, zoom: 4 }, 0.5, 0).cx).toBeCloseTo(45)
  })

  it('moves and zooms from the keyboard and its buttons, and filters to the area in view', async () => {
    const { wrapper } = mountApp(GeoMap, {
      props: {
        path: 'at',
        points: [
          [28, 40],
          [30, 42],
        ],
        count: 2,
        kind: 'geojson',
        canFilter: true,
      },
    })
    await flushPromises()
    const svg = document.querySelector('[data-geo-map] svg[tabindex="0"]') as SVGSVGElement
    expect(svg.getAttribute('aria-label')).toBe('Map of 2 places in at')
    const box = () => svg.getAttribute('viewBox')!.split(' ').map(Number)
    const before = box()
    svg.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    await flushPromises()
    expect(box()[0]).toBeGreaterThan(before[0]!)
    svg.dispatchEvent(new KeyboardEvent('keydown', { key: '-', bubbles: true }))
    await flushPromises()
    expect(box()[2]).toBeGreaterThan(before[2]!)
    ;(document.querySelector('button[aria-label="Whole world"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(box()).toEqual([-180, -90, 360, 180])
    // The whole world is wider than any GeoJSON polygon can say: zoom in first.
    expect(document.body.textContent).toContain('Zoom in to filter')
    ;(document.querySelector('button[aria-label="Fit the places"]') as HTMLButtonElement).click()
    await flushPromises()
    ;[...document.querySelectorAll('button')]
      .find((b) => b.textContent!.includes('Filter to this area'))!
      .click()
    const [[condition]] = wrapper.emitted('filter') as [
      [{ $geoWithin: { $geometry: { coordinates: number[][][] } } }],
    ]
    const ring = condition.$geoWithin.$geometry.coordinates[0]!
    expect(ring[0]).toEqual(ring.at(-1))
    expect(ring[0]![0]).toBeLessThan(28)
  })

  // W2 review (minor 5): a map one moves is an application, said as a map, with its places in words.
  it('is a map to assistive technology, with the places as text and a table', async () => {
    mountApp(GeoMap, {
      props: {
        path: 'at',
        points: [
          [28, 40],
          [30.5, 42.25],
        ],
        count: 2,
        kind: 'geojson',
        canFilter: false,
      },
    })
    await flushPromises()
    const map = document.querySelector('[data-geo-map] svg[tabindex="0"]')!
    expect(map.getAttribute('role')).toBe('application')
    expect(map.getAttribute('aria-roledescription')).toBe('map')
    const described = map
      .getAttribute('aria-describedby')!
      .split(' ')
      .map((id) => document.getElementById(id)!.textContent)
      .join(' ')
    expect(described).toContain('28')
    expect(described).toContain('42.25')
    const rows = [...document.querySelectorAll('[data-geo-table] tbody tr')].map((r) => r.textContent)
    expect(rows).toHaveLength(2)
    expect(rows[1]).toContain('30.5')
  })

  it('zooms with the wheel only while Ctrl is held, and with two fingers', async () => {
    mountApp(GeoMap, { props: { path: 'p', points: [[1, 2]], count: 1, kind: 'legacy', canFilter: false } })
    await flushPromises()
    const svg = document.querySelector('[data-geo-map] svg[tabindex="0"]') as SVGSVGElement
    const width = () => Number(svg.getAttribute('viewBox')!.split(' ')[2])
    const before = width()
    const plain = new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true })
    svg.dispatchEvent(plain)
    await flushPromises()
    // The page scrolls on: the map neither zooms nor keeps the wheel.
    expect(width()).toBe(before)
    expect(plain.defaultPrevented).toBe(false)
    const ctrl = new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true })
    // happy-dom's WheelEvent takes no modifier keys from its init.
    Object.defineProperty(ctrl, 'ctrlKey', { value: true })
    svg.dispatchEvent(ctrl)
    await flushPromises()
    expect(width()).toBeGreaterThan(before)
    expect(ctrl.defaultPrevented).toBe(true)
    // Two fingers moving apart zoom in.
    const zoomed = width()
    const touch = (type: string, id: number, x: number) =>
      svg.dispatchEvent(
        new PointerEvent(type, { pointerId: id, clientX: x, clientY: 100, button: 0, bubbles: true }),
      )
    touch('pointerdown', 1, 100)
    touch('pointerdown', 2, 200)
    touch('pointermove', 2, 400)
    await flushPromises()
    expect(width()).toBeLessThan(zoomed)
    touch('pointerup', 1, 100)
    touch('pointerup', 2, 400)
  })

  // Re-review (minor 6): a pinch zooms around the fingers, and the finger left on the map drags it.
  it('pinches around the fingers’ midpoint, then drags with the finger left', async () => {
    mountApp(GeoMap, {
      props: {
        path: 'p',
        points: [
          [0, 0],
          [40, 20],
        ],
        count: 2,
        kind: 'legacy',
        canFilter: false,
      },
    })
    await flushPromises()
    const svg = document.querySelector('[data-geo-map] svg[tabindex="0"]') as SVGSVGElement
    svg.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 800, height: 400, right: 800, bottom: 400, x: 0, y: 0 }) as DOMRect
    const box = () => svg.getAttribute('viewBox')!.split(' ').map(Number) as [number, number, number, number]
    /** The map point under a screen point. */
    const under = (px: number, py: number) => {
      const [x, y, w, h] = box()
      const k = Math.max(w / 800, h / 400)
      return [x + w / 2 + (px - 400) * k, y + h / 2 + (py - 200) * k]
    }
    const touch = (type: string, id: number, x: number, y = 100) =>
      svg.dispatchEvent(
        new PointerEvent(type, { pointerId: id, clientX: x, clientY: y, button: 0, bubbles: true }),
      )
    const before = under(200, 100)
    touch('pointerdown', 1, 150)
    touch('pointerdown', 2, 250)
    touch('pointermove', 1, 100)
    touch('pointermove', 2, 300)
    await flushPromises()
    const after = under(200, 100)
    expect(after[0]).toBeCloseTo(before[0]!, 3)
    expect(after[1]).toBeCloseTo(before[1]!, 3)
    // One finger lifted: the other drags on.
    touch('pointerup', 1, 100)
    const x = box()[0]
    touch('pointermove', 2, 200)
    await flushPromises()
    expect(box()[0]).toBeGreaterThan(x)
    touch('pointerup', 2, 200)
  })

  it('writes a $box for legacy pairs and offers no area for a mix', async () => {
    const legacy = mountApp(GeoMap, {
      props: { path: 'p', points: [[1, 2]], count: 1, kind: 'legacy', canFilter: true },
    })
    await flushPromises()
    ;[...document.querySelectorAll('button')]
      .find((b) => b.textContent!.includes('Filter to this area'))!
      .click()
    expect(JSON.stringify(legacy.wrapper.emitted('filter'))).toContain('$box')
    legacy.wrapper.unmount()
    mountApp(GeoMap, { props: { path: 'p', points: [[1, 2]], count: 1, kind: null, canFilter: true } })
    await flushPromises()
    expect(document.body.textContent).toContain('no area filter matches both')
  })
})
