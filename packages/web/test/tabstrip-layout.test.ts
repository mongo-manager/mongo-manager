import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, nextTick } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import TabStrip from '../src/workspace/TabStrip.vue'
import { useLeaveGuard } from '../src/workspace/unsaved'
import { useTabsStore } from '../src/stores/tabs'
import { useCollectionViewsStore } from '../src/stores/collectionViews'
import { useDialogStore } from '../src/stores/dialogs'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'
import { button } from './support/dom'
import ToastHost from '../src/ds/DsToastHost.vue'

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
  // The strip names connections (a group's, "All tabs"): answered here, never the network.
  mockApi({ 'GET connections': () => [200, []] })
})

/**
 * Phase 3e-1 UI review: with many tabs open, the tab strip scrolls on its own; a tab keeps its title on
 * one line and its width, and never widens the page.
 */
describe('the tab strip with many tabs', () => {
  it('keeps each tab on one line at its own width, inside a scrolling bar', () => {
    const tabs = useTabsStore()
    tabs.bindUser('local')
    for (let i = 0; i < 12; i++)
      tabs.open({ kind: 'database', title: `Local test ${i}`, params: { connectionId: 'c1', db: `db${i}` } })
    const { wrapper } = mountApp(TabStrip)
    const bar = wrapper.get('[role="tablist"]')
    expect(bar.classes()).toEqual(expect.arrayContaining(['overflow-x-auto', 'min-w-0']))
    const items = bar.findAll('[role="tab"]')
    expect(items.length).toBeGreaterThan(10)
    for (const item of items) {
      expect(item.element.parentElement!.classList.contains('shrink-0')).toBe(true)
      expect(item.get('[data-title]').classes()).toContain('truncate')
    }
  })

  it('brings the active tab fully into view when it changes', async () => {
    const seen: string[] = []
    const scroll = vi.fn(function (this: Element) {
      seen.push(this.textContent ?? '')
    })
    Element.prototype.scrollIntoView = scroll
    const tabs = useTabsStore()
    tabs.bindUser('local')
    for (let i = 0; i < 3; i++)
      tabs.open({ kind: 'database', title: `Tab ${i}`, params: { connectionId: 'c1', db: `db${i}` } })
    mountApp(TabStrip)
    tabs.open({ kind: 'database', title: 'Far right', params: { connectionId: 'c1', db: 'far' } })
    await nextTick()
    await nextTick()
    expect(scroll).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' })
    expect(seen.at(-1)).toContain('Far right')
  })
})

describe('closing a tab with unsaved edits (reviewer B I1)', () => {
  const unsaved = () => {
    const tabs = useTabsStore()
    tabs.bindUser('local')
    const tab = tabs.open({
      kind: 'collection',
      title: 'orders',
      params: { connectionId: 'c1', db: 'shop', coll: 'orders' },
    })
    const id = tab
    useCollectionViewsStore().stateFor(id).inspector.draft = {
      key: 'insert',
      text: '{ a: 1 }',
      initial: '{\n  \n}',
      hash: '',
      base: {},
      dropped: [],
    }
    return { tabs, id }
  }
  const closeButton = () =>
    document.querySelector<HTMLButtonElement>('button[aria-label="Close tab orders"]')!

  it('asks first, and keeps the tab when the edits are kept', async () => {
    const { tabs, id } = unsaved()
    mountApp(TabStrip)
    const confirm = vi.spyOn(useDialogStore(), 'confirm').mockResolvedValueOnce(false)
    closeButton().click()
    await flushPromises()
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(tabs.tabs.some((t) => t.id === id)).toBe(true)
    confirm.mockResolvedValueOnce(true)
    closeButton().click()
    await flushPromises()
    expect(tabs.tabs.some((t) => t.id === id)).toBe(false)
  })

  it('asks the browser to confirm leaving the page while edits are unsaved', () => {
    unsaved()
    mountApp(defineComponent({ setup: () => (useLeaveGuard(), () => null) }))
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })
})

/**
 * User request 2026-10-23: with many tabs open, "Close other tabs" under a tab's "Close tab": that
 * tab stays, the others close (asking first where edits would be lost), with Undo.
 */
