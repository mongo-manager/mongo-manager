// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
/** Where a floating box sits next to its anchor (UI redesign R1 spec §2). */
export type Placement = 'bottom-start' | 'bottom-end' | 'bottom' | 'top-start' | 'right-start'

const MARGIN = 8

/** Fixed-position coordinates: flipped when it does not fit, always inside the window. */
export function place(
  anchor: DOMRect,
  box: { width: number; height: number },
  placement: Placement = 'bottom-start',
  gap = 6,
): { top: number; left: number } {
  const vw = window.innerWidth
  const vh = window.innerHeight
  let top: number
  let left: number
  if (placement === 'right-start') {
    left = anchor.right + gap
    top = anchor.top
    if (left + box.width > vw - MARGIN) left = anchor.left - box.width - gap
  } else if (placement === 'top-start') {
    top = anchor.top - box.height - gap
    left = anchor.left
    if (top < MARGIN) top = anchor.bottom + gap
  } else {
    top = anchor.bottom + gap
    left =
      placement === 'bottom-end'
        ? anchor.right - box.width
        : placement === 'bottom'
          ? anchor.left + anchor.width / 2 - box.width / 2
          : anchor.left
    if (top + box.height > vh - MARGIN && anchor.top - box.height - gap >= MARGIN)
      top = anchor.top - box.height - gap
  }
  return {
    top: Math.min(Math.max(MARGIN, top), Math.max(MARGIN, vh - box.height - MARGIN)),
    left: Math.min(Math.max(MARGIN, left), Math.max(MARGIN, vw - box.width - MARGIN)),
  }
}
