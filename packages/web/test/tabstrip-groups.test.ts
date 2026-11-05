// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import TabStrip from '../src/workspace/TabStrip.vue'
import { useTabsStore } from '../src/stores/tabs'
import { useCollectionViewsStore } from '../src/stores/collectionViews'
import { useDialogStore } from '../src/stores/dialogs'
import { useToastStore } from '../src/stores/toasts'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'

/**
 * User request 2026-10-12: the collection tabs of a database are gathered into one tab of the
 * database while the user is elsewhere, and shown again when they come back.
 */
beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
  mockApi({
    'GET connections': () => [
      200,
      [
        { id: 'c1', name: 'Local', permissions: [] },
        { id: 'c2', name: 'Staging', permissions: [] },
      ],
    ],
  })
})

const collection = (db: string, coll: string, connectionId = 'c1') => ({
  kind: 'collection',
  title: `${db}.${coll}`,
  params: { connectionId, db, coll },
})

/** shop's users, orders and products open, then analytics.events: the user left shop. */
function scenario() {
  const tabs = useTabsStore()
  tabs.bindUser('local')
  const users = tabs.open(collection('shop', 'users'))
  const orders = tabs.open(collection('shop', 'orders'))
  const products = tabs.open(collection('shop', 'products'))
  const events = tabs.open(collection('analytics', 'events'))
  return { tabs, users, orders, products, events }
}
type Found = { attributes: (n: string) => string | undefined; text: () => string }
const labels = (root: { findAll: (s: string) => Found[] }) =>
  root.findAll('[role="tab"]').map((tab) => (tab.attributes('data-group') ? `[${tab.text()}]` : tab.text()))
const SHOP = JSON.stringify(['c1', 'shop'])
/** The database's own tab, which a group opens on (user request 2026-10-13). */
const DB = 'database:connectionId=c1&db=shop'

