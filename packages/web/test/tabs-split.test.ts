// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useTabsStore } from '../src/stores/tabs'
import { stripItems } from '../src/workspace/tabGroups'

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
})
afterEach(() => {
  vi.restoreAllMocks()
})

const coll = (c: string) => ({
  kind: 'collection',
  title: `shop.${c}`,
  params: { connectionId: 'c1', db: 'shop', coll: c },
})

describe('split view (completion W6.1)', () => {
  it('opens a tab beside the one in use: left keeps it, right shows the other and has the focus', () => {
    const tabs = useTabsStore()
    const orders = tabs.open(coll('orders'))
    const users = tabs.open(coll('users'))
    tabs.activate(orders)
    expect(tabs.openBeside(users)).toBe(true)
    expect(tabs.split).toMatchObject({ left: orders, right: users, focus: 'right', ratio: 0.5 })
    expect(tabs.activeId).toBe(users)
    expect(tabs.paneOf(orders)).toBe('left')
    expect(tabs.paneOf(users)).toBe('right')
  })

  it('opening the tab in use beside puts the one used before it on the left', () => {
    const tabs = useTabsStore()
    const orders = tabs.open(coll('orders'))
    const users = tabs.open(coll('users'))
    tabs.open(coll('items'))
    tabs.activate(orders)
    tabs.activate(users)
    expect(tabs.openBeside(users)).toBe(true)
    expect(tabs.split).toMatchObject({ left: orders, right: users, focus: 'right' })
  })

  it('refuses with nothing to put beside, and never puts Overview in a pane', () => {
    const tabs = useTabsStore()
    const orders = tabs.open(coll('orders'))
    expect(tabs.openBeside(orders)).toBe(false)
    expect(tabs.split).toBeNull()
    tabs.home()
    expect(tabs.openBeside('welcome')).toBe(false)
    expect(tabs.split).toBeNull()
    // From Overview, the tab asked for goes beside the last other tab in use.
    const users = tabs.open(coll('users'))
    tabs.home()
    expect(tabs.openBeside(orders)).toBe(true)
    expect(tabs.split).toMatchObject({ left: users, right: orders })
  })

  it('activating a tab shows it in the focused pane; activating a pane’s tab focuses that pane', () => {
    const tabs = useTabsStore()
    const a = tabs.open(coll('a'))
    const b = tabs.open(coll('b'))
    const c = tabs.open(coll('c'))
    tabs.activate(a)
    tabs.openBeside(b)
    tabs.activate(a)
    expect(tabs.split).toMatchObject({ left: a, right: b, focus: 'left' })
    tabs.activate(c)
    expect(tabs.split).toMatchObject({ left: c, right: b, focus: 'left' })
    // A new tab opens in the focused pane too.
    const d = tabs.open(coll('d'))
    expect(tabs.split).toMatchObject({ left: d, right: b, focus: 'left' })
    tabs.focusPane('right')
    expect(tabs.activeId).toBe(b)
  })

  // Review I3: Overview hides the split, as a narrow window does; it is kept, and comes back.
  it('Overview hides the split without forgetting it; closing a pane keeps both tabs open', () => {
    const tabs = useTabsStore()
    const a = tabs.open(coll('a'))
    const b = tabs.open(coll('b'))
    tabs.openBeside(a)
    expect(tabs.split).toMatchObject({ left: b, right: a, focus: 'right' })
    tabs.home()
    expect(tabs.panes).toBeNull()
    expect(tabs.paneOf(a)).toBeNull()
    expect(tabs.split).toMatchObject({ left: b, right: a })
    expect(JSON.parse(localStorage.getItem('mm:tabs')!).split).toMatchObject({ left: b, right: a })
    // Back on a pane's tab: the split again, that pane in use.
    tabs.activate(b)
    expect(tabs.panes).toMatchObject({ left: b, right: a, focus: 'left' })
    tabs.closePane('right')
    expect(tabs.split).toBeNull()
    expect(tabs.activeId).toBe(b)
    expect(tabs.tabs.map((t) => t.id)).toEqual(['welcome', a, b])
  })

  // Review minor 7: below 768 px the strip shows no panes; nothing acts on a hidden split.
  it('leaves a split hidden by a narrow window as it was, and shows it again when wide', () => {
    const tabs = useTabsStore()
    const a = tabs.open(coll('a'))
    const c = tabs.open(coll('c'))
    const b = tabs.open(coll('b'))
    tabs.activate(a)
    tabs.openBeside(b)
    tabs.setSplitAllowed(false)
    expect(tabs.panes).toBeNull()
    tabs.activate(c)
    expect(tabs.split).toMatchObject({ left: a, right: b, focus: 'right' })
    // Closing the tab in use goes to its neighbour in the strip, not to a pane no one sees.
    tabs.activate(a)
    tabs.close(a)
    expect(tabs.activeId).toBe(c)
    expect(tabs.split).toBeNull()
    const d = tabs.open(coll('d'))
    tabs.activate(b)
    tabs.setSplitAllowed(true)
    tabs.openBeside(d)
    tabs.setSplitAllowed(false)
    tabs.activate(c)
    tabs.setSplitAllowed(true)
    // Shown again: the tab in use goes into the pane that was in use.
    expect(tabs.panes).toMatchObject({ left: b, right: c, focus: 'right' })
  })

  // Review minor 8: dragging the divider saves once, when it is let go.
  it('keeps the divider in memory while it moves and saves it when asked', () => {
    const tabs = useTabsStore()
    tabs.open(coll('a'))
    tabs.openBeside(tabs.open(coll('b')))
    const saves = vi.spyOn(localStorage, 'setItem')
    tabs.setSplitRatio(0.3, false)
    tabs.setSplitRatio(0.35, false)
    expect(saves).not.toHaveBeenCalled()
    expect(tabs.split!.ratio).toBe(0.35)
    tabs.saveSplit()
    expect(saves).toHaveBeenCalledTimes(1)
    expect(JSON.parse(localStorage.getItem('mm:tabs')!).split.ratio).toBe(0.35)
  })

  // Review minor 6: the tabs used last, for Ctrl/Cmd+\ on Overview.
  it('knows the tabs used last, newest first, without Overview', () => {
    const tabs = useTabsStore()
    const a = tabs.open(coll('a'))
    const b = tabs.open(coll('b'))
    tabs.activate(a)
    tabs.home()
    expect(tabs.recentTabs()).toEqual([a, b])
  })

  it('closing a tab shown in a pane ends the split and leaves the other pane’s tab in use', () => {
    const tabs = useTabsStore()
    const a = tabs.open(coll('a'))
    const b = tabs.open(coll('b'))
    tabs.open(coll('c'))
    tabs.activate(a)
    tabs.openBeside(b)
    tabs.close(b)
    expect(tabs.split).toBeNull()
    expect(tabs.activeId).toBe(a)
    // The unfocused one closed: the focused one stays.
    const d = tabs.open(coll('d'))
    tabs.activate(a)
    tabs.openBeside(d)
    tabs.activate(a)
    tabs.close(d)
    expect(tabs.split).toBeNull()
    expect(tabs.activeId).toBe(a)
  })

  it('follows a tab replaced in its place (a renamed collection)', () => {
    const tabs = useTabsStore()
    const a = tabs.open(coll('a'))
    const b = tabs.open(coll('b'))
    tabs.activate(a)
    tabs.openBeside(b)
    const renamed = tabs.replace(b, coll('b2'))
    expect(tabs.split).toMatchObject({ left: a, right: renamed, focus: 'right' })
  })

  it('keeps the divider between 20 % and 80 %', () => {
    const tabs = useTabsStore()
    tabs.open(coll('a'))
    tabs.openBeside(tabs.open(coll('b')))
    expect(tabs.split).not.toBeNull()
    tabs.setSplitRatio(0.05)
    expect(tabs.split!.ratio).toBe(0.2)
    tabs.setSplitRatio(2)
    expect(tabs.split!.ratio).toBe(0.8)
    tabs.setSplitRatio(Number.NaN)
    expect(tabs.split!.ratio).toBe(0.8)
  })

  it('is restored after a reload, as the tabs are, and only as far as it still holds', () => {
    const tabs = useTabsStore()
    const a = tabs.open(coll('a'))
    const b = tabs.open(coll('b'))
    tabs.activate(a)
    tabs.openBeside(b)
    tabs.setSplitRatio(0.6)
    setActivePinia(createPinia())
    expect(useTabsStore().split).toEqual({ left: a, right: b, focus: 'right', ratio: 0.6 })
    expect(useTabsStore().activeId).toBe(b)

    // Abuse cases: whatever storage holds is checked as the tabs are.
    const stored = JSON.parse(localStorage.getItem('mm:tabs')!) as Record<string, unknown>
    const variants: unknown[] = [
      { left: b, right: b, focus: 'left', ratio: 0.5 },
      { left: a, right: 'gone', focus: 'left', ratio: 0.5 },
      { left: 'welcome', right: b, focus: 'right', ratio: 0.5 },
      { left: a, right: b, focus: 'up', ratio: 0.5 },
      { left: a, right: b, focus: 'left', ratio: '0.5' },
      { left: { $gt: '' }, right: b, focus: 'left', ratio: 0.5 },
      'split',
      [a, b],
    ]
    for (const split of variants) {
      localStorage.setItem('mm:tabs', JSON.stringify({ ...stored, split }))
      setActivePinia(createPinia())
      expect(useTabsStore().split, JSON.stringify(split)).toBeNull()
      expect(useTabsStore().tabs.map((t) => t.id)).toEqual([a, b])
    }
    // An out-of-range ratio is brought back in range; the pane in use follows the active tab.
    localStorage.setItem(
      'mm:tabs',
      JSON.stringify({ ...stored, activeId: a, split: { left: a, right: b, focus: 'right', ratio: 9 } }),
    )
    setActivePinia(createPinia())
    expect(useTabsStore().split).toEqual({ left: a, right: b, focus: 'left', ratio: 0.8 })
  })

  it('is forgotten at sign-out and never shown to another user', () => {
    const tabs = useTabsStore()
    tabs.bindUser('u1')
    const a = tabs.open(coll('a'))
    tabs.open(coll('b'))
    tabs.openBeside(a)
    expect(tabs.split).not.toBeNull()
    tabs.reset()
    expect(tabs.split).toBeNull()
    tabs.bindUser('u1')
    const c = tabs.open(coll('c'))
    tabs.open(coll('d'))
    tabs.openBeside(c)
    setActivePinia(createPinia())
    const other = useTabsStore()
    other.bindUser('u2')
    expect(other.split).toBeNull()
  })

  it('keeps the database group of the other pane’s tab open in the strip', () => {
    const tabs = useTabsStore()
    const a = tabs.open(coll('a'))
    tabs.open(coll('b'))
    const shell = tabs.open({ kind: 'jobs', title: '' })
    tabs.activate(a)
    tabs.openBeside(shell)
    const items = stripItems(tabs.tabs, tabs.activeId, tabs.split ? [tabs.split.left, tabs.split.right] : [])
    expect(items.every((i) => i.kind === 'tab')).toBe(true)
    // Without the split the shop group is gathered while the jobs page is in use.
    expect(stripItems(tabs.tabs, tabs.activeId).some((i) => i.kind === 'group')).toBe(true)
  })
})
