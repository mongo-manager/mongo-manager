// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER

/**
 * Document page design §6.1: where the results were, to come back to from a document's page — in the
 * table, the JSON and the Cards views, down and sideways (user report 2026-11-07: Back kept only the
 * table's scroll down). The view that scrolls marks its box `data-results-scroll`; the JSON and Cards
 * views mark each document `data-results-item` with its key. Those lay a document out only when it
 * comes in sight (content-visibility), so the ones above are of a guessed height when the view is
 * drawn again: the place is kept as the document at the top and how far into it, not as pixels (one
 * document of a big collection can be taller than many screens).
 */
export interface ResultsSpot {
  top: number
  left: number
  /** The document at the top of the box (its key), and how far its top is above the box's. */
  anchor?: { key: string; offset: number }
}

const scrollerIn = (area: HTMLElement | null) =>
  area?.querySelector<HTMLElement>('[data-results-scroll]') ?? null

function itemAtTop(box: HTMLElement): HTMLElement | null {
  const top = box.getBoundingClientRect().top
  for (const item of box.querySelectorAll<HTMLElement>('[data-results-item]'))
    if (item.getBoundingClientRect().bottom > top) return item
  return null
}

/** Where the results shown in `area` are scrolled to. */
export function saveSpot(area: HTMLElement | null): ResultsSpot {
  const box = scrollerIn(area)
  if (!box) return { top: 0, left: 0 }
  const spot: ResultsSpot = { top: box.scrollTop, left: box.scrollLeft }
  const item = box.scrollTop > 0 ? itemAtTop(box) : null
  const key = item?.dataset.key
  if (item && key)
    spot.anchor = { key, offset: box.getBoundingClientRect().top - item.getBoundingClientRect().top }
  return spot
}

const itemOf = (box: HTMLElement, key: string) =>
  [...box.querySelectorAll<HTMLElement>('[data-results-item]')].find((el) => el.dataset.key === key)

/** Puts the document at the top back as far into it as it was. */
function placeAnchor(box: HTMLElement, item: HTMLElement, offset: number): void {
  const off = item.getBoundingClientRect().top - box.getBoundingClientRect().top + offset
  if (Math.abs(off) >= 1) box.scrollTop += off
}

/** Scrolls the results shown in `area` back to `spot`. */
export function restoreSpot(area: HTMLElement | null, spot: ResultsSpot): void {
  const box = scrollerIn(area)
  if (!box) return
  box.scrollLeft = spot.left
  const anchor = spot.anchor
  const item = anchor && itemOf(box, anchor.key)
  if (!anchor || !item) {
    box.scrollTop = spot.top
    return
  }
  // Drawn again, it is of a guessed height (laid out, and its text built, only near the box's sight),
  // shorter than the way into it: it is shown from its top until it has grown to its own height,
  // then placed as far into it as it was. A wheel, a press or a key the user gives stops it.
  const shown = item.style.contentVisibility
  item.style.contentVisibility = 'visible'
  const USER = ['wheel', 'pointerdown', 'keydown', 'touchstart'] as const
  let stopped = false
  const stop = () => (stopped = true)
  for (const kind of USER) box.addEventListener(kind, stop, { passive: true })
  const finish = () => {
    item.style.contentVisibility = shown
    for (const kind of USER) box.removeEventListener(kind, stop)
  }
  let frames = 60
  let steady = 0
  let last = -1
  const step = () => {
    if (stopped || !box.isConnected) return finish()
    const height = item.getBoundingClientRect().height
    placeAnchor(box, item, height > anchor.offset ? anchor.offset : 0)
    steady = height === last && height > anchor.offset ? steady + 1 : 0
    last = height
    if (steady >= 2 || --frames <= 0) return finish()
    requestAnimationFrame(step)
  }
  step()
}
