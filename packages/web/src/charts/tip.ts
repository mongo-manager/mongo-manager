// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
/**
 * User report 2026-10-16: a tooltip drawn on the chart's canvas could not leave the chart, and a
 * chart of six series showed half of it. The app draws it instead, above the page and as text
 * (series names and labels are user data: never markup).
 */
export interface TipRow {
  name: string
  value: string
  color?: string
}
export interface TipContent {
  rows: TipRow[]
}

/** What the chart says is pointed at: a sample of a line chart, or a bar, point or slice (of a series). */
export type ChartHit = { kind: 'sample'; index: number } | { kind: 'item'; index: number; series?: number }

const GAP = 12
const EDGE = 8

/** Where the tooltip goes: beside the pointer, on the side with room, never off the window. */
export function tipPlacement(
  pointer: { x: number; y: number },
  size: { width: number; height: number },
  view: { width: number; height: number },
): { left: number; top: number } {
  const place = (at: number, length: number, room: number) => {
    const after = at + GAP
    if (after + length <= room - EDGE) return after
    const before = at - GAP - length
    if (before >= EDGE) return before
    return Math.max(EDGE, Math.min(after, room - EDGE - length))
  }
  return { left: place(pointer.x, size.width, view.width), top: place(pointer.y, size.height, view.height) }
}
