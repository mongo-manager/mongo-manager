// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory } from 'vue-router'
import { createAppRouter } from '../src/router'
import WorkspaceView from '../src/views/WorkspaceView.vue'
import TabStrip from '../src/workspace/TabStrip.vue'
import { i18n } from '../src/i18n'
import { useTabsStore } from '../src/stores/tabs'
import { useSessionStore } from '../src/stores/session'
import { mockApi, mountApp } from './support/app'

const ME = {
  mode: 'local',
  user: { id: 'local', username: 'owner', role: 'admin' },
  permissions: ['connections:manage', 'audit:read', 'settings:manage'],
  csrfToken: 'c',
  readOnly: false,
  twoFactor: {},
}
const CONN = {
  id: 'c1',
  name: 'Production',
  group: null,
  color: 'green',
  favorite: false,
  readOnly: true,
  access: 'admin',
  permissions: [],
  restricted: true,
}
function api() {
  return mockApi({
    'GET auth/status': () => [200, { mode: 'local', setupRequired: false, authenticated: true }],
    'GET auth/me': () => [200, ME],
    'GET connections': () => [200, [CONN]],
    'GET connections/c1/databases': () => [
      200,
      { databases: [{ name: 'shop', sizeOnDisk: 1, empty: false }], totalSize: 1 },
    ],
    'GET connections/c1/databases/shop/collections': () => [
      200,
      [
        { name: 'orders', type: 'collection', options: {}, readOnly: false },
        { name: 'users', type: 'collection', options: {}, readOnly: false },
      ],
    ],
  })
}
async function mountWorkspace() {
  const session = useSessionStore()
  session.me = ME as never
  session.status = { mode: 'local', setupRequired: false, authenticated: true }
  const router = createAppRouter(createMemoryHistory())
  await router.push('/')
  const mounted = mountApp(WorkspaceView, { plugins: [router] })
  await flushPromises()
  return mounted
}
const press = (key: string, init: KeyboardEventInit = {}) =>
  window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }))

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  i18n.global.locale.value = 'en'
  // The tab strip names connections: answered here, never the network (a test's own api() replaces it).
  mockApi({ 'GET connections': () => [200, []] })
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: false,
    media: q,
    addEventListener() {},
    removeEventListener() {},
  }))
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('tabs.move', () => {
  it('reorders tabs and keeps them stored', () => {
    const tabs = useTabsStore()
    const a = tabs.open({ kind: 'account', title: '' })
    const b = tabs.open({ kind: 'audit', title: '' })
    const c = tabs.open({ kind: 'users', title: '' })
    tabs.move(c, 0)
    expect(tabs.tabs.map((t) => t.id)).toEqual([c, a, b])
    tabs.move(c, 99)
    expect(tabs.tabs.map((t) => t.id)).toEqual([a, b, c])
    tabs.move('nope', 0)
    expect(JSON.parse(localStorage.getItem('mm:tabs')!).tabs.map((t: { id: string }) => t.id)).toEqual([
      a,
      b,
      c,
    ])
  })
})