afterEach(() => {
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('the tab strip’s database groups', () => {
  it('gathers a database’s tabs into one named with the database and its tabs, where they were', async () => {
    const { users } = scenario()
    const { wrapper } = mountApp(TabStrip)
    await flushPromises()
    expect(labels(wrapper)).toEqual(['[shop3]', 'events'])
    const group = wrapper.get('[data-group]')
    expect(group.attributes('aria-label')).toBe('shop on Local, 3 tabs')
    expect(group.attributes('aria-description')).toBe(
      'Collapsed group: users, orders, products. Enter opens the database and shows its tabs; Delete closes them.',
    )
    expect(group.attributes('aria-expanded')).toBe('false')
    // Its names show in a tooltip of the app's own, not the browser's (user request 2026-10-13).
    expect(group.attributes('title')).toBeUndefined()
    expect(group.attributes('aria-selected')).toBe('false')
    expect(wrapper.find(`[data-id="${users}"]`).exists()).toBe(false)
  })

  // User request 2026-10-13: "shop içerisinde gruplandı tıkladığımda shop açılsın".
  it('shows them again when the group is clicked, on the database itself, active and focused', async () => {
    const { tabs, orders } = scenario()
    tabs.activate(orders)
    tabs.activate(tabs.tabs.at(-1)!.id)
    const { wrapper } = mountApp(TabStrip)
    await flushPromises()
    const chip = wrapper.get('[data-group]')
    ;(chip.element as HTMLElement).focus()
    await chip.trigger('click')
    await flushPromises()
    expect(tabs.activeId).toBe(DB)
    expect(labels(wrapper)).toEqual(['shop', 'users', 'orders', 'products', 'events'])
    // The chip that held the focus is gone: the tab shown has it (review I5).
    expect(document.activeElement?.getAttribute('data-id')).toBe(DB)
  })

  // User request 2026-10-13: "tooltip ekle üzerine geldiğim zaman gruptaki tabların isimlerini görebileyim".
  it('names the group’s tabs in a tooltip on hover and on focus, gone when left or clicked', async () => {
    const { tabs } = scenario()
    tabs.open({ kind: 'database', title: 'shop', params: { connectionId: 'c1', db: 'shop' } })
    tabs.activate(tabs.tabs.find((t) => t.params.db === 'analytics')!.id)
    const { wrapper } = mountApp(TabStrip)
    await flushPromises()
    vi.useFakeTimers()
    const chip = wrapper.get('[data-group]')
    const tip = () => document.querySelector<HTMLElement>('[data-group-tooltip]')
    await chip.trigger('mouseenter')
    vi.advanceTimersByTime(399)
    await flushPromises()
    expect(tip()).toBeNull()
    vi.advanceTimersByTime(1)
    await flushPromises()
    expect(tip()!.getAttribute('role')).toBe('tooltip')
    expect(tip()!.getAttribute('aria-hidden')).toBe('true')
    expect(tip()!.querySelector('p')!.textContent).toBe('Local · shop: 4 tabs')
    expect([...tip()!.querySelectorAll('li')].map((li) => li.textContent!.trim())).toEqual([
      'users',
      'orders',
      'products',
      'Database page',
    ])
    await chip.trigger('mouseleave')
    expect(tip()).toBeNull()
    await chip.trigger('focus')
    vi.advanceTimersByTime(150)
    await flushPromises()
    expect(tip()).not.toBeNull()
    await chip.trigger('keydown', { key: 'Escape' })
    expect(tip()).toBeNull()
    await chip.trigger('mouseenter')
    vi.advanceTimersByTime(400)
    await flushPromises()
    await chip.trigger('click')
    await flushPromises()
    expect(tip()).toBeNull()
  })

  // Review 2026-10-13 (I1, M1): the chip focused by a click (or its group opened from the keyboard)
  // brought the tooltip back, over nothing, once the group gathered again; a drag showed it too.
  it('never brings the tooltip back once its group opened, and hides it for a drag', async () => {
    const { tabs, events } = scenario()
    const { wrapper } = mountApp(TabStrip)
    await flushPromises()
    vi.useFakeTimers()
    const tip = () => document.querySelector('[data-group-tooltip]')
    const leave = async () => {
      tabs.activate(events)
      vi.advanceTimersByTime(1000)
      await flushPromises()
    }
    // A click: the pointer down focuses the chip, which never shows the tooltip.
    let chip = wrapper.get('[data-group]')
    await chip.trigger('pointerdown')
    await chip.trigger('focus')
    await chip.trigger('click')
    vi.advanceTimersByTime(1000)
    await flushPromises()
    await leave()
    expect(tip()).toBeNull()
    // The keyboard: shown on focus, gone once Enter opened the group, and not back after.
    chip = wrapper.get('[data-group]')
    await chip.trigger('focus')
    vi.advanceTimersByTime(150)
    await flushPromises()
    expect(tip()).not.toBeNull()
    await chip.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(tip()).toBeNull()
    await leave()
    expect(tip()).toBeNull()
    // A timer still running when its chip went: nothing shown.
    chip = wrapper.get('[data-group]')
    await chip.trigger('mouseenter')
    tabs.openGroup(SHOP)
    await flushPromises()
    await leave()
    expect(tip()).toBeNull()
    // A drag hides it.
    chip = wrapper.get('[data-group]')
    await chip.trigger('mouseenter')
    vi.advanceTimersByTime(400)
    await flushPromises()
    expect(tip()).not.toBeNull()
    await wrapper.get('[data-tab-group]').trigger('dragstart')
    expect(tip()).toBeNull()
  })

  it('never shows the tooltip for a chip the pointer focused, nor again once its group comes back', async () => {
    const { tabs } = scenario()
    const { wrapper } = mountApp(TabStrip)
    await flushPromises()
    vi.useFakeTimers()
    const tip = () => document.querySelector('[data-group-tooltip]')
    const chip = wrapper.get('[data-group]')
    await chip.trigger('pointerdown')
    await chip.trigger('focus')
    vi.advanceTimersByTime(1000)
    await flushPromises()
    expect(tip()).toBeNull()
    await chip.trigger('pointerup')
    await chip.trigger('blur')
    // Shown, then its group closed and brought back with Undo: not shown again.
    await chip.trigger('mouseenter')
    vi.advanceTimersByTime(400)
    await flushPromises()
    expect(tip()).not.toBeNull()
    await wrapper.get('[data-group-close]').trigger('click')
    await flushPromises()
    const undo = useToastStore().toasts.at(-1)!
    useToastStore().runAction(undo.id, 0)
    await flushPromises()
    expect(wrapper.find('[data-group]').exists()).toBe(true)
    expect(tip()).toBeNull()
    expect(tabs.tabs).toHaveLength(4)
  })

  it('names at most twelve tabs in the tooltip, and how many more', async () => {
    const tabs = useTabsStore()
    tabs.bindUser('local')
    for (let i = 1; i <= 15; i++) tabs.open(collection('shop', `c${i}`))
    tabs.open(collection('analytics', 'events'))
    const { wrapper } = mountApp(TabStrip)
    await flushPromises()
    vi.useFakeTimers()
    await wrapper.get('[data-group]').trigger('mouseenter')
    vi.advanceTimersByTime(400)
    await flushPromises()
    const items = [...document.querySelectorAll('[data-group-tooltip] li')].map((li) =>
      li.textContent!.trim(),
    )
    expect(items).toHaveLength(13)
    expect(items.at(-1)).toBe('+3 more')
    // A screen reader is told as many (review 2026-10-13, M7).
    expect(wrapper.get('[data-group]').attributes('aria-description')).toBe(
      'Collapsed group: c1, c2, c3, c4, c5, c6, c7, c8, c9, c10, c11, c12, +3 more. Enter opens the database and shows its tabs; Delete closes them.',
    )
  })

  it('shows them again when one of its collections is opened from anywhere, and gathers them when the user leaves', async () => {
    const { tabs, products, events } = scenario()
    const { wrapper } = mountApp(TabStrip)
    tabs.open(collection('shop', 'products'))
    await flushPromises()
    expect(tabs.activeId).toBe(products)
    expect(labels(wrapper)).toEqual(['users', 'orders', 'products', 'events'])
    tabs.activate(events)
    await flushPromises()
    expect(labels(wrapper)).toEqual(['[shop3]', 'events'])
    expect(wrapper.get('[data-tab-announce]').text()).toBe('The tabs of shop collapsed into one.')
    tabs.open(collection('shop', 'users'))
    await flushPromises()
    expect(wrapper.get('[data-tab-announce]').text()).toBe('The tabs of shop shown.')
  })

  it('closes every tab of the group with its close button, and puts them back with Undo, as they were', async () => {
    const { tabs, users, orders, products, events } = scenario()
    const views = useCollectionViewsStore()
    views.stateFor(orders).page = 4
    const { wrapper } = mountApp(TabStrip)
    await wrapper.get('[data-group-close]').trigger('click')
    await flushPromises()
    expect(tabs.tabs.map((t) => t.id)).toEqual([events])
    expect(wrapper.find('[data-group]').exists()).toBe(false)
    // The workspace forgets what closed tabs showed, as it does once they are gone.
    views.prune(new Set(tabs.tabs.map((t) => t.id)))
    expect(views.states[orders]).toBeUndefined()
    const toasts = useToastStore()
    const toast = toasts.toasts.at(-1)!
    expect(toast.message).toBe('3 tabs of shop closed.')
    toasts.runAction(toast.id, 0)
    await flushPromises()
    expect(tabs.tabs.map((t) => t.id)).toEqual([users, orders, products, events])
    expect(views.stateFor(orders).page).toBe(4)
  })

  it('closes them on a middle click too', async () => {
    const { tabs, events } = scenario()
    const { wrapper } = mountApp(TabStrip)
    await wrapper.get('[data-tab-group]').trigger('auxclick', { button: 1 })
    await flushPromises()
    expect(tabs.tabs.map((t) => t.id)).toEqual([events])
  })

  it('asks once before closing a group when one of its tabs holds unsaved edits', async () => {
    const { tabs, orders, events } = scenario()
    const views = useCollectionViewsStore()
    views.stateFor(orders).inspector.draft = {
      key: 'd1',
      text: '{ "changed": true }',
      initial: '{}',
      hash: 'h',
      base: {},
      dropped: [],
    }
    const { wrapper } = mountApp(TabStrip)
    await wrapper.get('[data-group-close]').trigger('click')
    await flushPromises()
    const dialogs = useDialogStore()
    expect(dialogs.current?.title).toBe('Close 3 tabs?')
    dialogs.settle(false)
    await flushPromises()
    expect(tabs.tabs).toHaveLength(4)
    await wrapper.get('[data-group-close]').trigger('click')
    await flushPromises()
    dialogs.settle(true)
    await flushPromises()
    expect(tabs.tabs.map((t) => t.id)).toEqual([events])
  })

  // I3: the arrows opened every group they passed, and a group could not be closed by keyboard.
  it('stops on a group with the arrows without opening it; Enter opens it, Delete closes it', async () => {
    const { tabs, events } = scenario()
    const { wrapper } = mountApp(TabStrip)
    await flushPromises()
    await wrapper.get(`[data-id="${events}"]`).trigger('keydown', { key: 'ArrowLeft' })
    await flushPromises()
    expect(tabs.activeId).toBe(events)
    expect(document.activeElement?.getAttribute('data-group')).toBe(SHOP)
    await wrapper.get('[data-group]').trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(tabs.activeId).toBe(DB)
    expect(document.activeElement?.getAttribute('data-id')).toBe(DB)
    tabs.activate(events)
    await flushPromises()
    ;(wrapper.get('[data-group]').element as HTMLElement).focus()
    await wrapper.get('[data-group]').trigger('keydown', { key: 'Delete' })
    await flushPromises()
    expect(tabs.tabs.map((t) => t.id)).toEqual([events])
    expect(document.activeElement?.getAttribute('data-id')).toBe(events)
  })

  // Found by e2e 2026-10-13: a key pressed before the strip redrew (just after a click gathered a group)
  // moved from where the tab had been, not where it is: the arrow stayed on it, Delete closed it.
  it('moves from where a tab is now, for a key pressed before the strip redrew', async () => {
    // users, orders, products, shop's own tab, events: the strip drew five; gathered, it shows two.
    const tabs = useTabsStore()
    tabs.bindUser('local')
    tabs.open(collection('shop', 'users'))
    tabs.open(collection('shop', 'orders'))
    const products = tabs.open(collection('shop', 'products'))
    tabs.open({ kind: 'database', title: 'shop', params: { connectionId: 'c1', db: 'shop' } })
    const events = tabs.open(collection('analytics', 'events'))
    tabs.activate(products)
    const { wrapper } = mountApp(TabStrip)
    await flushPromises()
    const tab = wrapper.get(`[data-id="${events}"]`).element as HTMLElement
    tabs.activate(events)
    tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    await flushPromises()
    expect(document.activeElement?.getAttribute('data-group')).toBe(SHOP)
    expect(tabs.activeId).toBe(events)
  })

  // I5: a tab holding the focus, gathered (the user went elsewhere), took the focus off the page.
  it('gives the focus to the tab shown when the focused tab is gathered away', async () => {
    const { tabs, products, events } = scenario()
    tabs.activate(products)
    const { wrapper } = mountApp(TabStrip)
    await flushPromises()
    ;(wrapper.get(`[data-id="${products}"]`).element as HTMLElement).focus()
    tabs.activate(events)
    await flushPromises()
    expect(wrapper.find(`[data-id="${products}"]`).exists()).toBe(false)
    expect(document.activeElement?.getAttribute('data-id')).toBe(events)
  })

  // User report 2026-10-13: the page cross-faded as the strip opened, as if it reloaded. A group opens
  // at once, never through a view transition; the tab shown has the focus.
  it('opens a group at once, without a view transition, the tab shown focused', async () => {
    scenario()
    const runs: Array<() => Promise<void> | void> = []
    ;(document as { startViewTransition?: unknown }).startViewTransition = (
      cb: () => Promise<void> | void,
    ) => {
      runs.push(cb)
    }
    try {
      const { wrapper } = mountApp(TabStrip)
      await flushPromises()
      const chip = wrapper.get('[data-group]')
      ;(chip.element as HTMLElement).focus()
      await chip.trigger('keydown', { key: 'Enter' })
      await flushPromises()
      expect(runs).toEqual([])
      expect(document.activeElement?.getAttribute('data-id')).toBe(DB)
      // A tab clicked is shown at once too: a key pressed right after went to the strip as it was
      // (found by e2e 2026-10-13), and the fade to a page not loaded yet looked like a reload.
      const tabs = useTabsStore()
      const users = tabs.tabs.find((t) => t.params.coll === 'users')!.id
      wrapper.get(`[data-id="${users}"]`).element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      expect(tabs.activeId).toBe(users)
      expect(runs).toEqual([])
    } finally {
      delete (document as { startViewTransition?: unknown }).startViewTransition
    }
  })

  // I7: a group refused drops, and could not be dragged.
  it('takes a tab dropped on a group before it, and moves a dragged group as one', async () => {
    const { tabs, users, orders, products, events } = scenario()
    const jobs = tabs.open({ kind: 'jobs', title: 'Jobs' })
    tabs.activate(events)
    const { wrapper } = mountApp(TabStrip)
    await flushPromises()
    await wrapper.get(`[data-id="${jobs}"]`).element.parentElement!.dispatchEvent(new Event('dragstart'))
    await wrapper.get('[data-tab-group]').trigger('drop')
    expect(tabs.tabs.map((t) => t.id)).toEqual([jobs, users, orders, products, events])
    await wrapper.get('[data-tab-group]').trigger('dragstart')
    wrapper.get(`[data-id="${jobs}"]`).element.parentElement!.dispatchEvent(new Event('drop'))
    await flushPromises()
    expect(tabs.tabs.map((t) => t.id)).toEqual([users, orders, products, jobs, events])
  })

  // I6: two connections with a database of the same name showed two chips alike.
  it('names the connection on groups of databases of the same name', async () => {
    const tabs = useTabsStore()
    tabs.bindUser('local')
    tabs.open(collection('app', 'a'))
    tabs.open(collection('app', 'b'))
    tabs.open(collection('app', 'a', 'c2'))
    tabs.open(collection('app', 'b', 'c2'))
    tabs.open({ kind: 'jobs', title: 'Jobs' })
    const { wrapper } = mountApp(TabStrip)
    await flushPromises()
    expect(labels(wrapper)).toEqual(['[Local / app2]', '[Staging / app2]', 'Background jobs'])
  })

  // I4: on a touch screen the hidden close button still took a tap.
  it('shows a close button on hover, focus or a touch screen, taking no tap while hidden', async () => {
    scenario()
    const { wrapper } = mountApp(TabStrip)
    await flushPromises()
    for (const button of [
      wrapper.get('[data-group-close]'),
      wrapper.findAll('[role="presentation"] button')[0]!,
    ]) {
      expect(button.classes()).toEqual(
        expect.arrayContaining([
          'pointer-events-none',
          'opacity-0',
          'group-hover:opacity-100',
          'group-focus-within:opacity-100',
          '[@media(hover:none)]:opacity-100',
          '[@media(hover:none)]:pointer-events-auto',
        ]),
      )
    }
  })

  it('never gathers a database with one collection tab open', async () => {
    const tabs = useTabsStore()
    tabs.bindUser('local')
    tabs.open(collection('shop', 'users'))
    tabs.open(collection('analytics', 'events'))
    const { wrapper } = mountApp(TabStrip)
    await flushPromises()
    expect(wrapper.find('[data-group]').exists()).toBe(false)
    expect(labels(wrapper)).toEqual(['users', 'events'])
  })
})
