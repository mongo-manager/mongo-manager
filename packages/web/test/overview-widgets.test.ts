// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { Widget } from '@mongo-manager/shared'
import WidgetSlot from '../src/workspace/overview/widgets/WidgetSlot.vue'
import { WIDGETS } from '../src/workspace/overview/widgets/registry'
import { useDashboardStore } from '../src/stores/dashboard'
import { useSessionStore } from '../src/stores/session'
import { usePlacesStore } from '../src/stores/places'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'
import { useToastStore } from '../src/stores/toasts'
import { defineComponent, h } from 'vue'
import DsCard from '../src/ds/DsCard.vue'

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
  usePlacesStore().bindUser('u1')
  mockApi({ 'GET connections': () => [200, []], 'GET jobs': () => [200, { jobs: [] }] })
})
afterEach(() => {
  // A save still waiting would reach the next test's mocked server.
  useDashboardStore().reset()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const quick: Widget = { id: '00000000-0000-4000-8000-0000000000a1', type: 'quick', size: 'm', settings: {} }
const activity: Widget = {
  id: '00000000-0000-4000-8000-0000000000a2',
  type: 'activity',
  size: 'm',
  settings: {},
}
function slot(widget: Widget, editing: boolean) {
  const store = useDashboardStore()
  store.widgets = [widget, activity]
  store.status = 'ready'
  const r = mountApp(WidgetSlot, { props: { widget, position: 0, count: 2, editing } })
  return { store, ...r }
}
const menuItems = () => [
  ...document.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"]'),
]
async function openMenu(): Promise<void> {
  document.querySelector<HTMLButtonElement>('[data-widget] header button[aria-haspopup]')!.click()
  await flushPromises()
}

/** A card with a menu, as the widgets have. */
const DsCardProbe = defineComponent({
  setup: () => () =>
    h(DsCard, { title: 'Probe', menuLabel: 'Probe options', items: [{ id: 'a', label: 'A' }] }, () => 'body'),
})

describe('Overview widgets (user review 2026-10-09)', () => {
  it('has every workspace module in the registry, each with a title, a description and a size', () => {
    for (const type of [
      'continue',
      'pinned',
      'attention',
      'connections',
      'queries',
      'activity',
      'quick',
    ] as const) {
      const def = WIDGETS[type]!
      expect(def.group).toBe('workspace')
      expect(i18n.global.te(def.title)).toBe(true)
      expect(i18n.global.te(def.description)).toBe(true)
      expect(['s', 'm', 'l', 'xl']).toContain(def.size)
    }
  })

  it('shows a module as a widget, with no editing controls outside edit mode', async () => {
    slot(quick, false)
    await flushPromises()
    const frame = document.querySelector('[data-widget="quick"]')!
    expect(frame.querySelector('h2')!.textContent).toBe('Quick access')
    expect(frame.querySelector('[data-widget-handle]')).toBeNull()
  })

  it('collapses and removes from its menu', async () => {
    const { store } = slot(quick, false)
    await flushPromises()
    await openMenu()
    menuItems()
      .find((m) => m.textContent?.includes('Collapse'))!
      .click()
    await flushPromises()
    expect(store.widgets[0]!.collapsed).toBe(true)
    await openMenu()
    menuItems()
      .find((m) => m.textContent?.includes('Remove'))!
      .click()
    await flushPromises()
    expect(store.widgets.map((w) => w.type)).toEqual(['activity'])
  })

  it('offers Undo when a widget is removed, putting it back where it was', async () => {
    const { store } = slot(quick, false)
    await flushPromises()
    await openMenu()
    menuItems()
      .find((m) => m.textContent?.includes('Remove'))!
      .click()
    await flushPromises()
    const toast = useToastStore().toasts.at(-1)!
    expect(toast.message).toContain('Quick access')
    toast.actions!.find((a) => a.label === 'Undo')!.run()
    expect(store.widgets.map((w) => w.type)).toEqual(['quick', 'activity'])
    // Never twice, and never past the limit.
    toast.actions![0]!.run()
    expect(store.widgets).toHaveLength(2)
  })

  it('in edit mode offers a handle, its sizes and moves', async () => {
    const { store } = slot(quick, true)
    await flushPromises()
    const frame = document.querySelector('[data-widget="quick"]')!
    expect(frame.querySelector('[data-widget-handle]')!.getAttribute('aria-label')).toBe('Move Quick access')
    await openMenu()
    const labels = menuItems().map((m) => m.textContent?.trim())
    expect(labels).toEqual(
      expect.arrayContaining(['Narrow', 'Medium', 'Wide', 'Full width', 'Move down', 'Remove']),
    )
    expect(labels).not.toContain('Move up')
    menuItems()
      .find((m) => m.textContent?.trim() === 'Full width')!
      .click()
    await flushPromises()
    expect(store.widgets[0]!.size).toBe('xl')
    await openMenu()
    menuItems()
      .find((m) => m.textContent?.trim() === 'Move down')!
      .click()
    await flushPromises()
    expect(store.widgets.map((w) => w.type)).toEqual(['activity', 'quick'])
  })

  it('gives touch screens 44 px targets and actions always shown (final review 5)', async () => {
    mockApi({
      'GET connections': () => [200, []],
      'GET me/dashboard': () => [200, { dashboard: null }],
    })
    const { wrapper } = mountApp(DsCardProbe)
    await flushPromises()
    const trigger = wrapper.get('button[aria-haspopup="menu"]')
    expect(trigger.classes()).toContain('pointer-coarse:size-11')
    expect(trigger.element.parentElement!.className).toContain('[@media(hover:none)]:opacity-100')
  })
})