describe('the shell', () => {
  it('lays out sidebar, connections, context bar, tabs and content in keyboard order', async () => {
    api()
    const { wrapper } = await mountWorkspace()
    const order = [...document.querySelectorAll('[data-region]')].map(
      (el) => (el as HTMLElement).dataset.region,
    )
    // Checkpoint 1 feedback: with only Home open there is no tab strip.
    expect(order).toEqual(['sidebar', 'connections', 'topbar', 'main'])
    expect(wrapper.get('[data-region="sidebar"]').attributes('aria-label')).toBe('Application')
    expect(
      wrapper
        .get('[data-region="sidebar"]')
        .findAll('button')
        .some((b) => b.text() === 'Queries'),
    ).toBe(true)
    expect(wrapper.find('button[aria-label^="Account menu"]').exists()).toBe(true)
    expect(wrapper.get('[data-region="topbar"]').text()).toContain('Local mode')
    expect(wrapper.find('button[aria-label="Preferences"]').exists()).toBe(true)
    // One theme switch, in the rail: light or dark, nothing else (checkpoint 1 feedback).
    const toDark = wrapper.get('[data-region="sidebar"]').get('button[aria-label="Switch to dark theme"]')
    await toDark.trigger('click')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(
      wrapper.get('[data-region="sidebar"]').find('button[aria-label="Switch to light theme"]').exists(),
    ).toBe(true)
    // The navigator says how many connections there are.
    expect(wrapper.get('[data-region="connections"] h2').text()).toContain('1')
  })

  it('shows where the user is and switches collection from the breadcrumbs', async () => {
    api()
    const tabs = useTabsStore()
    tabs.bindUser('local')
    tabs.open({
      kind: 'collection',
      title: 'shop.orders',
      params: { connectionId: 'c1', db: 'shop', coll: 'orders' },
    })
    const { wrapper } = await mountWorkspace()
    const crumbs = wrapper.get('nav[aria-label="Location"]')
    expect(crumbs.text()).toContain('Production')
    expect(crumbs.text()).toContain('shop')
    expect(crumbs.text()).toContain('orders')
    ;(crumbs.get('button[aria-label="Switch collection"]').element as HTMLButtonElement).click()
    await flushPromises()
    const users = [...document.querySelectorAll('[role="option"]')].find((o) =>
      o.textContent?.includes('users'),
    )!
    ;(users as HTMLElement).click()
    await flushPromises()
    expect(tabs.active?.params).toEqual({ connectionId: 'c1', db: 'shop', coll: 'users' })
    const status = wrapper.get('[data-region="topbar"]').text()
    expect(status).toContain('Read-only')
    expect(status).toContain('Personal data hidden')
    expect(wrapper.find('[data-region="tabs"]').exists()).toBe(true)
  })

  it('hides and shows the navigator with Mod+B and reorders tabs with Mod+Shift+arrows', async () => {
    api()
    const tabs = useTabsStore()
    tabs.bindUser('local')
    const a = tabs.open({ kind: 'account', title: '' })
    const b = tabs.open({ kind: 'audit', title: '' })
    const { wrapper } = await mountWorkspace()
    press('b', { ctrlKey: true })
    await flushPromises()
    expect(wrapper.find('[data-region="connections"]').exists()).toBe(false)
    press('b', { ctrlKey: true })
    await flushPromises()
    expect(wrapper.find('[data-region="connections"]').exists()).toBe(true)
    press('ArrowLeft', { ctrlKey: true, shiftKey: true })
    expect(tabs.tabs.map((t) => t.id)).toEqual([b, a])
  })

  // Tab groups review 2026-10-12 (I1): the active tab moved into a gathered group, unseen.
  it('moves the active tab past a gathered group as one with Mod+Shift+arrows', async () => {
    api()
    const tabs = useTabsStore()
    tabs.bindUser('local')
    const coll = (name: string) =>
      tabs.open({
        kind: 'collection',
        title: `shop.${name}`,
        params: { connectionId: 'c1', db: 'shop', coll: name },
      })
    const users = coll('users')
    const orders = coll('orders')
    const audit = tabs.open({ kind: 'audit', title: '' })
    await mountWorkspace()
    press('ArrowLeft', { ctrlKey: true, shiftKey: true })
    expect(tabs.tabs.map((t) => t.id)).toEqual([audit, users, orders])
  })

  it('pins the active tab with Mod+Shift+P and enters and leaves focus mode with Mod+Shift+F (spec rev. 2 §3.6)', async () => {
    api()
    const tabs = useTabsStore()
    tabs.bindUser('local')
    tabs.open({
      kind: 'collection',
      title: 'shop.orders',
      params: { connectionId: 'c1', db: 'shop', coll: 'orders' },
    })
    const { wrapper } = await mountWorkspace()
    press('P', { ctrlKey: true, shiftKey: true })
    expect(JSON.parse(localStorage.getItem('mm:pins:local')!).map((p: { key: string }) => p.key)).toEqual([
      'collection:c1/shop/orders',
    ])
    expect(JSON.parse(localStorage.getItem('mm:recent:local')!)[0].key).toBe('collection:c1/shop/orders')
    press('F', { ctrlKey: true, shiftKey: true })
    await flushPromises()
    expect(wrapper.find('[data-region="connections"]').exists()).toBe(false)
    press('F', { ctrlKey: true, shiftKey: true })
    await flushPromises()
    expect(wrapper.find('[data-region="connections"]').exists()).toBe(true)
  })

  it('turns the navigator into an overlay below 1024 px', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: true,
      media: q,
      addEventListener() {},
      removeEventListener() {},
    }))
    api()
    const { wrapper } = await mountWorkspace()
    expect(wrapper.find('[data-region="sidebar"]').exists()).toBe(false)
    press('b', { ctrlKey: true })
    await flushPromises()
    const nav = wrapper.get('[data-region="sidebar"]')
    expect(nav.classes()).toContain('fixed')
    await nav.trigger('keydown', { key: 'Escape' })
    expect(wrapper.find('[data-region="sidebar"]').exists()).toBe(false)
  })
})

