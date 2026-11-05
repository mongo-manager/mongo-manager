// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { computed, ref, shallowRef } from 'vue'
import { defineStore } from 'pinia'
import {
  DASHBOARD_LIMITS,
  WIDGET_TYPES,
  defaultDashboard,
  widgetKey,
  type Widget,
  type WidgetSize,
  type WidgetType,
} from '@mongo-manager/shared/browser'
import { dashboardApi } from '@/api/dashboard'
import { randomId } from '@/uuid'

/** A change is saved this long after the last one (several quick changes, one save). */
const SAVE_DELAY = 500

/**
 * User review 2026-10-09 ("widget gibi ekle, kaldır, yerlerini değiştir"): the user's Overview
 * dashboard. Edits change the local copy at once and are saved a moment later (the whole layout, last
 * write wins). A layout that could not be loaded is never overwritten: until a load succeeds, the
 * default is shown and nothing is saved.
 */
export const useDashboardStore = defineStore('dashboard', () => {
  const widgets = ref<Widget[]>([])
  const status = ref<'idle' | 'loading' | 'ready' | 'unavailable'>('idle')
  const editing = ref(false)
  const saveFailed = ref(false)
  /** The saved layout is a newer version's: the default is shown, and nothing is saved over it. */
  const newer = ref(false)
  let owner: string | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let saving: Promise<void> = Promise.resolve()

  /** Today's Overview, less what the user hid there before, collapsed as they left it (once). */
  function carriedOver(userId: string): Widget[] | null {
    const key = `mm:overview:${userId}`
    let parsed: unknown
    try {
      parsed = JSON.parse(localStorage.getItem(key) ?? 'null')
      localStorage.removeItem(key)
    } catch {
      return null
    }
    if (!parsed || typeof parsed !== 'object') return null
    const stored = parsed as { hidden?: unknown; collapsed?: unknown }
    const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
    const hidden = list(stored.hidden)
    const collapsed = list(stored.collapsed)
    return defaultDashboard(randomId)
      .widgets.filter((w) => !hidden.includes(w.type))
      .map((w) => (collapsed.includes(w.type) ? { ...w, collapsed: true } : w))
  }

  async function load(userId: string): Promise<void> {
    if (owner === userId && (status.value === 'loading' || status.value === 'ready')) return
    owner = userId
    status.value = 'loading'
    newer.value = false
    try {
      const { dashboard, newer: isNewer } = await dashboardApi.get()
      if (owner !== userId) return
      if (isNewer) {
        newer.value = true
        widgets.value = defaultDashboard(randomId).widgets
        status.value = 'unavailable'
        return
      }
      const old = dashboard ? null : carriedOver(userId)
      widgets.value = dashboard?.widgets ?? old ?? defaultDashboard(randomId).widgets
      status.value = 'ready'
      // The old choices are kept the first time; today's Overview alone needs no saving.
      if (old) schedule()
    } catch {
      if (owner !== userId) return
      widgets.value = defaultDashboard(randomId).widgets
      status.value = 'unavailable'
    }
  }

  function schedule(): void {
    if (status.value !== 'ready') return
    clearTimeout(timer)
    timer = setTimeout(() => void save(), SAVE_DELAY)
  }
  function save(init?: { keepalive?: boolean }): Promise<void> {
    clearTimeout(timer)
    timer = undefined
    // One at a time, the layout as it is when it is sent: a slow save is never overtaken by an older
    // one (final review 6).
    saving = saving.then(() =>
      dashboardApi
        .save({ version: 1, widgets: widgets.value }, init)
        .then(() => {
          saveFailed.value = false
        })
        .catch(() => {
          // The changes stay here; the next change tries again.
          saveFailed.value = true
        }),
    )
    return saving
  }
  // A change still waiting when the page goes away (a reload, a closed tab) is sent so that it
  // outlives the page (review of the e2e gaps, I1).
  if (typeof window !== 'undefined')
    window.addEventListener('pagehide', () => {
      if (timer === undefined) return
      // Sent at once, not after a save under way: the page may be gone by then (that one, older,
      // was sent first).
      clearTimeout(timer)
      timer = undefined
      void dashboardApi
        .save({ version: 1, widgets: widgets.value }, { keepalive: true })
        .catch(() => undefined)
    })
  /** Saves what is waiting now (tests; leaving the page). */
  async function flush(): Promise<void> {
    if (timer !== undefined) await save()
    await saving
  }

  const at = (id: string) => widgets.value.findIndex((w) => w.id === id)
  function update(id: string, change: (w: Widget) => Widget): void {
    const i = at(id)
    if (i < 0) return
    widgets.value = widgets.value.map((w, j) => (j === i ? change(w) : w))
    schedule()
  }

  /**
   * User report 2026-10-27: the widget is there already (showing that, its id aside) — a widget is on
   * the dashboard once.
   */
  const shownBy = (widget: { type: string; settings?: object }, id?: string) =>
    widgets.value.some((w) => w.id !== id && widgetKey(w) === widgetKey(widget))

  /** A widget more, at the end; null when the dashboard is full, the type unknown or it is there. */
  function add(type: WidgetType, settings: object = {}, size: WidgetSize = 'm'): string | null {
    if (widgets.value.length >= DASHBOARD_LIMITS.widgets || !WIDGET_TYPES.includes(type)) return null
    if (shownBy({ type, settings })) return null
    const id = randomId()
    widgets.value = [...widgets.value, { id, type, size, settings } as Widget]
    schedule()
    return id
  }
  function remove(id: string): void {
    widgets.value = widgets.value.filter((w) => w.id !== id)
    schedule()
  }
  /** Puts a removed widget back where it was (Undo): once, and never past the limit. */
  function restore(widget: Widget, at: number): void {
    if (widgets.value.some((w) => w.id === widget.id) || shownBy(widget)) return
    if (widgets.value.length >= DASHBOARD_LIMITS.widgets) return
    const next = [...widgets.value]
    next.splice(Math.max(0, Math.min(at, next.length)), 0, widget)
    widgets.value = next
    schedule()
  }
  function move(id: string, to: number): void {
    const from = at(id)
    if (from < 0) return
    const target = Math.max(0, Math.min(widgets.value.length - 1, to))
    if (target === from) return
    const next = [...widgets.value]
    const [moved] = next.splice(from, 1)
    next.splice(target, 0, moved!)
    widgets.value = next
    schedule()
  }
  /** The column a widget starts at on the wide grid (1–12), or none: it follows the one before. */
  const setColumn = (id: string, col: number | null) =>
    update(id, (w) => {
      const { col: _, ...rest } = w
      return (col === null ? rest : { ...rest, col: Math.max(1, Math.min(12, Math.round(col))) }) as Widget
    })
  /** Moves a widget and sets where it starts on the wide grid, as one change. */
  function place(id: string, to: number, col: number | null): void {
    move(id, to)
    setColumn(id, col)
  }
  const resize = (id: string, size: WidgetSize) => update(id, (w) => ({ ...w, size }))
  /** New settings, unless another widget shows that already. */
  function configure(id: string, settings: object): void {
    const widget = widgets.value[at(id)]
    if (!widget || shownBy({ type: widget.type, settings }, id)) return
    update(id, (w) => ({ ...w, settings }) as Widget)
  }
  const setCollapsed = (id: string, value: boolean) =>
    update(id, (w) => {
      const { collapsed: _, ...rest } = w
      return (value ? { ...rest, collapsed: true } : rest) as Widget
    })

  async function resetToDefault(): Promise<void> {
    clearTimeout(timer)
    timer = undefined
    // After a save on its way: it would bring the old layout back.
    await saving
    await dashboardApi.reset()
    widgets.value = defaultDashboard(randomId).widgets
    status.value = 'ready'
  }

  /**
   * User review 2026-10-09 ("vazgeç de ekle"): editing can be cancelled — the layout goes back to how
   * it was when editing began (a reset to the default too), saved once if it changed.
   */
  const before = shallowRef<string | null>(null)
  const snapshot = () => JSON.stringify(widgets.value)
  const changed = computed(() => before.value !== null && before.value !== snapshot())
  function beginEdit(): void {
    before.value = snapshot()
    editing.value = true
  }
  function endEdit(): void {
    before.value = null
    editing.value = false
    // Review of the e2e gaps (I1): what the edit left waiting is saved now, not half a second later.
    if (timer !== undefined) void save()
  }
  function discardEdit(): void {
    if (changed.value) {
      widgets.value = JSON.parse(before.value!) as Widget[]
      schedule()
    }
    endEdit()
  }

  /** Sign-out: nothing of the previous user stays (their saved layout stays theirs, on the server). */
  function reset(): void {
    before.value = null
    clearTimeout(timer)
    timer = undefined
    owner = null
    widgets.value = []
    status.value = 'idle'
    editing.value = false
    saveFailed.value = false
    newer.value = false
  }

  return {
    widgets,
    status,
    editing,
    newer,
    changed,
    saveFailed,
    beginEdit,
    endEdit,
    discardEdit,
    load,
    add,
    remove,
    restore,
    move,
    place,
    setColumn,
    resize,
    configure,
    setCollapsed,
    resetToDefault,
    flush,
    reset,
    shownBy,
  }
})
