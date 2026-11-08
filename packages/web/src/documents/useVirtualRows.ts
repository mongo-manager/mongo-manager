// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { computed, onBeforeUnmount, onMounted, ref, type Ref } from 'vue'

export interface VisibleRange {
  start: number
  end: number
  padTop: number
  padBottom: number
}

/** Rows [start, end) to render for a fixed row height, with spacer heights above and below. */
export function visibleRange(
  scrollTop: number,
  viewport: number,
  count: number,
  rowHeight: number,
  overscan: number,
): VisibleRange {
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan)
  const end = Math.min(count, Math.ceil((scrollTop + viewport) / rowHeight) + overscan)
  return { start, end, padTop: start * rowHeight, padBottom: (count - end) * rowHeight }
}

export function useVirtualRows(
  container: Ref<HTMLElement | null>,
  count: Ref<number>,
  rowHeight: Ref<number>,
  overscan = 10,
) {
  const scrollTop = ref(0)
  const viewport = ref(0)
  let observer: ResizeObserver | undefined
  const onScroll = () => {
    scrollTop.value = container.value?.scrollTop ?? 0
  }

  onMounted(() => {
    const el = container.value
    if (!el) return
    el.addEventListener('scroll', onScroll, { passive: true })
    viewport.value = el.clientHeight
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => {
        viewport.value = el.clientHeight
      })
      observer.observe(el)
    }
  })
  onBeforeUnmount(() => {
    container.value?.removeEventListener('scroll', onScroll)
    observer?.disconnect()
  })

  // Before layout (and without one, e.g. in tests) assume a tall viewport so the first screen renders.
  return computed(() =>
    visibleRange(scrollTop.value, viewport.value || 800, count.value, rowHeight.value, overscan),
  )
}
