import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useTabsStore } from '../src/stores/tabs'
import { groupKey } from '../src/workspace/tabGroups'

/**
 * User request 2026-10-12: a database's group remembers the collection last in use there (else its
 * first), kept across a reload — what it shows when the tab in use closes. User request 2026-10-13:
 * opened from its tab, a group shows the database itself.
 */
const collection = (db: string, coll: string) => ({
  kind: 'collection',
  title: `${db}.${coll}`,
  params: { connectionId: 'c1', db, coll },
})

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
})

// User request 2026-10-13: "tıkladığı zaman main olan açılsın … shop içerisinde gruplandı tıkladığımda
// shop açılsın" — a group opens on its database, never on its last tab.
describe('opening a group', () => {
  it('shows the database’s own tab, when it is one of the group', () => {
    const tabs = useTabsStore()
    tabs.open(collection('shop', 'users'))
    const db = tabs.open({ kind: 'database', title: 'shop', params: { connectionId: 'c1', db: 'shop' } })
    tabs.open(collection('shop', 'orders'))
    tabs.open({ kind: 'jobs', title: 'Jobs' })
    const order = tabs.tabs.map((t) => t.id)
    tabs.openGroup(JSON.stringify(['c1', 'shop']))
    expect(tabs.activeId).toBe(db)
    expect(tabs.tabs.map((t) => t.id)).toEqual(order)
  })

  it('opens the database’s tab at the group’s place when it is not open', () => {
    const tabs = useTabsStore()
    const jobs = tabs.open({ kind: 'jobs', title: 'Jobs' })
    const users = tabs.open(collection('shop', 'users'))
    const orders = tabs.open(collection('shop', 'orders'))
    const other = tabs.open({ kind: 'library', title: 'Library' })
    tabs.openGroup(JSON.stringify(['c1', 'shop']))
    const db = tabs.active!
    expect(db).toMatchObject({ kind: 'database', title: 'shop', params: { connectionId: 'c1', db: 'shop' } })
    expect(tabs.tabs.map((t) => t.id)).toEqual([jobs, db.id, users, orders, other])
    expect(JSON.parse(localStorage.getItem('mm:tabs')!).activeId).toBe(db.id)
  })

  it('remembers the collection last in use in that database', () => {
    const tabs = useTabsStore()
    const users = tabs.open(collection('shop', 'users'))
    const orders = tabs.open(collection('shop', 'orders'))
    tabs.activate(users)
    tabs.open(collection('analytics', 'events'))
    const key = groupKey(tabs.tabs.find((t) => t.id === users)!)!
    expect(tabs.lastInUse(key)).toBe(users)
    tabs.activate(orders)
    tabs.open({ kind: 'jobs', title: 'Jobs' })
    expect(tabs.lastInUse(key)).toBe(orders)
  })

  it('shows its first collection when the one last in use is closed, or none was', () => {
    const tabs = useTabsStore()
    const users = tabs.open(collection('shop', 'users'))
    const orders = tabs.open(collection('shop', 'orders'))
    tabs.open(collection('shop', 'products'))
    tabs.activate(orders)
    tabs.open({ kind: 'jobs', title: 'Jobs' })
    const key = groupKey(tabs.tabs.find((t) => t.id === users)!)!
    tabs.close(orders)
    expect(tabs.lastInUse(key)).toBe(users)
  })

  it('does nothing for a group that is not there', () => {
    const tabs = useTabsStore()
    const jobs = tabs.open({ kind: 'jobs', title: 'Jobs' })
    tabs.openGroup('["c1","nowhere"]')
    expect(tabs.activeId).toBe(jobs)
  })

  it('remembers the collection last in use across a reload, and forgets a database whose tabs are gone', () => {
    const tabs = useTabsStore()
    const users = tabs.open(collection('shop', 'users'))
    tabs.open(collection('shop', 'orders'))
    tabs.activate(users)
    tabs.open({ kind: 'jobs', title: 'Jobs' })
    const key = groupKey(tabs.tabs.find((t) => t.id === users)!)!
    setActivePinia(createPinia())
    const again = useTabsStore()
    expect(again.lastInUse(key)).toBe(users)
    again.closeMany(again.tabs.filter((t) => t.params.db === 'shop').map((t) => t.id))
    expect(JSON.parse(localStorage.getItem('mm:tabs')!).lastIn).toEqual({})
  })

  it('takes nothing but a tab id of that database from storage', () => {
    localStorage.setItem(
      'mm:tabs',
      JSON.stringify({
        tabs: [{ id: 'jobs', kind: 'jobs', title: 'Jobs', params: {} }],
        activeId: 'jobs',
        owner: null,
        lastIn: { '["c1","shop"]': 'jobs', bad: 5, ['x'.repeat(5000)]: 'y' },
      }),
    )
    const tabs = useTabsStore()
    tabs.openGroup('["c1","shop"]')
    expect(tabs.activeId).toBe('jobs')
    // Saved again, what was not taken is gone.
    tabs.activate('jobs')
    expect(JSON.parse(localStorage.getItem('mm:tabs')!).lastIn).toEqual({})
  })
})