describe('TabStrip', () => {
  it('moves with the arrows, closes with Delete or a middle click, and lists every tab in its overflow menu', async () => {
    const tabs = useTabsStore()
    const ids = Array.from({ length: 30 }, (_, i) =>
      tabs.open({
        kind: 'collection',
        title: `db.${'very_long_collection_name_'.repeat(4)}${i}`,
        params: { connectionId: 'c1', db: 'db', coll: `c${i}` },
      }),
    )
    tabs.activate(ids[0]!)
    const { wrapper } = mountApp(TabStrip)
    const strip = wrapper.get('[role="tablist"]')
    expect(strip.classes()).toContain('overflow-x-auto')
    const first = wrapper.findAll('[role="tab"]')[0]!
    expect(first.attributes('tabindex')).toBe('0')
    expect(wrapper.findAll('[role="tab"]')[1]!.attributes('tabindex')).toBe('-1')
    expect(first.get('[data-title]').classes()).toContain('truncate')
    // No control inside a tab; a collection tab's name carries its database.
    expect(strip.findAll('[role="tab"] button')).toHaveLength(0)
    expect(first.attributes('aria-label')).toBe(`db.${'very_long_collection_name_'.repeat(4)}0`)
    await first.trigger('keydown', { key: 'ArrowRight' })
    expect(tabs.activeId).toBe(ids[1])
    await wrapper.findAll('[role="tab"]')[1]!.trigger('keydown', { key: 'Delete' })
    expect(tabs.tabs).toHaveLength(29)
    // User report 2026-10-12: with many tabs the middle button scrolled the strip instead of closing.
    // Its press never starts the browser's autoscroll, on a tab or anywhere on the strip.
    for (const target of [wrapper.findAll('[role="tab"]')[0]!.element, strip.element]) {
      const press = new MouseEvent('mousedown', { button: 1, bubbles: true, cancelable: true })
      target.dispatchEvent(press)
      expect(press.defaultPrevented).toBe(true)
    }
    // The left button still works as it does (dragging, focus).
    const left = new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true })
    wrapper.findAll('[role="tab"]')[0]!.element.dispatchEvent(left)
    expect(left.defaultPrevented).toBe(false)
    await wrapper.findAll('[role="tab"]')[0]!.trigger('auxclick', { button: 1 })
    expect(tabs.tabs).toHaveLength(28)
    ;(wrapper.get('button[aria-label="All tabs"]').element as HTMLButtonElement).click()
    await flushPromises()
    const items = document.querySelectorAll('[role="menu"] [role="menuitem"]')
    expect(items).toHaveLength(28)
    ;(items[27] as HTMLElement).click()
    expect(tabs.activeId).toBe(ids[29])
  })
})

describe('the shell has no hard-coded light colors', () => {
  const FILES = [
    'views/WorkspaceView.vue',
    'workspace/AppSidebar.vue',
    'workspace/sidebar/SidebarItem.vue',
    'workspace/sidebar/SidebarGroup.vue',
    'workspace/sidebar/ConnectionsSection.vue',
    'workspace/sidebar/PinnedSection.vue',
    'workspace/sidebar/PreferencesPanel.vue',
    'workspace/ProductMark.vue',
    'workspace/ContextBar.vue',
    'workspace/Breadcrumbs.vue',
    'workspace/TabStrip.vue',
    'workspace/tree/TreeRow.vue',
    'workspace/tree/TreeStatus.vue',
    'workspace/tree/ConnectionTree.vue',
    'workspace/tree/TreeConnection.vue',
    'workspace/tree/TreeDatabase.vue',
    'jobs/JobsTray.vue',
    'workspace/HomeView.vue',
    'workspace/AccountMenu.vue',
    'workspace/CommandPalette.vue',
    'workspace/ShortcutSheet.vue',
  ]
  const LEGACY =
    /\b(?:bg|text|border|ring|fill|stroke|outline|divide|from|to|via)-(?:gray|white|black|brand|slate|zinc|success|error)\b|\b(?:bg|text|border|ring|fill)-(?:warning|brand|gray|error|success)-\d+|dark:/
  for (const file of FILES)
    it(file, () => {
      const source = readFileSync(join(import.meta.dirname, '../src', file), 'utf8')
      expect(source.match(LEGACY)?.[0] ?? null).toBeNull()
    })
})
