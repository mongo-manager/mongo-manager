// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ConnectionTab from '../src/workspace/tabs/ConnectionTab.vue'
import { useSessionStore } from '../src/stores/session'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'

/**
 * W3: the connection page's new sections appear only for who may use them — Users & roles with
 * databases:admin and personal data shown, Sharding on a mongos, Alerts for the app's administrators
 * — and its header shows the connection's live health.
 */
const connection = (permissions: string[], over: Record<string, unknown> = {}) => ({
  id: 'c1',
  name: 'Prod',
  group: null,
  color: null,
  favorite: false,
  readOnly: false,
  settings: {},
  uri: 'mongodb://db1.example.org:27017/',
  createdAt: 0,
  updatedAt: 0,
  lastUsedAt: null,
  access: 'admin',
  permissions,
  export: true,
  shell: false,
  restricted: false,
  ...over,
})
function api(c: ReturnType<typeof connection>, topology = 'replicaSet', alertsFiring = 0) {
  return mockApi({
    'GET connections': () => [200, [c]],
    'GET connections/c1/databases': () => [200, { databases: [], totalSize: 0 }],
    'GET connections/c1/health': () => [
      200,
      {
        connectionId: 'c1',
        state: 'ok',
        latencyMs: 7,
        version: '8.0.4',
        topology,
        alertsFiring,
        checkedAt: '',
      },
    ],
  })
}
const tabs = () => [...document.querySelectorAll('[role="tab"]')].map((t) => t.textContent?.trim())

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('connection sections (W3)', () => {
  it('offers Users & roles to a connection admin who sees personal data, and no one else', async () => {
    api(connection(['databases:read', 'server:monitor', 'databases:admin']))
    mountApp(ConnectionTab, { props: { connectionId: 'c1' } })
    await flushPromises()
    expect(tabs()).toContain('Users & roles')
    document.body.innerHTML = ''
    api(connection(['databases:read', 'server:monitor', 'databases:admin'], { restricted: true }))
    mountApp(ConnectionTab, { props: { connectionId: 'c1' } })
    await flushPromises()
    expect(tabs()).not.toContain('Users & roles')
    // User report 2026-10-30: one who hides personal data from themselves manages accounts still;
    // one an administrator hides it from does not.
    for (const [accountsRestricted, offered] of [
      [false, true],
      [true, false],
    ] as const) {
      document.body.innerHTML = ''
      api(
        connection(['databases:read', 'server:monitor', 'databases:admin'], {
          restricted: true,
          accountsRestricted,
        }),
      )
      mountApp(ConnectionTab, { props: { connectionId: 'c1' } })
      await flushPromises()
      expect(tabs().includes('Users & roles'), String(accountsRestricted)).toBe(offered)
    }
    document.body.innerHTML = ''
    api(connection(['databases:read', 'server:monitor', 'databases:write']))
    mountApp(ConnectionTab, { props: { connectionId: 'c1' } })
    await flushPromises()
    expect(tabs()).not.toContain('Users & roles')
  })

  it('offers Sharding on a mongos only, and Alerts to the app’s administrators', async () => {
    api(connection(['databases:read', 'server:monitor']), 'sharded')
    useSessionStore().me = { permissions: ['settings:manage'] } as never
    mountApp(ConnectionTab, { props: { connectionId: 'c1' } })
    await flushPromises()
    expect(tabs()).toEqual(expect.arrayContaining(['Sharding', 'Alerts']))
    document.body.innerHTML = ''
    api(connection(['databases:read', 'server:monitor']), 'replicaSet')
    useSessionStore().me = { permissions: [] } as never
    mountApp(ConnectionTab, { props: { connectionId: 'c1' } })
    await flushPromises()
    expect(tabs()).not.toContain('Sharding')
    expect(tabs()).not.toContain('Alerts')
  })

  it('shows the live health and alerts firing in the header', async () => {
    api(connection(['databases:read']), 'replicaSet', 3)
    mountApp(ConnectionTab, { props: { connectionId: 'c1' } })
    await flushPromises()
    expect(document.querySelector('[data-health]')?.textContent).toContain('7 ms')
    expect(document.querySelector('header')?.textContent).toContain('MongoDB 8.0.4')
    expect(document.querySelector('[data-alerts-firing]')?.textContent).toContain('3 alerts firing')
  })
})

// Design 2026-10-25 (B7; review M6): the section the page shows — not one kept that it cannot show —
// is what the assistant is told the person is on.
describe('the section shown, for the assistant', () => {
  it('says the section shown, its overview when the kept one cannot be shown', async () => {
    const { useTabSectionsStore } = await import('../src/stores/tabSections')
    const sections = useTabSectionsStore()
    sections.set('t1', 'databaseAccess')
    api(connection(['databases:read', 'server:monitor', 'databases:admin']))
    mountApp(ConnectionTab, { props: { connectionId: 'c1', tabId: 't1' } })
    await flushPromises()
    expect(sections.getValue('t1', 'shown', '')).toBe('databaseAccess')
    document.body.innerHTML = ''
    // Without the right to it, the page shows its overview: that is what is said.
    sections.set('t2', 'databaseAccess')
    api(connection(['databases:read', 'server:monitor']))
    mountApp(ConnectionTab, { props: { connectionId: 'c1', tabId: 't2' } })
    await flushPromises()
    expect(sections.getValue('t2', 'shown', '')).toBe('overview')
  })
})
