// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it } from 'vitest'
import { restoreSpot, saveSpot } from '../src/documents/resultsScroll'

afterEach(() => {
  document.body.innerHTML = ''
})

/**
 * A results box of documents of the given heights, laid out by hand (happy-dom lays nothing out):
 * each document's top follows from the heights above it and the box's scroll.
 */
function results(heights: number[], keyed = true): { area: HTMLElement; box: HTMLElement } {
  const area = document.createElement('div')
  const box = document.createElement('div')
  box.setAttribute('data-results-scroll', '')
  area.append(box)
  let top = 0
  for (const [i, h] of heights.entries()) {
    const item = document.createElement('div')
    if (keyed) {
      item.setAttribute('data-results-item', '')
      item.dataset.key = `k${i}`
    }
    const at = top
    item.getBoundingClientRect = () =>
      ({ top: at - box.scrollTop, bottom: at + h - box.scrollTop, height: h }) as DOMRect
    box.append(item)
    top += h
  }
  box.getBoundingClientRect = () => ({ top: 0, bottom: 500, height: 500 }) as DOMRect
  document.body.append(area)
  return { area, box }
}

// User report 2026-11-07: Back to results lost the JSON and Cards views' place, and the table's
// sideways one.
describe('the results’ place, kept for Back to results', () => {
  it('comes back to the same document and the same distance into it, whatever the heights above it', () => {
    const before = results([1000, 1000, 1000, 1000])
    before.box.scrollTop = 2300
    before.box.scrollLeft = 40
    const spot = saveSpot(before.area)
    expect(spot).toMatchObject({ top: 2300, left: 40, anchor: { key: 'k2', offset: 300 } })
    before.area.remove()
    // Drawn again, the documents above are of a guessed height until they come in sight.
    const after = results([160, 160, 1000, 1000])
    restoreSpot(after.area, spot)
    expect(after.box.scrollLeft).toBe(40)
    expect(after.box.scrollTop).toBe(320 + 300)
  })

  it('shows a document drawn short at the top until it grows, then goes as far into it as before', async () => {
    const heights = [160, 869, 1000]
    const { area, box } = results(heights)
    // The second document is drawn again at its placeholder's height; 25 000 px in, it was before.
    const items = [...box.querySelectorAll<HTMLElement>('[data-results-item]')]
    const tops = () => heights.map((_, i) => heights.slice(0, i).reduce((a, b) => a + b, 0))
    items.forEach((item, i) => {
      item.getBoundingClientRect = () =>
        ({
          top: tops()[i]! - box.scrollTop,
          bottom: tops()[i]! + heights[i]! - box.scrollTop,
          height: heights[i]!,
        }) as DOMRect
    })
    restoreSpot(area, { top: 0, left: 0, anchor: { key: 'k1', offset: 25_000 } })
    // At the top of the box: in sight, so it is drawn.
    expect(box.scrollTop).toBe(160)
    heights[1] = 25_400
    await new Promise((r) => requestAnimationFrame(r))
    await new Promise((r) => requestAnimationFrame(r))
    expect(box.scrollTop).toBe(160 + 25_000)
  })

  it('comes back to the pixel where nothing marks the documents (the table)', () => {
    const before = results([36, 36, 36, 36], false)
    before.box.scrollTop = 50
    before.box.scrollLeft = 587
    const spot = saveSpot(before.area)
    expect(spot).toEqual({ top: 50, left: 587 })
    const after = results([36, 36, 36, 36], false)
    restoreSpot(after.area, spot)
    expect([after.box.scrollTop, after.box.scrollLeft]).toEqual([50, 587])
  })

  it('falls back to the pixel when the document at the top is gone', () => {
    const before = results([100, 100, 100])
    before.box.scrollTop = 150
    const spot = saveSpot(before.area)
    const after = results([100])
    restoreSpot(after.area, { ...spot, anchor: { key: 'gone', offset: 0 } })
    expect(after.box.scrollTop).toBe(150)
  })
})
