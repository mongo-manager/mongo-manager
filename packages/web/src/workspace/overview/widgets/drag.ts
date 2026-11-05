// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { nextTick, onBeforeUnmount, ref, type CSSProperties } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Widget } from '@mongo-manager/shared/browser'
import { useDashboardStore } from '@/stores/dashboard'
import { clampColumn, WIDE_COLUMNS } from './grid'

/** A press moves this far (px) before it is a drag: a click on the handle is not one. */
const THRESHOLD = 4
/** How long the others take to make room, and the dropped widget to settle (ms). */
const MOVE_MS = 200
const SETTLE_MS = 180
/** Below the grid's last row (px), a drop still counts: a widget may go to a new last row. */
const BELOW = 160
/** After a widget is put in a gap, the pointer moves this far (px) before another is chosen. */
const GAP_STEP = 8
/** Near the scrolling area's top or bottom edge (px), the page scrolls while dragging. */
const EDGE = 64
const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)'

interface Session {
  id: string
  pointerId: number
  startX: number
  startY: number
  x: number
  y: number
  /** Where the pointer took the widget, from its top-left corner. */
  grabX: number
  grabY: number
  origin: number
  /** Its start column then, put back too on cancel (final review 2). */
  originCol: number | null
  started: boolean
  /** The widget it last took the place of: not taken again until the pointer leaves it. */
  swapped: string | null
  /** The gap it was last put in, and where the pointer was then. */
  gap: { key: string; x: number; y: number } | null
}

const reducedMotion = () =>
  typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

/** The nearest ancestor that scrolls vertically (the workspace's main area), or none. */
function scroller(el: HTMLElement | null): HTMLElement | null {
  for (let node = el?.parentElement ?? null; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node)
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) return node
  }
  return null
}

/**
 * User review 2026-10-09 ("yerlerini değiştirebilmeliyim … güzel akışkan bir drag drop"): moving
 * widgets in edit mode.
 * - With a pointer (mouse, pen or touch) on a widget's handle: the widget follows the pointer,
 *   lifted; the others make room as it passes over them, gliding to their new places; its place
 *   shows as a dashed space; dropped, it settles there. Escape puts it back. Near the top or bottom
 *   edge the page scrolls.
 * - With the keyboard: Space (or Enter) picks it up, the arrow keys move it, Space drops it, Escape
 *   puts it back.
 * A live region says where it is.
 */