describe('closing the other tabs', () => {
  // Tabs are kept for the user between visits: none of another test's here.
  beforeEach(() => localStorage.clear())
  const contextMenu = async (id: string) => {
    const tab = document.querySelector<HTMLElement>(`[role="tab"][data-id="${id}"]`)!
    tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    await flushPromises()
  }
  const item = (label: string) =>
    [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (el) => el.textContent?.trim() === label,
    )
  const open = (n: number) => {
    const tabs = useTabsStore()
    tabs.bindUser('local')
    const ids = Array.from({ length: n }, (_, i) =>
      tabs.open({ kind: 'database', title: `Tab ${i}`, params: { connectionId: 'c1', db: `db${i}` } }),
    )
    return { tabs, ids }
  }

  it('keeps the tab it was chosen on, active, closes the rest, and Undo brings them back', async () => {
    const { tabs, ids } = open(4)
    // Overview stays too: it never closes.
    tabs.home()
    mountApp(TabStrip)
    mountApp(ToastHost)
    await contextMenu(ids[2]!)
    expect(item('Close tab')).toBeDefined()
    item('Close other tabs')!.click()
    await flushPromises()
    expect(tabs.tabs.map((t) => t.id)).toEqual(['welcome', ids[2]])
    // It is shown, though Overview was.
    expect(tabs.activeId).toBe(ids[2])
    expect(document.body.textContent).toContain('3 other tabs closed.')
    button('Undo').click()
    await flushPromises()
    expect(tabs.tabs.map((t) => t.id)).toEqual(['welcome', ...ids])
  })

  it('is not offered when no other tab can close', async () => {
    const { ids } = open(1)
    mountApp(TabStrip)
    await contextMenu(ids[0]!)
    expect(item('Close other tabs')?.getAttribute('aria-disabled')).toBe('true')
  })

  it('asks first when another tab holds edits that would be lost, and closes nothing if refused', async () => {
    const { tabs, ids } = open(2)
    const tab = tabs.open({
      kind: 'collection',
      title: 'orders',
      params: { connectionId: 'c1', db: 'shop', coll: 'orders' },
    })
    useCollectionViewsStore().stateFor(tab).inspector.draft = {
      key: 'insert',
      text: '{ a: 1 }',
      initial: '{\n  \n}',
      hash: '',
      base: {},
      dropped: [],
    }
    mountApp(TabStrip)
    const dialogs = useDialogStore()
    const ask = vi.spyOn(dialogs, 'confirm').mockResolvedValue(false)
    await contextMenu(ids[0]!)
    item('Close other tabs')!.click()
    await flushPromises()
    expect(ask).toHaveBeenCalled()
    expect(tabs.tabs.map((t) => t.id)).toEqual(expect.arrayContaining([...ids, tab]))
  })
})

describe('closing the other tabs, reviewed', () => {
  beforeEach(() => localStorage.clear())
  const contextMenu = async (id: string) => {
    document
      .querySelector<HTMLElement>(`[role="tab"][data-id="${id}"]`)!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    await flushPromises()
  }
  const item = (label: string) =>
    [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (el) => el.textContent?.trim() === label,
    )

  it('asks before closing a shell (its session goes with it), with no Undo, and keeps all if refused (I1)', async () => {
    const tabs = useTabsStore()
    tabs.bindUser('local')
    const keep = tabs.open({ kind: 'database', title: 'Keep', params: { connectionId: 'c1', db: 'keep' } })
    const shell = tabs.open({ kind: 'shell', title: 'Shell', params: { connectionId: 'c1', db: 'test' } })
    const second = tabs.open({ kind: 'shell', title: 'Shell 2', params: { connectionId: 'c1', db: 'admin' } })
    mountApp(TabStrip)
    mountApp(ToastHost)
    const dialogs = useDialogStore()
    const ask = vi.spyOn(dialogs, 'confirm').mockResolvedValueOnce(false)
    await contextMenu(keep)
    item('Close other tabs')!.click()
    await flushPromises()
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ title: 'Close 2 tabs?' }))
    expect(tabs.tabs.map((t) => t.id)).toContain(shell)
    // Refused: the tab chosen is not made active for it either (nit 12).
    expect(tabs.activeId).toBe(second)
    expect(tabs.tabs.map((t) => t.id)).toContain(shell)
    ask.mockResolvedValueOnce(true)
    await contextMenu(keep)
    item('Close other tabs')!.click()
    await flushPromises()
    expect(tabs.tabs.map((t) => t.id)).toEqual([keep])
    expect(document.body.textContent).not.toContain('Undo')
  })

  it('starts its own group on Overview, which has no Close tab (nit 11)', async () => {
    const tabs = useTabsStore()
    tabs.bindUser('local')
    tabs.open({ kind: 'database', title: 'One', params: { connectionId: 'c1', db: 'one' } })
    tabs.home()
    mountApp(TabStrip)
    await contextMenu('welcome')
    expect(item('Close tab')).toBeUndefined()
    expect(
      item('Close other tabs')!.closest('[role="menuitem"]')?.previousElementSibling?.getAttribute('role'),
    ).toBe('separator')
  })
})
