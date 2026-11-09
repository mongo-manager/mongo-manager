// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useTabsStore } from '../src/stores/tabs'

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
})

describe('tabs', () => {
  it('opens, deduplicates, activates and closes tabs, keeping a welcome tab', () => {
    const tabs = useTabsStore()
    expect(tabs.tabs.map((t) => t.kind)).toEqual(['welcome'])
    const a = tabs.open({
      kind: 'collection',
      title: 'shop.orders',
      params: { connectionId: 'c1', db: 'shop', coll: 'orders' },
    })
    const again = tabs.open({
      kind: 'collection',
      title: 'shop.orders',
      params: { coll: 'orders', db: 'shop', connectionId: 'c1' },
    })
    expect(again).toBe(a)
    const b = tabs.open({
      kind: 'collection',
      title: 'shop.users',
      params: { connectionId: 'c1', db: 'shop', coll: 'users' },
    })
    expect(tabs.activeId).toBe(b)
    expect(tabs.tabs.map((t) => t.kind)).toEqual(['collection', 'collection'])
    tabs.close(b)
    expect(tabs.activeId).toBe(a)
    tabs.close(a)
    expect(tabs.tabs.map((t) => t.kind)).toEqual(['welcome'])
  })

  it('restores tabs after a reload and survives corrupt storage', () => {
    const tabs = useTabsStore()
    tabs.open({ kind: 'collection', title: 'x', params: { connectionId: 'c1', db: 'd', coll: 'x' } })
    setActivePinia(createPinia())
    expect(useTabsStore().tabs.map((t) => t.title)).toEqual(['x'])
    localStorage.setItem('mm:tabs', '{broken')
    setActivePinia(createPinia())
    expect(useTabsStore().tabs.map((t) => t.kind)).toEqual(['welcome'])
  })
})

describe('Overview beside the other tabs (user, 2026-10-08: "sayfayı yeniliyorum ana sayfa tabı siliniyor")', () => {
  const orders = {
    kind: 'collection',
    title: 'shop.orders',
    params: { connectionId: 'c1', db: 'shop', coll: 'orders' },
  }
  const users = {
    kind: 'collection',
    title: 'shop.users',
    params: { connectionId: 'c1', db: 'shop', coll: 'users' },
  }

  it('stays open, in its place, and shown after a reload', () => {
    const tabs = useTabsStore()
    tabs.open(orders)
    tabs.home()
    setActivePinia(createPinia())
    const again = useTabsStore()
    expect(again.tabs.map((t) => t.kind)).toEqual(['welcome', 'collection'])
    expect(again.active?.kind).toBe('welcome')
  })

  it('stays open when another tab is opened beside it, until it is closed', () => {
    const tabs = useTabsStore()
    tabs.open(orders)
    tabs.home()
    tabs.open(users)
    expect(tabs.tabs.map((t) => t.kind)).toEqual(['welcome', 'collection', 'collection'])
    tabs.close('welcome')
    expect(tabs.tabs.map((t) => t.kind)).toEqual(['collection', 'collection'])
    setActivePinia(createPinia())
    expect(useTabsStore().tabs.map((t) => t.kind)).toEqual(['collection', 'collection'])
  })

  it('is still replaced when it is the only tab (the empty workspace)', () => {
    const tabs = useTabsStore()
    tabs.open(orders)
    expect(tabs.tabs.map((t) => t.kind)).toEqual(['collection'])
  })
})

describe('the AI history tab and the request it shows (user, 2026-10-09: "url ai-history/istekId olsun")', () => {
  const R = '00000000-0000-4000-8000-000000000001'

  it('stays one tab whichever request it shows, and remembers it after a reload', () => {
    const tabs = useTabsStore()
    const list = tabs.open({ kind: 'aiHistory', title: '' })
    const shown = tabs.open({ kind: 'aiHistory', title: '', params: { requestId: R } })
    expect(shown).toBe(list)
    expect(tabs.tabs.filter((t) => t.kind === 'aiHistory')).toHaveLength(1)
    expect(tabs.active?.params).toEqual({ requestId: R })
    setActivePinia(createPinia())
    expect(useTabsStore().active?.params).toEqual({ requestId: R })
    // Opened again from the sidebar (no request): the list.
    useTabsStore().open({ kind: 'aiHistory', title: '' })
    expect(useTabsStore().active?.params).toEqual({})
  })

  it('changes the request shown in place, and never another tab’s params', () => {
    const tabs = useTabsStore()
    const id = tabs.open({ kind: 'aiHistory', title: '' })
    tabs.setView(id, { requestId: R })
    expect(tabs.active).toMatchObject({ id, params: { requestId: R } })
    tabs.setView(id, { requestId: null })
    expect(tabs.active?.params).toEqual({})
    const coll = tabs.open({
      kind: 'collection',
      title: 'x',
      params: { connectionId: 'c1', db: 'd', coll: 'x' },
    })
    tabs.setView(coll, { requestId: R })
    expect(tabs.active?.params).toEqual({ connectionId: 'c1', db: 'd', coll: 'x' })
  })
})

describe('a stored AI history tab (page review)', () => {
  it('drops a request id that is no UUID, keeping the tab', () => {
    localStorage.setItem(
      'mm:tabs',
      JSON.stringify({
        tabs: [{ id: 'aiHistory:', kind: 'aiHistory', title: '', params: { requestId: '../x' } }],
        activeId: 'aiHistory:',
        owner: null,
      }),
    )
    const tabs = useTabsStore()
    expect(tabs.active?.kind).toBe('aiHistory')
    expect(tabs.active?.params).toEqual({})
  })
})
