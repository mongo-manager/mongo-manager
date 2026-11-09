// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { INSPECTOR_MAX, INSPECTOR_MIN, SIDEBAR_MAX, SIDEBAR_MIN, useLayoutStore } from '../src/stores/layout'
import { placeOfTab, usePlacesStore, type Place } from '../src/stores/places'
import { useTabsStore } from '../src/stores/tabs'

const coll = (c: string): Place => ({
  key: `collection:c1/shop/${c}`,
  kind: 'collection',
  title: `shop.${c}`,
  params: { connectionId: 'c1', db: 'shop', coll: c },
})

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: false,
    media: q,
    addEventListener() {},
    removeEventListener() {},
  }))
})
afterEach(() => vi.unstubAllGlobals())

describe('layout (spec rev. 2 §3.1, §3.6)', () => {
  it('collapses the sidebar, bounds and remembers its width, and toggles focus mode', () => {
    const layout = useLayoutStore()
    layout.start()
    expect([layout.sidebarCollapsed, layout.sidebarWidth, layout.focusMode]).toEqual([false, 260, false])
    layout.toggleSidebar()
    layout.setSidebarWidth(9999)
    expect(layout.sidebarCollapsed).toBe(true)
    expect(layout.sidebarWidth).toBe(SIDEBAR_MAX)
    layout.setSidebarWidth(1)
    expect(layout.sidebarWidth).toBe(SIDEBAR_MIN)
    layout.toggleFocus()
    expect(layout.focusMode).toBe(true)
    // The inspector's width is bounded and remembered too (spec rev. 2 §4.5).
    layout.setInspectorWidth(9999)
    expect(layout.inspectorWidth).toBe(INSPECTOR_MAX)
    layout.setInspectorWidth(1)
    expect(JSON.parse(localStorage.getItem('mm:layout')!)).toEqual({
      sidebarCollapsed: true,
      sidebarWidth: SIDEBAR_MIN,
      inspectorWidth: INSPECTOR_MIN,
    })
    setActivePinia(createPinia())
    const again = useLayoutStore()
    expect([again.sidebarCollapsed, again.sidebarWidth, again.focusMode]).toEqual([true, SIDEBAR_MIN, false])
  })

  it('ignores stored values of the wrong type', () => {
    localStorage.setItem('mm:layout', JSON.stringify({ sidebarCollapsed: 'yes', sidebarWidth: '<b>' }))
    const layout = useLayoutStore()
    expect([layout.sidebarCollapsed, layout.sidebarWidth]).toEqual([false, 260])
  })

  it('below 1024 px the sidebar is an overlay that Mod+B opens and closes', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: true,
      media: q,
      addEventListener() {},
      removeEventListener() {},
    }))
    const layout = useLayoutStore()
    layout.start()
    expect(layout.sidebarShown).toBe(false)
    layout.toggleSidebar()
    expect(layout.sidebarShown).toBe(true)
    layout.closeOverlay()
    expect(layout.sidebarShown).toBe(false)
  })
})

describe('places: pins and recent (spec rev. 2 §3.6)', () => {
  it('pins per user, never mixing users, and unpins', () => {
    const places = usePlacesStore()
    places.bindUser('u1')
    places.pin(coll('orders'))
    places.pin(coll('orders'))
    expect(places.pins.map((p) => p.key)).toEqual(['collection:c1/shop/orders'])
    expect(places.isPinned('collection:c1/shop/orders')).toBe(true)
    setActivePinia(createPinia())
    const other = usePlacesStore()
    other.bindUser('u2')
    expect(other.pins).toEqual([])
    other.bindUser('u1')
    expect(other.pins.map((p) => p.title)).toEqual(['shop.orders'])
    other.unpin('collection:c1/shop/orders')
    expect(JSON.parse(localStorage.getItem('mm:pins:u1')!)).toEqual([])
  })

  it('keeps the last 12 places, newest first, without duplicates', () => {
    const places = usePlacesStore()
    places.bindUser('u1')
    for (let i = 0; i < 15; i++) places.visit(coll(`c${i}`))
    places.visit(coll('c3'))
    expect(places.recent).toHaveLength(12)
    expect(places.recent[0]!.title).toBe('shop.c3')
    expect(places.recent.filter((p) => p.title === 'shop.c3')).toHaveLength(1)
  })

  it('forgets recent places on sign-out, keeps the pins the user chose', () => {
    const places = usePlacesStore()
    places.bindUser('u1')
    places.pin(coll('orders'))
    places.visit(coll('users'))
    places.reset()
    expect(places.recent).toEqual([])
    expect(localStorage.getItem('mm:recent:u1')).toBeNull()
    setActivePinia(createPinia())
    const again = usePlacesStore()
    again.bindUser('u1')
    expect(again.pins).toHaveLength(1)
    expect(again.recent).toEqual([])
  })

  it('drops stored entries that are not places', () => {
    localStorage.setItem(
      'mm:pins:u1',
      JSON.stringify([
        coll('ok'),
        { key: 1 },
        { ...coll('bad'), kind: 'script' },
        { ...coll('p'), params: { db: 7 } },
        'x',
      ]),
    )
    const places = usePlacesStore()
    places.bindUser('u1')
    expect(places.pins.map((p) => p.title)).toEqual(['shop.ok'])
  })

  it('stores nothing before a user is bound', () => {
    const places = usePlacesStore()
    places.visit(coll('orders'))
    places.pin(coll('orders'))
    expect(Object.keys(localStorage)).toEqual([])
  })

  it('knows the place of connection, database and collection tabs only', () => {
    expect(
      placeOfTab({
        id: 'x',
        kind: 'collection',
        title: 'shop.orders',
        params: { connectionId: 'c1', db: 'shop', coll: 'orders' },
      }),
    ).toEqual(coll('orders'))
    expect(
      placeOfTab({ id: 'y', kind: 'database', title: 'shop', params: { connectionId: 'c1', db: 'shop' } })!
        .key,
    ).toBe('database:c1/shop')
    expect(
      placeOfTab({ id: 'z', kind: 'connection', title: 'Prod', params: { connectionId: 'c1' } })!.key,
    ).toBe('connection:c1')
    expect(placeOfTab({ id: 'a', kind: 'audit', title: '', params: {} })).toBeNull()
  })
})

describe('tabs.home', () => {
  it('brings Overview back beside open tabs and activates it', () => {
    const tabs = useTabsStore()
    tabs.open({ kind: 'audit', title: '' })
    expect(tabs.tabs.some((t) => t.kind === 'welcome')).toBe(false)
    tabs.home()
    expect(tabs.tabs[0]!.kind).toBe('welcome')
    expect(tabs.active!.kind).toBe('welcome')
    tabs.home()
    expect(tabs.tabs.filter((t) => t.kind === 'welcome')).toHaveLength(1)
  })
})
