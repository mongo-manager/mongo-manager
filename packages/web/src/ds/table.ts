// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
/** A DsDataTable column (UI redesign R2–R5 spec §2). */
export interface DsColumn {
  key: string
  label: string
  /** Numbers and sizes line up on the right. */
  align?: 'left' | 'right'
  /** Technical values (names, keys, ids) in mono. */
  mono?: boolean
  /** A CSS width (`12rem`, `20%`); the rest share what is left. */
  width?: string
  /** The column's name for screen readers only (an icon column). */
  hideLabel?: boolean
  /**
   * The table's own width (px) below which this column leaves (review of the Monitoring redesign,
   * Important 1): the least needed columns go first on a phone or a narrow card.
   */
  hideBelow?: number
}

/**
 * Review of the Monitoring redesign (minor): after an action removed its row, focus goes to the row
 * now in its place (its first control, a "…" usually), or the last row, or the card's title when no
 * row is left — never to the page's body.
 */
export function focusAfterRemoval(container: Element | null | undefined, index: number): void {
  if (!container) return
  const rows = [...container.querySelectorAll('tbody tr')]
  const row = rows[Math.min(index, rows.length - 1)]
  const target =
    row?.querySelector<HTMLElement>('td:last-child button, td:last-child a[href]') ??
    container.querySelector<HTMLElement>('h2, h3')
  if (!target) return
  if (target.matches('h2, h3')) target.tabIndex = -1
  target.focus()
}

/** A fixed width in px (rem at 16 px, px, % of the box); NaN when it is not one of those. */
export function widthPx(width: string, box: number): number {
  const m = /^(\d+(?:\.\d+)?)(rem|px|%)$/.exec(width.trim())
  if (!m) return Number.NaN
  const n = Number(m[1])
  return m[2] === 'rem' ? n * 16 : m[2] === 'px' ? n : (n / 100) * box
}
