import { onBeforeUnmount, ref, type Ref } from 'vue'
import type { Widget } from '@mongo-manager/shared/browser'

/** The Overview's wide grid (lg and up): 12 columns; narrower ones have 6, then 1. */
export const WIDE_COLUMNS = 12

/** Columns a widget takes on the wide grid. */
export const WIDE_SPAN: Record<Widget['size'], number> = { s: 3, m: 6, l: 9, xl: 12 }

/** Where a widget may start on the wide grid, whole on it whatever its width (1 to 13 − its span). */
export const clampColumn = (col: number, size: Widget['size']) =>
  Math.max(1, Math.min(Math.round(col), WIDE_COLUMNS + 1 - WIDE_SPAN[size]))

/** Tailwind's lg: where the grid has its 12 columns and a start column shows. */
const WIDE_QUERY = '(min-width: 64rem)'

/**
 * Whether the screen is wide enough for the 12-column grid, while the calling component is mounted:
 * rows and gaps are offered only there, where they show (final review 11).
 */
export function useWideScreen(): Readonly<Ref<boolean>> {
  const media = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  const query = media ? window.matchMedia(WIDE_QUERY) : null
  const wide = ref(query?.matches ?? true)
  const change = (e: MediaQueryListEvent) => (wide.value = e.matches)
  query?.addEventListener?.('change', change)
  onBeforeUnmount(() => query?.removeEventListener?.('change', change))
  return wide
}