export function useWidgetDrag(titleOf: (widget: Widget) => string) {
  const { t } = useI18n()
  const store = useDashboardStore()
  /** The widget held with a pointer (its cell shows its place), and where its body is drawn. */
  const dragging = ref<string | null>(null)
  const offset = ref({ x: 0, y: 0 })
  const settling = ref(false)
  const picked = ref<{ id: string; from: number } | null>(null)
  const announcement = ref('')
  let session: Session | null = null
  let frame = 0
  let settleTimer: ReturnType<typeof setTimeout> | undefined
  let userSelect = ''

  const indexOf = (id: string) => store.widgets.findIndex((w) => w.id === id)
  const widgetOf = (id: string) => store.widgets.find((w) => w.id === id)
  const cells = () => [...document.querySelectorAll<HTMLElement>('[data-cell-id]')]
  const cellOf = (id: string) => cells().find((el) => el.dataset.cellId === id) ?? null
  const say = (text: string) => {
    // A new text each time, even when the words repeat (the region announces changes).
    announcement.value = ''
    void nextTick(() => (announcement.value = text))
  }

  /**
   * Changes the order, the other widgets gliding from where they were to their new places (FLIP:
   * the old places are measured, the change made, the difference animated away).
   */
  function reorder(change: () => void, moving: string | null): Promise<void> {
    const before = new Map(
      cells()
        .filter((el) => el.dataset.cellId !== moving)
        .map((el) => [el, el.getBoundingClientRect()] as const),
    )
    change()
    return nextTick(() => {
      if (reducedMotion()) return
      for (const [el, was] of before) {
        if (!el.isConnected) continue
        const now = el.getBoundingClientRect()
        const dx = was.left - now.left
        const dy = was.top - now.top
        if (!dx && !dy) continue
        el.style.transition = 'none'
        el.style.transform = `translate(${dx}px, ${dy}px)`
        void el.offsetWidth
        el.style.transition = `transform ${MOVE_MS}ms ${EASE}`
        el.style.transform = ''
        const done = () => {
          el.style.transition = ''
          el.removeEventListener('transitionend', done)
        }
        el.addEventListener('transitionend', done)
      }
    })
  }

  /** The held widget's body, drawn under the pointer (its cell stays where it now belongs). */
  function follow(): void {
    if (!session) return
    const cell = cellOf(session.id)
    if (!cell) return
    const place = cell.getBoundingClientRect()
    offset.value = {
      x: session.x - session.grabX - place.left,
      y: session.y - session.grabY - place.top,
    }
  }

  /** The widget under the pointer gives the held one its place. */
  function retarget(): void {
    const s = session
    if (!s) return
    const over = cells().find((el) => {
      if (el.dataset.cellId === s.id) return false
      const r = el.getBoundingClientRect()
      return s.x >= r.left && s.x <= r.right && s.y >= r.top && s.y <= r.bottom
    })
    const overId = over?.dataset.cellId ?? null
    if (!overId) {
      s.swapped = null
      toGap(s)
      return
    }
    // Taking a bigger widget's place may leave the pointer still over it: not swapped back.
    if (overId === s.swapped) return
    s.swapped = overId
    s.gap = null
    const to = indexOf(overId)
    if (to < 0 || to === indexOf(s.id)) return
    // It takes the other's place on the grid too: its column, or a new row if the other starts one
    // (so the row above may be left short).
    const wide = wideGrid()
    const startsRow = !!wide && to > 0 && Math.abs(over!.getBoundingClientRect().left - wide.box.left) < 1
    const other = widgetOf(overId)
    const col = other?.col ?? (startsRow ? 1 : null)
    // The column moves across: the other one follows it, never two at one column (final review 9).
    void reorder(() => {
      if (other?.col !== undefined) store.setColumn(overId, null)
      store.place(s.id, to, col)
    }, s.id).then(follow)
    const w = widgetOf(s.id)
    if (w) say(t('overview.dashboard.moved', { title: titleOf(w), n: to + 1, count: store.widgets.length }))
  }

  /** The grid when it is the wide one (12 columns): its box and the space between columns. */
  function wideGrid(): { box: DOMRect; gap: number } | null {
    const grid = document.querySelector<HTMLElement>('[data-dashboard-grid]')
    if (!grid) return null
    const style = getComputedStyle(grid)
    if (style.gridTemplateColumns.split(' ').filter(Boolean).length !== WIDE_COLUMNS) return null
    return { box: grid.getBoundingClientRect(), gap: parseFloat(style.columnGap) || 0 }
  }

  /**
   * User review 2026-10-09 ("widgetlar arası boşlukta ekleyebilmeliyim"): over an empty space of the
   * wide grid, the widget goes there — its left edge to the nearest column, after the widgets before
   * that place — and the space before it stays empty. A narrower grid only changes the order.
   */
  function toGap(s: Session): void {
    const wide = wideGrid()
    const w = widgetOf(s.id)
    if (!wide || !w) return
    const { box, gap } = wide
    if (s.x < box.left || s.x > box.right || s.y < box.top || s.y > box.bottom + BELOW) return
    if (s.gap && Math.hypot(s.x - s.gap.x, s.y - s.gap.y) < GAP_STEP) return
    const step = (box.width + gap) / WIDE_COLUMNS
    const col = clampColumn((s.x - s.grabX - box.left) / step + 1, w.size)
    const colX = box.left + (col - 1) * step
    // The widgets before the place: on rows above it, or on its row and to its left.
    const others = cells().filter((el) => el.dataset.cellId !== s.id)
    const before = others.filter((el) => {
      const r = el.getBoundingClientRect()
      return r.width > 0 && (r.bottom <= s.y || (r.top <= s.y && r.left < colX))
    }).length
    const from = indexOf(s.id)
    const next = others[before]
    const target = next ? indexOf(next.dataset.cellId!) : store.widgets.length
    const to = target > from ? target - 1 : target
    const key = `${to}:${col}`
    if (s.gap?.key === key) return
    s.gap = { key, x: s.x, y: s.y }
    if (to === from && w.col === col) return
    void reorder(() => store.place(s.id, to, col), s.id).then(follow)
    say(t('overview.dashboard.placed', { title: titleOf(w), n: to + 1, count: store.widgets.length, col }))
  }

  /** Near an edge of the scrolling area, it scrolls (and the held widget goes on following). */
  function autoscroll(): void {
    cancelAnimationFrame(frame)
    if (!session?.started) return
    const area = scroller(cellOf(session.id))
    if (!area) return
    const box = area.getBoundingClientRect()
    const speed =
      session.y < box.top + EDGE
        ? -Math.ceil((box.top + EDGE - session.y) / 6)
        : session.y > box.bottom - EDGE
          ? Math.ceil((session.y - (box.bottom - EDGE)) / 6)
          : 0
    if (!speed) return
    area.scrollTop += speed
    follow()
    retarget()
    frame = requestAnimationFrame(autoscroll)
  }

  function onMove(event: PointerEvent): void {
    if (!session || event.pointerId !== session.pointerId) return
    session.x = event.clientX
    session.y = event.clientY
    if (!session.started) {
      if (Math.hypot(session.x - session.startX, session.y - session.startY) < THRESHOLD) return
      session.started = true
      clearTimeout(settleTimer)
      settling.value = false
      dragging.value = session.id
      userSelect = document.body.style.userSelect
      document.body.style.userSelect = 'none'
      const w = widgetOf(session.id)
      if (w) say(t('overview.dashboard.picked', { title: titleOf(w) }))
    }
    event.preventDefault()
    follow()
    retarget()
    autoscroll()
  }

  function stop(): void {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onCancel)
    window.removeEventListener('keydown', onKey, true)
    cancelAnimationFrame(frame)
    if (session?.started) document.body.style.userSelect = userSelect
  }

  /** The held widget glides into its place, then is set down. */
  function settle(): void {
    session = null
    if (reducedMotion()) {
      dragging.value = null
      offset.value = { x: 0, y: 0 }
      return
    }
    settling.value = true
    offset.value = { x: 0, y: 0 }
    settleTimer = setTimeout(() => {
      settling.value = false
      dragging.value = null
    }, SETTLE_MS)
  }

  function onUp(event: PointerEvent): void {
    const s = session
    if (!s || event.pointerId !== s.pointerId) return
    stop()
    if (!s.started) {
      session = null
      return
    }
    const w = widgetOf(s.id)
    if (w)
      say(
        t('overview.dashboard.dropped', {
          title: titleOf(w),
          n: indexOf(s.id) + 1,
          count: store.widgets.length,
        }),
      )
    settle()
  }

  /** Escape, or the system taking the pointer away: the widget goes back where it was. */
  function cancel(): void {
    const s = session
    if (!s) return
    stop()
    if (!s.started) {
      session = null
      return
    }
    void reorder(() => store.place(s.id, s.origin, s.originCol), s.id)
    const w = widgetOf(s.id)
    if (w) say(t('overview.dashboard.cancelled', { title: titleOf(w), n: s.origin + 1 }))
    settle()
  }
  function onCancel(event: PointerEvent): void {
    if (session && event.pointerId === session.pointerId) cancel()
  }
  function onKey(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || !session?.started) return
    event.preventDefault()
    event.stopPropagation()
    cancel()
  }

  function onPointerDown(widget: Widget, event: PointerEvent): void {
    // The main button only; one drag at a time; not while one is held by keyboard.
    if (event.button !== 0 || session) return
    // A widget held by keyboard is set down where it is: the pointer takes over (final review 10).
    if (picked.value) {
      const held = widgetOf(picked.value.id)
      picked.value = null
      if (held)
        say(
          t('overview.dashboard.dropped', {
            title: titleOf(held),
            n: indexOf(held.id) + 1,
            count: store.widgets.length,
          }),
        )
    }
    const cell = cellOf(widget.id)
    if (!cell) return
    const r = cell.getBoundingClientRect()
    session = {
      id: widget.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      grabX: event.clientX - r.left,
      grabY: event.clientY - r.top,
      origin: indexOf(widget.id),
      originCol: widget.col ?? null,
      started: false,
      swapped: null,
      gap: null,
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('keydown', onKey, true)
  }

  // ---- Keyboard
  const refocus = (id: string) =>
    void nextTick(() =>
      document.querySelector<HTMLElement>(`[data-widget-id="${id}"] [data-widget-handle]`)?.focus(),
    )
  function onKeydown(widget: Widget, event: KeyboardEvent): void {
    if (session) return
    const title = titleOf(widget)
    const count = store.widgets.length
    const holding = picked.value?.id === widget.id
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault()
      if (holding) {
        picked.value = null
        say(t('overview.dashboard.dropped', { title, n: indexOf(widget.id) + 1, count }))
      } else {
        picked.value = { id: widget.id, from: indexOf(widget.id) }
        say(t('overview.dashboard.picked', { title }))
      }
      return
    }
    if (!holding) return
    if (event.key === 'Escape') {
      event.preventDefault()
      const from = picked.value!.from
      void reorder(() => store.move(widget.id, from), null)
      say(t('overview.dashboard.cancelled', { title, n: from + 1 }))
      picked.value = null
      refocus(widget.id)
      return
    }
    const delta =
      event.key === 'ArrowUp' || event.key === 'ArrowLeft'
        ? -1
        : event.key === 'ArrowDown' || event.key === 'ArrowRight'
          ? 1
          : 0
    if (!delta) return
    event.preventDefault()
    const to = Math.max(0, Math.min(count - 1, indexOf(widget.id) + delta))
    void reorder(() => store.move(widget.id, to), null)
    say(t('overview.dashboard.moved', { title, n: to + 1, count }))
    refocus(widget.id)
  }

  /** The handle's bindings for one widget. */
  function handleFor(widget: Widget): Record<string, unknown> {
    return {
      'aria-pressed': picked.value?.id === widget.id ? 'true' : 'false',
      // A touch on the handle drags the widget, never the page.
      style: { touchAction: 'none' },
      onPointerdown: (event: PointerEvent) => onPointerDown(widget, event),
      onKeydown: (event: KeyboardEvent) => onKeydown(widget, event),
    }
  }

  /** A widget's body: lifted under the pointer while held, gliding into place when dropped. */
  function bodyStyle(id: string): CSSProperties {
    if (dragging.value !== id) return {}
    const lift = settling.value || reducedMotion() ? '' : ' scale(1.02)'
    return {
      transform: `translate(${offset.value.x}px, ${offset.value.y}px)${lift}`,
      transition: settling.value ? `transform ${SETTLE_MS}ms ${EASE}` : 'none',
      position: 'relative',
      zIndex: 30,
      cursor: settling.value ? undefined : 'grabbing',
    }
  }

  /** Edit mode ends (or the page goes): a widget held is set down where it is. */
  function release(): void {
    if (session) {
      stop()
      session = null
    }
    clearTimeout(settleTimer)
    picked.value = null
    dragging.value = null
    settling.value = false
    offset.value = { x: 0, y: 0 }
  }
  onBeforeUnmount(release)

  return { handleFor, bodyStyle, release, announcement, dragging, settling }
}