describe('closing many tabs at once', () => {
  it('closes them all, the tab in use staying when it is not one of them', () => {
    const tabs = useTabsStore()
    const jobs = tabs.open({ kind: 'jobs', title: 'Jobs' })
    const users = tabs.open(collection('shop', 'users'))
    const orders = tabs.open(collection('shop', 'orders'))
    const events = tabs.open(collection('analytics', 'events'))
    tabs.closeMany([users, orders])
    expect(tabs.tabs.map((t) => t.id)).toEqual([jobs, events])
    expect(tabs.activeId).toBe(events)
  })

  it('shows the tab before them when the one in use was among them', () => {
    const tabs = useTabsStore()
    const jobs = tabs.open({ kind: 'jobs', title: 'Jobs' })
    const users = tabs.open(collection('shop', 'users'))
    const orders = tabs.open(collection('shop', 'orders'))
    tabs.open(collection('analytics', 'events'))
    tabs.activate(orders)
    tabs.closeMany([users, orders])
    expect(tabs.activeId).toBe(jobs)
  })
})

describe('the tab last in use, kept', () => {
  it('forgets a database once its tabs are closed one by one', () => {
    const tabs = useTabsStore()
    const users = tabs.open(collection('shop', 'users'))
    const orders = tabs.open(collection('shop', 'orders'))
    tabs.open({ kind: 'jobs', title: 'Jobs' })
    tabs.close(users)
    tabs.close(orders)
    expect(JSON.parse(localStorage.getItem('mm:tabs')!).lastIn).toEqual({})
  })
})

