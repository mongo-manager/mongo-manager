// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { Dashboard } from '@mongo-manager/shared'
import HomeView from '../src/workspace/HomeView.vue'
import DialogHost from '../src/ds/DsConfirmHost.vue'
import { useDashboardStore } from '../src/stores/dashboard'
import { useSessionStore } from '../src/stores/session'
import { usePlacesStore } from '../src/stores/places'
import { useTabsStore } from '../src/stores/tabs'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'
import { button } from './support/dom'

const CONN = {
  id: 'c1',
  name: 'Production',
  group: 'EU',
  color: null,
  favorite: false,
  readOnly: false,
  access: 'admin',
  permissions: ['documents:read'],
}
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const SAVED: Dashboard = {
  version: 1,
  widgets: [
    { id: id(1), type: 'quick', size: 'm', settings: {} },
    { id: id(2), type: 'pinned', size: 'm', settings: {} },
    { id: id(3), type: 'activity', size: 'xl', settings: {} },
  ],
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  i18n.global.locale.value = 'en'
  useSessionStore().me = {
    mode: 'team',
    user: { id: 'u1', username: 'ayse', role: 'admin' },
    permissions: ['connections:manage'],
    csrfToken: 'c',
    readOnly: false,
    twoFactor: {},
  } as never
  useSessionStore().status = { mode: 'team', setupRequired: false, authenticated: true }
  useTabsStore().bindUser('u1')
  usePlacesStore().bindUser('u1')
})
afterEach(() => {
  // A save still waiting would reach the next test's mocked server.
  useDashboardStore().reset()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

function api(dashboard: Dashboard | null | 'fail' = SAVED) {
  return mockApi({
    'GET connections': () => [200, [CONN]],
    'GET me/dashboard': () =>
      dashboard === 'fail' ? [500, { code: 'INTERNAL', message: 'x' }] : [200, { dashboard }],
    'PUT me/dashboard': (body) => [200, { dashboard: body }],
    'DELETE me/dashboard': () => [204],
  })
}
const types = () => [...document.querySelectorAll('[data-widget]')].map((w) => w.getAttribute('data-widget'))
const handle = (type: string) =>
  document.querySelector<HTMLButtonElement>(`[data-widget="${type}"] [data-widget-handle]`)!
const live = () => document.querySelector('[data-dashboard-live]')!.textContent!.trim()
const cellOf = (type: string) => document.querySelector(`[data-widget="${type}"]`)!.closest('[data-cell]')!
/** A pointer event (happy-dom has none: a mouse event with the pointer's fields). */
function pointer(target: EventTarget, type: string, x: number, y: number): void {
  const e = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0 })
  Object.defineProperty(e, 'pointerId', { value: 1 })
  target.dispatchEvent(e)
}
/** A layout for the grid's cells: one column, 100 px tall, 20 px apart (the test has no layout). */
function layoutCells(options: { wide?: boolean } = {}): () => void {
  const original = HTMLElement.prototype.getBoundingClientRect
  const rect = (left: number, top: number, width: number, height: number) =>
    ({
      left,
      top,
      right: left + width,
      bottom: top + height,
      width,
      height,
      x: left,
      y: top,
      toJSON() {},
    }) as DOMRect
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    // The grid: 12 columns of 84 px, 16 px apart (1184 px) on a wide screen.
    if (this.matches('[data-dashboard-grid]')) return rect(0, 0, 1184, 360)
    if (!this.matches('[data-cell]')) return original.call(this)
    const i = [...this.parentElement!.querySelectorAll(':scope > [data-cell]')].indexOf(this)
    return rect(0, i * 120, 300, 100)
  }
  const grid = document.querySelector<HTMLElement>('[data-dashboard-grid]')!
  if (options.wide) {
    grid.style.gridTemplateColumns = Array(12).fill('84px').join(' ')
    grid.style.columnGap = '16px'
  }
  return () => {
    HTMLElement.prototype.getBoundingClientRect = original
    grid.style.gridTemplateColumns = ''
    grid.style.columnGap = ''
  }
}
async function chooseFromMenu(type: string, label: string): Promise<void> {
  ;(
    document.querySelector(`[data-widget="${type}"] header button[aria-haspopup]`) as HTMLButtonElement
  ).click()
  await flushPromises()
  ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find((m) => m.textContent?.trim() === label)!
    .click()
  await flushPromises()
}
/** A wide screen (lg and up): the grid has 12 columns. */
const wideScreen = () =>
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('min-width'),
    media: q,
    addEventListener() {},
    removeEventListener() {},
  }))
const key = (el: Element, k: string) =>
  el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))

