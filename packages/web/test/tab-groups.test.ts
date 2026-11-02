import { describe, expect, it } from 'vitest'
import { groupKey, stripItems } from '../src/workspace/tabGroups'
import type { WorkspaceTab } from '../src/stores/tabs'

/**
 * User request 2026-10-12: the collection tabs of a database are gathered into one tab of the
 * database when the user is elsewhere, and shown again when they come back to it.
 */
const coll = (db: string, name: string, connectionId = 'c1'): WorkspaceTab => ({
  id: `collection:${connectionId}:${db}.${name}`,
  kind: 'collection',
  title: `${db}.${name}`,
  params: { connectionId, db, coll: name },
})
const database = (db: string, connectionId = 'c1'): WorkspaceTab => ({
  id: `database:${connectionId}:${db}`,
  kind: 'database',
  title: db,
  params: { connectionId, db },
})
const page = (kind: string): WorkspaceTab => ({ id: kind, kind, title: kind, params: {} })

/** The strip as a list of words: a tab by its id, a group as `[db: n]`. */
const shown = (tabs: WorkspaceTab[], activeId: string) =>
  stripItems(tabs, activeId).map((item) =>
    item.kind === 'tab' ? item.tab.id : `[${item.group.db}: ${item.group.collections}]`,
  )

describe('stripItems', () => {
  const users = coll('shop', 'users')
  const orders = coll('shop', 'orders')
  const products = coll('shop', 'products')
  const events = coll('analytics', 'events')

  it('gathers the collection tabs of a database the user left into one, where its first tab was', () => {
    const tabs = [page('jobs'), users, orders, products, events]
    expect(shown(tabs, events.id)).toEqual(['jobs', '[shop: 3]', events.id])
    // On another page altogether, the same.
    expect(shown(tabs, 'jobs')).toEqual(['jobs', '[shop: 3]', events.id])
  })

  it('shows them one by one while the user is on that database: one of its collections or itself', () => {
    const shopDb = database('shop')
    const tabs = [users, orders, events, shopDb]
    expect(shown(tabs, orders.id)).toEqual([users.id, orders.id, events.id, shopDb.id])
    expect(shown(tabs, shopDb.id)).toEqual([users.id, orders.id, events.id, shopDb.id])
  })

  it('takes the database’s own tab into its group, or makes one without it', () => {
    const shopDb = database('shop')
    expect(shown([shopDb, users, orders, events], events.id)).toEqual(['[shop: 2]', events.id])
    expect(shown([users, orders, events], events.id)).toEqual(['[shop: 2]', events.id])
  })

  it('never gathers a single collection tab, with or without its database’s tab', () => {
    expect(shown([users, events], events.id)).toEqual([users.id, events.id])
    expect(shown([database('shop'), users, events], events.id)).toEqual([
      'database:c1:shop',
      users.id,
      events.id,
    ])
  })

  it('keeps the tabs of two connections apart, though their databases share a name', () => {
    const other = [coll('shop', 'users', 'c2'), coll('shop', 'orders', 'c2')]
    const tabs = [users, orders, ...other, page('jobs')]
    const groups = stripItems(tabs, 'jobs').filter((i) => i.kind === 'group')
    expect(groups.map((g) => g.kind === 'group' && g.group.connectionId)).toEqual(['c1', 'c2'])
  })

  it('holds a group’s tabs in the strip’s order', () => {
    const tabs = [page('jobs'), users, orders, events]
    const group = stripItems(tabs, events.id)[1]!
    expect(group.kind === 'group' && group.group.members.map((m) => m.id)).toEqual([users.id, orders.id])
  })

  // Review 2026-10-12 (minor 21): the database's shell, or a plugin page on it, is work on the database.
  it('keeps a group open while the user is on another tab on its database (its shell, a page on it)', () => {
    const shell = {
      id: 'shell:shop',
      kind: 'shell',
      title: 'Shell',
      params: { connectionId: 'c1', db: 'shop' },
    }
    const plugin = {
      id: 'pluginPage:x',
      kind: 'pluginPage',
      title: 'Charts',
      params: { plugin: 'p', contribution: 'c', connectionId: 'c1', db: 'shop', coll: 'users' },
    }
    expect(shown([users, orders, events, shell], shell.id)).toEqual([
      users.id,
      orders.id,
      events.id,
      shell.id,
    ])
    expect(shown([users, orders, plugin], plugin.id)).toEqual([users.id, orders.id, plugin.id])
    // On another connection's database of the same name, gathered.
    const elsewhere = { ...shell, id: 'shell:c2', params: { connectionId: 'c2', db: 'shop' } }
    expect(shown([users, orders, elsewhere], elsewhere.id)).toEqual(['[shop: 2]', elsewhere.id])
  })
})

describe('groupKey', () => {
  it('is the connection and database of a collection or database tab, nothing for any other', () => {
    expect(groupKey(coll('shop', 'a'))).toBe(groupKey(database('shop')))
    expect(groupKey(coll('shop', 'a'))).not.toBe(groupKey(coll('shop', 'a', 'c2')))
    expect(groupKey(page('jobs'))).toBeNull()
    expect(groupKey({ ...page('shell'), params: { connectionId: 'c1', db: 'shop' } })).toBeNull()
  })
})