// Review 2026-10-12 of the tab groups.
describe('tabs beside a gathered group', () => {
  /** jobs, shop's users, orders and products, then analytics.events (in use): shop is gathered. */
  function strip() {
    const tabs = useTabsStore()
    const jobs = tabs.open({ kind: 'jobs', title: 'Jobs' })
    const users = tabs.open(collection('shop', 'users'))
    const orders = tabs.open(collection('shop', 'orders'))
    const products = tabs.open(collection('shop', 'products'))
    const events = tabs.open(collection('analytics', 'events'))
    return { tabs, jobs, users, orders, products, events, ids: () => tabs.tabs.map((t) => t.id) }
  }

  // I1: Ctrl+Shift+arrows moved a tab into a gathered group, nothing seen to move.
  it('moves a tab past a gathered group as one, never into it', () => {
    const { tabs, jobs, users, orders, products, events, ids } = strip()
    tabs.moveBy(events, -1)
    expect(ids()).toEqual([jobs, events, users, orders, products])
    tabs.moveBy(events, -1)
    expect(ids()).toEqual([events, jobs, users, orders, products])
    tabs.moveBy(events, -1)
    expect(ids()).toEqual([events, jobs, users, orders, products])
    tabs.moveBy(events, 1)
    tabs.moveBy(events, 1)
    expect(ids()).toEqual([jobs, users, orders, products, events])
  })

  // I2: closing the tab in use opened the group beside it, on its last tab by place.
  it('shows the nearest tab shown when the one in use closes, a group only when there is none', () => {
    const { tabs, jobs, events } = strip()
    tabs.close(events)
    expect(tabs.activeId).toBe(jobs)
    const again = strip()
    again.tabs.close(again.jobs)
    again.tabs.activate(again.events)
    again.tabs.closeWhere((t) => t.id === again.events)
    // No tab shown is left: the group opens, on its collection last in use.
    expect(again.tabs.activeId).toBe(again.products)
  })

  // Review 2026-10-13 (M3): the database's tab a group opened on, closed, left the database — and its
  // tabs gathered at once. The tab shown next is one of the same database when there is one.
  it('stays in the database when its tab in use closes and another of it is open', () => {
    const tabs = useTabsStore()
    const jobs = tabs.open({ kind: 'jobs', title: 'Jobs' })
    const users = tabs.open(collection('shop', 'users'))
    tabs.open(collection('shop', 'orders'))
    tabs.open({ kind: 'library', title: 'Library' })
    tabs.openGroup(JSON.stringify(['c1', 'shop']))
    tabs.close(tabs.activeId)
    expect(tabs.activeId).toBe(users)
    // None of it left: the nearest, as before.
    tabs.closeWhere((t) => t.params.db === 'shop' && t.id !== users)
    tabs.close(users)
    expect(tabs.activeId).toBe(jobs)
  })

  it('opens a group on a collection of those staying when tabs close together', () => {
    const tabs = useTabsStore()
    tabs.open({ kind: 'database', title: 'shop', params: { connectionId: 'c1', db: 'shop' } })
    const users = tabs.open(collection('shop', 'users'))
    tabs.open(collection('shop', 'orders'))
    const products = tabs.open(collection('shop', 'products'))
    const jobs = tabs.open({ kind: 'jobs', title: 'Jobs' })
    tabs.closeMany([jobs, products])
    expect(tabs.activeId).toBe(users)
  })

  it('moves a whole group, and puts a dropped tab before a group', () => {
    const { tabs, jobs, users, orders, products, events, ids } = strip()
    tabs.moveGroup(JSON.stringify(['c1', 'shop']), 0)
    expect(ids()).toEqual([users, orders, products, jobs, events])
    tabs.moveGroup(JSON.stringify(['c1', 'shop']), 2)
    expect(ids()).toEqual([jobs, events, users, orders, products])
  })

  // Minor 19: closing a group could not be undone.
  it('puts closed tabs back where they were', () => {
    const { tabs, jobs, users, orders, products, events, ids } = strip()
    const closed = tabs.closeMany([users, orders, products])
    expect(ids()).toEqual([jobs, events])
    tabs.restore(closed)
    expect(ids()).toEqual([jobs, users, orders, products, events])
    expect(tabs.activeId).toBe(events)
  })

  // Minor 18: a renamed collection's tab moved to the end and was shown.
  it('replaces a tab in its place, shown only if it was', () => {
    const { tabs, jobs, users, orders, products, events, ids } = strip()
    const renamed = tabs.replace(orders, collection('shop', 'sales'))
    expect(ids()).toEqual([jobs, users, renamed, products, events])
    expect(tabs.activeId).toBe(events)
    tabs.activate(renamed)
    const again = tabs.replace(renamed, collection('shop', 'orders'))
    expect(tabs.activeId).toBe(again)
  })
})

describe('the tab last in use of a database', () => {
  // Minor 10: the database's own tab, last in use, opened its group on the overview.
  it('is a collection, never the database’s own tab', () => {
    const tabs = useTabsStore()
    const users = tabs.open(collection('shop', 'users'))
    tabs.open(collection('shop', 'orders'))
    tabs.activate(users)
    tabs.open({ kind: 'database', title: 'shop', params: { connectionId: 'c1', db: 'shop' } })
    tabs.open({ kind: 'jobs', title: 'Jobs' })
    expect(tabs.lastInUse(JSON.stringify(['c1', 'shop']))).toBe(users)
  })

  // Minor 11: the tab in use when the page loaded was never taken.
  it('takes the tab in use when the page loads', () => {
    const tabs = useTabsStore()
    tabs.open(collection('shop', 'users'))
    const orders = tabs.open(collection('shop', 'orders'))
    const stored = JSON.parse(localStorage.getItem('mm:tabs')!)
    localStorage.setItem('mm:tabs', JSON.stringify({ ...stored, lastIn: undefined }))
    setActivePinia(createPinia())
    const again = useTabsStore()
    again.open({ kind: 'jobs', title: 'Jobs' })
    expect(again.lastInUse(JSON.stringify(['c1', 'shop']))).toBe(orders)
  })
})