describe('the Overview dashboard (user review 2026-10-09)', () => {
  it('shows the saved widgets in order, with no editing controls until asked', async () => {
    api()
    mountApp(HomeView)
    await flushPromises()
    expect(types()).toEqual(['quick', 'pinned', 'activity'])
    expect(document.querySelector('[data-widget-handle]')).toBeNull()
    button('Customize dashboard').click()
    await flushPromises()
    expect(document.querySelectorAll('[data-widget-handle]')).toHaveLength(3)
    button('Done').click()
    await flushPromises()
    expect(document.querySelector('[data-widget-handle]')).toBeNull()
  })

  it('lays widgets out by their width on a 12-column grid', async () => {
    api()
    mountApp(HomeView)
    await flushPromises()
    const cell = (type: string) => document.querySelector(`[data-widget="${type}"]`)!.closest('[data-cell]')!
    expect(cell('quick').className).toContain('lg:col-span-6')
    expect(cell('activity').className).toContain('lg:col-span-12')
    expect(document.querySelector('[data-dashboard-grid]')!.className).toContain('lg:grid-cols-12')
  })

  it('adds a widget from the gallery, at the end, and saves', async () => {
    const { calls } = api()
    mountApp(HomeView)
    await flushPromises()
    button('Customize dashboard').click()
    await flushPromises()
    button('Add widget').click()
    await flushPromises()
    const gallery = document.querySelector('[data-widget-gallery]')!
    // One of a kind already there says so.
    expect(gallery.querySelector('[data-gallery="quick"]')!.textContent).toContain('Added')
    ;(gallery.querySelector('[data-gallery="continue"] button') as HTMLButtonElement).click()
    await flushPromises()
    expect(types()).toEqual(['quick', 'pinned', 'activity', 'continue'])
    await useDashboardStore().flush()
    expect(calls.filter((c) => c.method === 'PUT').at(-1)!.body).toMatchObject({
      widgets: [{ type: 'quick' }, { type: 'pinned' }, { type: 'activity' }, { type: 'continue', size: 'm' }],
    })
  })

  it('moves a widget by dragging it: it follows the pointer and the others make room as it passes', async () => {
    api()
    mountApp(HomeView)
    await flushPromises()
    button('Customize dashboard').click()
    await flushPromises()
    const restore = layoutCells()
    try {
      const from = handle('activity')
      pointer(from, 'pointerdown', 50, 260)
      // A small movement is not a drag yet.
      pointer(window, 'pointermove', 52, 261)
      await flushPromises()
      expect(cellOf('activity').hasAttribute('data-dragging')).toBe(false)
      // Over the first widget: it takes its place, and stays under the pointer.
      pointer(window, 'pointermove', 50, 30)
      await flushPromises()
      expect(types()).toEqual(['activity', 'quick', 'pinned'])
      const lifted = cellOf('activity')
      expect(lifted.getAttribute('data-dragging')).toBe('true')
      expect(lifted.querySelector<HTMLElement>('[data-drag-body]')!.style.transform).toContain('translate(')
      expect(live()).toContain('position 1 of 3')
      pointer(window, 'pointerup', 50, 30)
      await flushPromises()
      await new Promise((r) => setTimeout(r, 250))
      expect(cellOf('activity').hasAttribute('data-dragging')).toBe(false)
      expect(types()).toEqual(['activity', 'quick', 'pinned'])
      await useDashboardStore().flush()
    } finally {
      restore()
    }
  })

  it('starts no drag on a click on the handle, nor with another mouse button', async () => {
    api()
    mountApp(HomeView)
    await flushPromises()
    button('Customize dashboard').click()
    await flushPromises()
    const restore = layoutCells()
    try {
      pointer(handle('activity'), 'pointerdown', 50, 260)
      pointer(window, 'pointerup', 50, 260)
      await flushPromises()
      const right = new MouseEvent('pointerdown', { clientX: 50, clientY: 260, bubbles: true, button: 2 })
      Object.defineProperty(right, 'pointerId', { value: 2 })
      handle('activity').dispatchEvent(right)
      pointer(window, 'pointermove', 50, 30)
      await flushPromises()
      expect(types()).toEqual(['quick', 'pinned', 'activity'])
      expect(document.querySelector('[data-dragging]')).toBeNull()
    } finally {
      restore()
    }
  })

  it('sets a held widget down where it is when editing ends mid-drag', async () => {
    api()
    mountApp(HomeView)
    await flushPromises()
    button('Customize dashboard').click()
    await flushPromises()
    const restore = layoutCells()
    try {
      pointer(handle('activity'), 'pointerdown', 50, 260)
      pointer(window, 'pointermove', 50, 30)
      await flushPromises()
      button('Done').click()
      await flushPromises()
      expect(document.querySelector('[data-dragging]')).toBeNull()
      // The pointer goes on moving: nothing follows it any more.
      pointer(window, 'pointermove', 50, 140)
      await flushPromises()
      expect(types()).toEqual(['activity', 'quick', 'pinned'])
      expect(document.body.style.userSelect).toBe('')
      await useDashboardStore().flush()
    } finally {
      restore()
    }
  })

  it('leaves a gap: a widget dropped in an empty space stays at that column on the wide grid', async () => {
    api()
    mountApp(HomeView)
    await flushPromises()
    button('Customize dashboard').click()
    await flushPromises()
    const restore = layoutCells({ wide: true })
    try {
      const store = useDashboardStore()
      // Pinned (half wide), taken 50 px into it, dropped with its left edge near x = 600: column 7.
      pointer(handle('pinned'), 'pointerdown', 50, 140)
      pointer(window, 'pointermove', 640, 30)
      await flushPromises()
      expect(types()).toEqual(['quick', 'pinned', 'activity'])
      expect(store.widgets.find((w) => w.type === 'pinned')!.col).toBe(7)
      expect(cellOf('pinned').className).toContain('lg:col-start-7')
      expect(live()).toContain('column 7')
      // Too far right for its width: it starts where it still fits whole.
      pointer(window, 'pointermove', 1150, 30)
      await flushPromises()
      expect(store.widgets.find((w) => w.type === 'pinned')!.col).toBe(7)
      // A full-width widget can only start at column 1.
      pointer(window, 'pointerup', 1150, 30)
      await flushPromises()
      pointer(handle('activity'), 'pointerdown', 50, 260)
      pointer(window, 'pointermove', 640, 30)
      await flushPromises()
      expect(store.widgets.find((w) => w.type === 'activity')!.col ?? 1).toBe(1)
      pointer(window, 'pointerup', 640, 30)
      await flushPromises()
      await store.flush()
    } finally {
      restore()
    }
  })

  it('starts a new row when it takes the place of a widget that starts one, leaving the row above short', async () => {
    api()
    mountApp(HomeView)
    await flushPromises()
    button('Customize dashboard').click()
    await flushPromises()
    const restore = layoutCells({ wide: true })
    try {
      const store = useDashboardStore()
      // Pinned over Activity, which starts its row (at the grid's left edge).
      pointer(handle('pinned'), 'pointerdown', 50, 140)
      pointer(window, 'pointermove', 60, 270)
      await flushPromises()
      expect(types()).toEqual(['quick', 'activity', 'pinned'])
      pointer(window, 'pointerup', 60, 270)
      await flushPromises()
      expect(store.widgets.map((w) => w.type)).toEqual(['quick', 'activity', 'pinned'])
      expect(store.widgets.find((w) => w.type === 'pinned')!.col).toBe(1)
      // Over the first widget it is simply first.
      pointer(handle('pinned'), 'pointerdown', 50, 260)
      pointer(window, 'pointermove', 60, 30)
      await flushPromises()
      pointer(window, 'pointerup', 60, 30)
      await flushPromises()
      expect(store.widgets[0]!.type).toBe('pinned')
      expect(store.widgets[0]!.col).toBeUndefined()
      await store.flush()
    } finally {
      restore()
    }
  })

  it('puts back the column too when a drag is cancelled (final review 2)', async () => {
    api()
    mountApp(HomeView)
    await flushPromises()
    button('Customize dashboard').click()
    await flushPromises()
    const restore = layoutCells({ wide: true })
    try {
      const store = useDashboardStore()
      pointer(handle('pinned'), 'pointerdown', 50, 140)
      pointer(window, 'pointermove', 640, 30)
      await flushPromises()
      expect(store.widgets.find((w) => w.type === 'pinned')!.col).toBe(7)
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await flushPromises()
      expect(types()).toEqual(['quick', 'pinned', 'activity'])
      expect(store.widgets.find((w) => w.type === 'pinned')!.col).toBeUndefined()
    } finally {
      restore()
    }
  })

  it('moves the column across when taking another widget’s place, never doubling it (final review 9)', async () => {
    api()
    mountApp(HomeView)
    await flushPromises()
    const store = useDashboardStore()
    store.setColumn(store.widgets.find((w) => w.type === 'activity')!.id, 1)
    button('Customize dashboard').click()
    await flushPromises()
    const restore = layoutCells({ wide: true })
    try {
      // Pinned onto Activity (which starts its row at column 1).
      pointer(handle('pinned'), 'pointerdown', 50, 140)
      pointer(window, 'pointermove', 60, 270)
      await flushPromises()
      pointer(window, 'pointerup', 60, 270)
      await flushPromises()
      const cols = store.widgets.map((w) => [w.type, w.col])
      expect(cols).toEqual([
        ['quick', undefined],
        ['activity', undefined],
        ['pinned', 1],
      ])
      await store.flush()
    } finally {
      restore()
    }
  })

  it('lets a pointer drag start while a widget is held by keyboard, setting that one down (final review 10)', async () => {
    api()
    mountApp(HomeView)
    await flushPromises()
    button('Customize dashboard').click()
    await flushPromises()
    const restore = layoutCells()
    try {
      key(handle('quick'), ' ')
      await flushPromises()
      expect(handle('quick').getAttribute('aria-pressed')).toBe('true')
      pointer(handle('activity'), 'pointerdown', 50, 260)
      pointer(window, 'pointermove', 50, 30)
      await flushPromises()
      expect(types()[0]).toBe('activity')
      expect(handle('quick').getAttribute('aria-pressed')).toBe('false')
      pointer(window, 'pointerup', 50, 30)
      await flushPromises()
      await useDashboardStore().flush()
    } finally {
      restore()
    }
  })

  it('leaves no gap on a narrow grid: there the widgets only change order', async () => {
    api()
    mountApp(HomeView)
    await flushPromises()
    button('Customize dashboard').click()
    await flushPromises()
    const restore = layoutCells()
    try {
      pointer(handle('activity'), 'pointerdown', 50, 260)
      pointer(window, 'pointermove', 640, 30)
      await flushPromises()
      expect(types()).toEqual(['quick', 'pinned', 'activity'])
      expect(useDashboardStore().widgets.some((w) => w.col !== undefined)).toBe(false)
      pointer(window, 'pointerup', 640, 30)
    } finally {
      restore()
    }
  })

  it('offers rows and gaps from the menu only on the wide grid, where they show (final review 11)', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: false,
      media: q,
      addEventListener() {},
      removeEventListener() {},
    }))
    api()
    mountApp(HomeView)
    await flushPromises()
    button('Customize dashboard').click()
    await flushPromises()
    ;(
      document.querySelector('[data-widget="pinned"] header button[aria-haspopup]') as HTMLButtonElement
    ).click()
    await flushPromises()
    const labels = [...document.querySelectorAll('[role="menuitem"]')].map((m) => m.textContent?.trim())
    expect(labels).toContain('Remove')
    expect(labels).not.toContain('Start a new row')
  })

  it('starts a widget on a new row from its menu, and closes the gap again', async () => {
    wideScreen()
    api()
    mountApp(HomeView)
    await flushPromises()
    button('Customize dashboard').click()
    await flushPromises()
    const store = useDashboardStore()
    const pinned = () => store.widgets.find((w) => w.type === 'pinned')!
    await chooseFromMenu('pinned', 'Start a new row')
    expect(pinned().col).toBe(1)
    expect(cellOf('pinned').className).toContain('lg:col-start-1')
    await chooseFromMenu('pinned', 'Close the gap before it')
    expect(pinned().col).toBeUndefined()
    await store.flush()
  })

  it('puts a dragged widget back where it was on Escape', async () => {
    api()
    mountApp(HomeView)
    await flushPromises()
    button('Customize dashboard').click()
    await flushPromises()
    const restore = layoutCells()
    try {
      pointer(handle('activity'), 'pointerdown', 50, 260)
      pointer(window, 'pointermove', 50, 30)
      await flushPromises()
      expect(types()[0]).toBe('activity')
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await flushPromises()
      expect(types()).toEqual(['quick', 'pinned', 'activity'])
      expect(live()).toContain('back at position 3')
    } finally {
      restore()
    }
  })

  it('cancels an edit: the layout goes back to how it was, and editing ends', async () => {
    api()
    mountApp(HomeView)
    await flushPromises()
    button('Customize dashboard').click()
    await flushPromises()
    await chooseFromMenu('activity', 'Move up')
    await chooseFromMenu('quick', 'Remove')
    expect(types()).toEqual(['activity', 'pinned'])
    button('Cancel').click()
    await flushPromises()
    expect(types()).toEqual(['quick', 'pinned', 'activity'])
    expect(document.querySelector('[data-dashboard-bar]')).toBeNull()
    expect(document.querySelector('[data-dashboard-edit]')).not.toBeNull()
    await useDashboardStore().flush()
  })

  it('closes the widget gallery with Cancel, adding nothing', async () => {
    api()
    mountApp(HomeView)
    await flushPromises()
    button('Customize dashboard').click()
    await flushPromises()
    button('Add widget').click()
    await flushPromises()
    const gallery = document.querySelector('[data-widget-gallery]')!.closest('[role="dialog"]')!
    ;[...gallery.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Cancel')!.click()
    await flushPromises()
    expect(document.querySelector('[data-widget-gallery]')).toBeNull()
    expect(types()).toEqual(['quick', 'pinned', 'activity'])
  })

  it('tries the dashboard again from its callout (final review 7)', async () => {
    let fail = true
    mockApi({
      'GET connections': () => [200, [CONN]],
      'GET me/dashboard': () =>
        fail ? [500, { code: 'INTERNAL', message: 'x' }] : [200, { dashboard: SAVED }],
    })
    mountApp(HomeView)
    await flushPromises()
    expect(document.querySelector('[data-dashboard-unavailable]')).not.toBeNull()
    fail = false
    ;[...document.querySelectorAll<HTMLButtonElement>('[data-dashboard-unavailable] button')]
      .find((b) => b.textContent?.trim() === 'Retry')!
      .click()
    await flushPromises()
    expect(document.querySelector('[data-dashboard-unavailable]')).toBeNull()
    expect(types()).toEqual(['quick', 'pinned', 'activity'])
  })

  it('says when the layout was saved by a newer version, and offers no editing', async () => {
    mockApi({
      'GET connections': () => [200, [CONN]],
      'GET me/dashboard': () => [200, { dashboard: null, newer: true }],
    })
    mountApp(HomeView)
    await flushPromises()
    expect(document.querySelector('[data-dashboard-unavailable]')!.textContent).toContain('newer version')
    expect(document.querySelector('[data-dashboard-edit]')).toBeNull()
  })

  it('moves a widget by keyboard, saying where it is, and Escape puts it back', async () => {
    api()
    mountApp(HomeView)
    await flushPromises()
    button('Customize dashboard').click()
    await flushPromises()
    key(handle('quick'), ' ')
    await flushPromises()
    expect(handle('quick').getAttribute('aria-pressed')).toBe('true')
    expect(live()).toContain('Quick access picked up')
    key(handle('quick'), 'ArrowDown')
    await flushPromises()
    expect(types()).toEqual(['pinned', 'quick', 'activity'])
    expect(live()).toBe('Quick access moved to position 2 of 3.')
    expect(document.activeElement).toBe(handle('quick'))
    key(handle('quick'), 'ArrowDown')
    await flushPromises()
    key(handle('quick'), 'Escape')
    await flushPromises()
    expect(types()).toEqual(['quick', 'pinned', 'activity'])
    expect(live()).toContain('back at position 1')
    // Picked again and dropped with Space: it stays.
    key(handle('quick'), ' ')
    key(handle('quick'), 'ArrowDown')
    await flushPromises()
    key(handle('quick'), ' ')
    await flushPromises()
    expect(types()).toEqual(['pinned', 'quick', 'activity'])
    expect(handle('quick').getAttribute('aria-pressed')).toBe('false')
  })

  it('goes back to today’s Overview after asking', async () => {
    const { calls } = api()
    mountApp(HomeView)
    mountApp(DialogHost)
    await flushPromises()
    button('Customize dashboard').click()
    await flushPromises()
    button('Reset to default').click()
    await flushPromises()
    const dialog = document.querySelector('[role="alertdialog"], [role="dialog"]')!
    ;[...dialog.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Reset')!.click()
    await flushPromises()
    expect(calls.some((c) => c.method === 'DELETE' && c.path === 'me/dashboard')).toBe(true)
    expect(types()[0]).toBe('continue')
  })

  it('says when the dashboard could not be loaded, and shows today’s Overview without saving', async () => {
    const { calls } = api('fail')
    mountApp(HomeView)
    await flushPromises()
    expect(document.querySelector('[data-dashboard-unavailable]')).not.toBeNull()
    expect(types()).toContain('connections')
    expect(document.body.textContent).not.toContain('Customize dashboard')
    expect(calls.some((c) => c.method === 'PUT')).toBe(false)
  })

  it('starts with today’s Overview when nothing is saved', async () => {
    api(null)
    mountApp(HomeView)
    await flushPromises()
    expect(types().slice(0, 2)).toEqual(['continue', 'pinned'])
  })
})

describe('widgets with settings (user review 2026-10-09)', () => {
  const C1 = '00000000-0000-4000-8000-0000000000c1'
  const C2 = '00000000-0000-4000-8000-0000000000c2'
  function mongoApi() {
    return mockApi({
      'GET connections': () => [
        200,
        [
          { ...CONN, id: C1, name: 'Production', permissions: ['server:monitor'] },
          { ...CONN, id: C2, name: 'Reporting', permissions: ['documents:read'] },
        ],
      ],
      'GET me/dashboard': () => [200, { dashboard: SAVED }],
      'PUT me/dashboard': (body) => [200, { dashboard: body }],
      [`GET connections/${C1}/server/status`]: () => [500, { code: 'INTERNAL', message: 'x' }],
      [`GET connections/${C1}/server/replica`]: () => [200, { mode: 'standalone' }],
    })
  }
  const dialog = () => document.querySelector('[data-widget-settings]')!
  const select = (label: string) =>
    [...dialog().querySelectorAll('label')]
      .find((l) => l.textContent?.trim() === label)!
      .parentElement!.querySelector('select')!

  it('asks a MongoDB widget’s settings when it is added, offering only servers the user may watch', async () => {
    mongoApi()
    mountApp(HomeView)
    await flushPromises()
    button('Customize dashboard').click()
    await flushPromises()
    button('Add widget').click()
    await flushPromises()
    ;(document.querySelector('[data-gallery="metric"] button') as HTMLButtonElement).click()
    await flushPromises()
    const options = [...select('Connection').options].map((o) => o.textContent?.trim())
    expect(options).toEqual(['Production'])
    const metric = select('Metric')
    metric.value = 'network'
    metric.dispatchEvent(new Event('change'))
    await flushPromises()
    ;[...dialog().querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Add')!.click()
    await flushPromises()
    const added = useDashboardStore().widgets.at(-1)!
    expect(added).toMatchObject({
      type: 'metric',
      size: 'l',
      settings: { connectionId: C1, metric: 'network', range: 'live' },
    })
  })

  it('changes a widget’s settings from its menu', async () => {
    mongoApi()
    useDashboardStore()
    mountApp(HomeView)
    await flushPromises()
    const store = useDashboardStore()
    const id = store.add('serverStatus', { connectionId: C1 }, 'm')!
    button('Customize dashboard').click()
    await flushPromises()
    ;(
      document.querySelector(`[data-widget-id="${id}"] header button[aria-haspopup]`) as HTMLButtonElement
    ).click()
    await flushPromises()
    ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((m) => m.textContent?.trim() === 'Settings')!
      .click()
    await flushPromises()
    expect(select('Connection').value).toBe(C1)
    ;[...dialog().querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Save')!.click()
    await flushPromises()
    expect(store.widgets.find((w) => w.id === id)!.settings).toEqual({ connectionId: C1 })
  })

  // User report 2026-10-27 ("aynı sunucu durumu Demo ekleyebiliyorum saçma olmuş").
  it('offers a server’s widget only for the servers that have none, and says when every one has', async () => {
    const C3 = '00000000-0000-4000-8000-0000000000c3'
    mockApi({
      'GET connections': () => [
        200,
        [
          { ...CONN, id: C1, name: 'Production', permissions: ['server:monitor'] },
          { ...CONN, id: C3, name: 'Staging', permissions: ['server:monitor'] },
        ],
      ],
      'GET me/dashboard': () => [200, { dashboard: SAVED }],
      'PUT me/dashboard': (body) => [200, { dashboard: body }],
      [`GET connections/${C1}/server/status`]: () => [500, { code: 'INTERNAL', message: 'x' }],
      [`GET connections/${C3}/server/status`]: () => [500, { code: 'INTERNAL', message: 'x' }],
    })
    mountApp(HomeView)
    await flushPromises()
    const store = useDashboardStore()
    const first = store.add('serverStatus', { connectionId: C1 }, 'm')!
    button('Customize dashboard').click()
    await flushPromises()
    button('Add widget').click()
    await flushPromises()
    ;(document.querySelector('[data-gallery="serverStatus"] button') as HTMLButtonElement).click()
    await flushPromises()
    expect([...select('Connection').options].map((o) => o.textContent?.trim())).toEqual(['Staging'])
    ;[...dialog().querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Add')!.click()
    await flushPromises()
    expect(store.widgets.filter((w) => w.type === 'serverStatus').map((w) => w.settings)).toEqual([
      { connectionId: C1 },
      { connectionId: C3 },
    ])
    button('Add widget').click()
    await flushPromises()
    const offered = document.querySelector('[data-gallery="serverStatus"]')!
    expect(offered.querySelector('button')).toBeNull()
    expect(offered.textContent).toContain('On every server')
    // Another kind on the same server is still offered.
    expect(document.querySelector('[data-gallery="replica"] button')).not.toBeNull()
    ;(document.querySelector('[data-gallery="replica"] button') as HTMLButtonElement).click()
    await flushPromises()
    expect([...select('Connection').options].map((o) => o.textContent?.trim())).toEqual([
      'Production',
      'Staging',
    ])
    ;[...dialog().querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Cancel')!.click()
    await flushPromises()
    // Its own server stays among a widget's choices when its settings are changed.
    ;(
      document.querySelector(`[data-widget-id="${first}"] header button[aria-haspopup]`) as HTMLButtonElement
    ).click()
    await flushPromises()
    ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((m) => m.textContent?.trim() === 'Settings')!
      .click()
    await flushPromises()
    expect([...select('Connection').options].map((o) => o.textContent?.trim())).toEqual(['Production'])
  })

  it('says a metric chart of that server, metric and range is there, and adds it only for another', async () => {
    mongoApi()
    mountApp(HomeView)
    await flushPromises()
    const store = useDashboardStore()
    store.add('metric', { connectionId: C1, metric: 'memory', range: 'live' }, 'l')
    button('Customize dashboard').click()
    await flushPromises()
    button('Add widget').click()
    await flushPromises()
    ;(document.querySelector('[data-gallery="metric"] button') as HTMLButtonElement).click()
    await flushPromises()
    const metric = select('Metric')
    metric.value = 'memory'
    metric.dispatchEvent(new Event('change'))
    await flushPromises()
    const add = () => [...dialog().querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Add')!
    expect(dialog().textContent).toContain('This server has a chart of this metric and range already')
    expect(add().disabled).toBe(true)
    const range = select('Range')
    range.value = '7d'
    range.dispatchEvent(new Event('change'))
    await flushPromises()
    expect(dialog().textContent).not.toContain('already')
    add().click()
    await flushPromises()
    expect(store.widgets.filter((w) => w.type === 'metric').map((w) => w.settings)).toEqual([
      { connectionId: C1, metric: 'memory', range: 'live' },
      { connectionId: C1, metric: 'memory', range: '7d' },
    ])
  })

  // Widgets wave 2 (2026-10-27): index health is of one database of the server.
  it('asks an index health widget’s database, leaving out those that have one', async () => {
    mockApi({
      'GET connections': () => [
        200,
        [{ ...CONN, id: C1, name: 'Production', permissions: ['server:monitor'] }],
      ],
      'GET me/dashboard': () => [200, { dashboard: SAVED }],
      'PUT me/dashboard': (body) => [200, { dashboard: body }],
      [`GET connections/${C1}/databases`]: () => [
        200,
        {
          databases: [
            { name: 'shop', sizeOnDisk: 1, empty: false },
            { name: 'logs', sizeOnDisk: 1, empty: false },
          ],
          totalSize: 2,
        },
      ],
      [`GET connections/${C1}/server/index-advice`]: () => [
        200,
        { suggestions: [], unneeded: [], skipped: 0, refused: {} },
      ],
    })
    mountApp(HomeView)
    await flushPromises()
    const store = useDashboardStore()
    store.add('indexHealth', { connectionId: C1, db: 'shop' }, 'm')
    button('Customize dashboard').click()
    await flushPromises()
    button('Add widget').click()
    await flushPromises()
    ;(document.querySelector('[data-gallery="indexHealth"] button') as HTMLButtonElement).click()
    await flushPromises()
    await flushPromises()
    expect([...select('Database').options].map((o) => o.textContent?.trim())).toEqual(['logs'])
    ;[...dialog().querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Add')!.click()
    await flushPromises()
    expect(store.widgets.filter((w) => w.type === 'indexHealth').map((w) => w.settings)).toEqual([
      { connectionId: C1, db: 'shop' },
      { connectionId: C1, db: 'logs' },
    ])
    // Every database has one now: nothing to add, and Add is off.
    button('Add widget').click()
    await flushPromises()
    ;(document.querySelector('[data-gallery="indexHealth"] button') as HTMLButtonElement).click()
    await flushPromises()
    await flushPromises()
    expect(dialog().textContent).toContain('Every database of this server has this widget already')
    const add = [...dialog().querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Add')!
    expect(add.disabled).toBe(true)
  })

  // Widgets wave 2 (2026-10-27): a data KPI is a saved pipeline of a collection, on a server where
  // the user may run aggregations.
  it('asks a data KPI’s collection and saved pipeline, on servers that allow aggregations', async () => {
    const P1 = '00000000-0000-4000-8000-0000000000a1'
    const P2 = '00000000-0000-4000-8000-0000000000a2'
    const pipeline = (id: string, name: string) => ({
      id,
      name,
      stages: [{ $count: 'n' }],
      tags: [],
      shared: false,
      mine: true,
      owner: null,
      updatedAt: '2026-10-27T10:00:00.000Z',
    })
    mockApi({
      'GET connections': () => [
        200,
        [
          { ...CONN, id: C1, name: 'Production', permissions: ['aggregation:run'] },
          { ...CONN, id: C2, name: 'Reporting', permissions: ['server:monitor'] },
        ],
      ],
      'GET me/dashboard': () => [200, { dashboard: SAVED }],
      'PUT me/dashboard': (body) => [200, { dashboard: body }],
      [`GET connections/${C1}/databases`]: () => [
        200,
        { databases: [{ name: 'shop', sizeOnDisk: 1, empty: false }], totalSize: 1 },
      ],
      [`GET connections/${C1}/databases/shop/collections`]: () => [
        200,
        [{ name: 'orders', type: 'collection' }],
      ],
      [`GET connections/${C1}/databases/shop/collections/orders/pipelines`]: () => [
        200,
        { pipelines: [pipeline(P1, 'Revenue'), pipeline(P2, 'Open orders')] },
      ],
      [`POST connections/${C1}/databases/shop/collections/orders/aggregate/run`]: () =>
        new Response(JSON.stringify({ end: { count: 0, truncated: false, bytes: 0 } }), { status: 200 }),
    })
    const { queryClient } = mountApp(HomeView)
    await flushPromises()
    // Review of wave 2 (M7): the databases already read (the sidebar did): the choice is made at once.
    queryClient.setQueryData(['connections', C1, 'databases'], {
      databases: [{ name: 'shop', sizeOnDisk: 1, empty: false }],
      totalSize: 1,
    })
    const store = useDashboardStore()
    store.add(
      'dataKpi',
      { connectionId: C1, db: 'shop', coll: 'orders', pipelineId: P1, display: 'number', refresh: 'manual' },
      'm',
    )
    button('Customize dashboard').click()
    await flushPromises()
    button('Add widget').click()
    await flushPromises()
    ;(document.querySelector('[data-gallery="dataKpi"] button') as HTMLButtonElement).click()
    for (let i = 0; i < 5; i++) await flushPromises()
    expect([...select('Connection').options].map((o) => o.textContent?.trim())).toEqual(['Production'])
    expect(select('Database').value).toBe('shop')
    expect(select('Collection').value).toBe('orders')
    // Revenue is shown as a number already: Open orders is chosen first.
    expect([...select('Saved pipeline').options].map((o) => o.textContent?.trim())).toEqual([
      'Revenue',
      'Open orders',
    ])
    expect(select('Saved pipeline').value).toBe(P2)
    const add = () => [...dialog().querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Add')!
    // Choosing Revenue as a number again is said, never quietly switched to another pipeline.
    const pick = select('Saved pipeline')
    pick.value = P1
    pick.dispatchEvent(new Event('change'))
    await flushPromises()
    expect(select('Saved pipeline').value).toBe(P1)
    expect(dialog().textContent).toContain('shown this way already')
    expect(add().disabled).toBe(true)
    const display = select('Show')
    display.value = 'bars'
    display.dispatchEvent(new Event('change'))
    await flushPromises()
    expect(dialog().textContent).not.toContain('shown this way already')
    display.value = 'number'
    display.dispatchEvent(new Event('change'))
    pick.value = P2
    pick.dispatchEvent(new Event('change'))
    await flushPromises()
    const refresh = select('Run again')
    expect(refresh.value).toBe('manual')
    refresh.value = '15m'
    refresh.dispatchEvent(new Event('change'))
    await flushPromises()
    ;[...dialog().querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Add')!.click()
    await flushPromises()
    expect(store.widgets.filter((w) => w.type === 'dataKpi').at(-1)!.settings).toEqual({
      connectionId: C1,
      db: 'shop',
      coll: 'orders',
      pipelineId: P2,
      display: 'number',
      refresh: '15m',
    })
  })

  it('says when no connection lets the user watch its server, and adds nothing', async () => {
    mockApi({
      'GET connections': () => [
        200,
        [{ ...CONN, id: C2, name: 'Reporting', permissions: ['documents:read'] }],
      ],
      'GET me/dashboard': () => [200, { dashboard: SAVED }],
    })
    mountApp(HomeView)
    await flushPromises()
    button('Customize dashboard').click()
    await flushPromises()
    button('Add widget').click()
    await flushPromises()
    ;(document.querySelector('[data-gallery="serverStatus"] button') as HTMLButtonElement).click()
    await flushPromises()
    expect(dialog().textContent).toContain('No connection lets you watch its server')
    const add = [...dialog().querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Add')!
    expect(add.disabled).toBe(true)
  })
})
