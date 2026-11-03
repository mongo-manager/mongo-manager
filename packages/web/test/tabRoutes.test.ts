import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createMemoryHistory } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'
import WorkspaceView from '../src/views/WorkspaceView.vue'
import { createAppRouter } from '../src/router'
import { safeNext, tabInputFromRoute, tabLocation } from '../src/workspace/tabRoutes'
import { i18n } from '../src/i18n'
import { useTabsStore } from '../src/stores/tabs'
import { useToastStore } from '../src/stores/toasts'
import { mockApi, mountApp } from './support/app'

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const connection = (id: string, name: string) => ({
  id,
  name,
  group: null,
  color: null,
  favorite: false,
  readOnly: false,
  access: 'admin',
  permissions: [],
})

function api(extra: Record<string, () => [number, unknown]> = {}) {
  return mockApi({
    'GET auth/status': () => [200, { mode: 'local', setupRequired: false, authenticated: true }],
    'GET auth/me': () => [
      200,
      {
        mode: 'local',
        user: { id: 'local', username: 'owner', role: 'admin' },
        permissions: [],
        csrfToken: 'c',
        readOnly: false,
        twoFactor: {},
      },
    ],
    'GET connections': () => [200, [connection('c1', 'Prod')]],
    ...extra,
  })
}

async function open(path: string) {
  const router = createAppRouter(createMemoryHistory())
  await router.push(path)
  mountApp(WorkspaceView, { plugins: [router] })
  await flushPromises()
  await flushPromises()
  return router
}

describe('tab paths (phase 1g-2, Review Focus 1)', () => {
  it('round-trips database and collection names exactly', async () => {
    api()
    const router = createAppRouter(createMemoryHistory())
    for (const [db, coll] of [
      ['shop', 'orders'],
      ['a/b', 'c?d#e'],
      ['100%', 'x.y z'],
      ['şehir', 'çöp'],
    ] as const) {
      const location = tabLocation({
        id: 'x',
        kind: 'collection',
        title: '',
        params: { connectionId: 'c1', db, coll },
      })
      const route = router.resolve(location)
      expect(tabInputFromRoute(router.resolve(route.fullPath))).toEqual({
        kind: 'collection',
        title: `${db}.${coll}`,
        params: { connectionId: 'c1', db, coll },
      })
    }
  })

  it('accepts only internal paths after sign-in', () => {
    expect(safeNext('/c/c1/db/shop')).toBe('/c/c1/db/shop')
    for (const bad of [
      '//evil.example',
      'https://evil.example',
      '/\\evil.example',
      'javascript:alert(1)',
      '',
      42,
      null,
    ])
      expect(safeNext(bad), String(bad)).toBeNull()
  })
})

describe('the URL follows the tabs and the tabs follow the URL', () => {
  it('opens a collection tab from a deep link', async () => {
    api()
    await open('/c/c1/db/shop/coll/orders')
    expect(useTabsStore().active).toMatchObject({
      kind: 'collection',
      params: { connectionId: 'c1', db: 'shop', coll: 'orders' },
    })
  })

  it('names a connection tab from the connection list', async () => {
    api()
    await open('/c/c1')
    expect(useTabsStore().active).toMatchObject({ kind: 'connection', title: 'Prod' })
  })

  it('pushes each activated tab, so back and forward switch tabs', async () => {
    api()
    const router = await open('/')
    const tabs = useTabsStore()
    tabs.open({ kind: 'database', title: 'shop', params: { connectionId: 'c1', db: 'shop' } })
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/c/c1/db/shop')
    tabs.open({ kind: 'account', title: '' })
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/account')
    router.back()
    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/c/c1/db/shop'))
    await flushPromises()
    expect(tabs.active?.kind).toBe('database')
  })

  it('opens nothing for a connection the user cannot see, and says so', async () => {
    api()
    const router = await open('/c/secret/db/hr/coll/salaries')
    expect(useTabsStore().tabs.some((t) => t.params.connectionId === 'secret')).toBe(false)
    expect(router.currentRoute.value.fullPath).toBe('/')
    expect(useToastStore().toasts.at(-1)?.message).toBe('This link points to a connection you cannot open.')
  })
})

describe('sign-in returns to the link', () => {
  it('keeps the requested path through the login redirect', async () => {
    mockApi({
      'GET auth/status': () => [200, { mode: 'team', setupRequired: false, authenticated: false }],
    })
    const router = createAppRouter(createMemoryHistory())
    await router.push('/c/c1/db/shop')
    expect(router.currentRoute.value.name).toBe('login')
    expect(router.currentRoute.value.query.next).toBe('/c/c1/db/shop')
  })
})

describe('route sync: final review 1g-2', () => {
  it('keeps working when the connection list fails, and never opens the link late (Minor 1)', async () => {
    api({ 'GET connections': () => [500, { code: 'INTERNAL', message: 'x' }] })
    const router = await open('/c/c1/db/shop')
    const tabs = useTabsStore()
    expect(tabs.tabs.some((t) => t.kind === 'database')).toBe(false)
    expect(useToastStore().toasts.at(-1)?.message).toBe('This link points to a connection you cannot open.')
    tabs.open({ kind: 'account', title: '' })
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/account')
  })

  it('replaces a non-canonical link with the canonical one instead of adding a history step (Minor 2)', async () => {
    api()
    const router = createAppRouter(createMemoryHistory())
    await router.push('/')
    mountApp(WorkspaceView, { plugins: [router] })
    await flushPromises()
    await router.push('/c/c1/db/sh%6Fp/')
    await flushPromises()
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/c/c1/db/shop')
    router.back()
    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/'))
  })

  it('drops a malformed stored tab instead of failing to load (Minor 3)', async () => {
    localStorage.setItem(
      'mm:tabs',
      JSON.stringify({
        tabs: [
          { id: 'bad', kind: 'collection', title: 'x', params: {} },
          { id: 'worse', kind: 'database', title: 'y' },
          { id: 'ok', kind: 'database', title: 'shop', params: { connectionId: 'c1', db: 'shop' } },
        ],
        activeId: 'bad',
        owner: 'local',
      }),
    )
    api()
    await open('/')
    expect(useTabsStore().tabs.map((t) => t.id)).toEqual(['ok'])
  })

  it('opens the users and audit tabs from a link only with their permission (Minor 4)', async () => {
    api()
    const router = await open('/users')
    expect(useTabsStore().tabs.some((t) => t.kind === 'users')).toBe(false)
    expect(router.currentRoute.value.fullPath).toBe('/')
    await router.push('/audit')
    await flushPromises()
    expect(useTabsStore().tabs.some((t) => t.kind === 'audit')).toBe(false)
  })
})

describe('AI history links (user, 2026-10-09)', () => {
  const R = '00000000-0000-4000-8000-000000000001'
  it('names the request shown in the URL, and opens it from the URL', () => {
    expect(tabInputFromRoute({ name: 'aiHistoryRequest', params: { requestId: R } })).toEqual({
      kind: 'aiHistory',
      title: '',
      params: { requestId: R },
    })
    expect(tabLocation({ id: 'aiHistory:', kind: 'aiHistory', title: '', params: { requestId: R } })).toEqual(
      {
        name: 'aiHistoryRequest',
        params: { requestId: R },
      },
    )
    expect(tabLocation({ id: 'aiHistory:', kind: 'aiHistory', title: '', params: {} })).toEqual({
      name: 'aiHistory',
    })
    // A request id is a UUID: anything else is no request.
    expect(tabInputFromRoute({ name: 'aiHistoryRequest', params: { requestId: '../x' } })).toEqual({
      kind: 'aiHistory',
      title: '',
    })
    const router = createAppRouter(createMemoryHistory())
    expect(router.resolve(`/ai-history/${R}`).name).toBe('aiHistoryRequest')
  })
})

describe('AI history links and the browser history (page review)', () => {
  const R1 = '00000000-0000-4000-8000-0000000000a1'
  const R2 = '00000000-0000-4000-8000-0000000000a2'

  it('opens the request a URL names, on a reload too', async () => {
    api()
    await open(`/ai-history/${R1}`)
    expect(useTabsStore().active).toMatchObject({ kind: 'aiHistory', params: { requestId: R1 } })
  })

  it('pushes each request shown, so back and forward move between them', async () => {
    api()
    const router = await open('/')
    const tabs = useTabsStore()
    const id = tabs.open({ kind: 'aiHistory', title: '' })
    await flushPromises()
    tabs.setView(id, { requestId: R1 })
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe(`/ai-history/${R1}`)
    tabs.setView(id, { requestId: R2 })
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe(`/ai-history/${R2}`)
    router.back()
    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe(`/ai-history/${R1}`))
    await flushPromises()
    expect(tabs.active?.params).toEqual({ requestId: R1 })
  })

  it('shows the list for a link to no request, adding no history step', async () => {
    api()
    const router = await open('/')
    await router.push('/ai-history/foo')
    await flushPromises()
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/ai-history')
    router.back()
    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/'))
  })

  it('still moves the URL to the AI history later, after a link to it was opened as it is', async () => {
    api()
    const router = await open('/ai-history')
    const tabs = useTabsStore()
    tabs.open({ kind: 'account', title: '' })
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/account')
    tabs.open({ kind: 'aiHistory', title: '' })
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/ai-history')
  })

  it('takes an upper-case request id as the same request', () => {
    expect(tabInputFromRoute({ name: 'aiHistoryRequest', params: { requestId: R1.toUpperCase() } })).toEqual({
      kind: 'aiHistory',
      title: '',
      params: { requestId: R1 },
    })
  })
})

// User request 2026-10-10: a plugin's page has an address; only ids as plugins name them, a collection whole.
describe('the plugin page address', () => {
  const route = (params: Record<string, string>) => ({ name: 'pluginPage', params })

  it('reads a plugin page, on a collection or none, and writes it back', () => {
    const on = tabInputFromRoute(
      route({
        plugin: 'geo-map',
        contribution: 'map',
        connectionId: 'c1',
        db: 'shop',
        coll: 'orders',
      }),
    )
    expect(on).toEqual({
      kind: 'pluginPage',
      title: '',
      params: {
        plugin: 'geo-map',
        contribution: 'map',
        connectionId: 'c1',
        db: 'shop',
        coll: 'orders',
      },
    })
    expect(tabLocation({ id: 'x', ...on!, params: on!.params! })).toEqual({
      name: 'pluginPage',
      params: {
        plugin: 'geo-map',
        contribution: 'map',
        connectionId: 'c1',
        db: 'shop',
        coll: 'orders',
      },
    })
    expect(tabInputFromRoute(route({ plugin: 'geo-map', contribution: 'map' }))!.params).toEqual({
      plugin: 'geo-map',
      contribution: 'map',
    })
  })

  it('refuses ids no plugin could have, and a collection given in part', () => {
    expect(tabInputFromRoute(route({ plugin: '../x', contribution: 'sql' }))).toBeNull()
    expect(tabInputFromRoute(route({ plugin: 'Sql', contribution: 'sql' }))).toBeNull()
    expect(tabInputFromRoute(route({ plugin: 'sql', contribution: '__proto__' }))).toBeNull()
    expect(
      tabInputFromRoute(route({ plugin: 'sql', contribution: 'sql', connectionId: 'c1', db: 'shop' }))!
        .params,
    ).toEqual({
      plugin: 'sql',
      contribution: 'sql',
    })
  })

  it('keeps one page a plugin entry, on the collection it shows; a stored bad name is dropped', () => {
    const tabs = useTabsStore()
    tabs.open({
      kind: 'pluginPage',
      title: '',
      params: { plugin: 'p', contribution: 'c', connectionId: 'c1', db: 'a', coll: 'x' },
    })
    tabs.open({
      kind: 'pluginPage',
      title: '',
      params: { plugin: 'p', contribution: 'c', connectionId: 'c1', db: 'b', coll: 'y' },
    })
    expect(tabs.tabs.filter((t) => t.kind === 'pluginPage')).toHaveLength(1)
    expect(tabs.active!.params).toMatchObject({ db: 'b', coll: 'y' })
    // What was kept, with a name no database can have written into it, comes back without it.
    const kept = JSON.parse(localStorage.getItem('mm:tabs')!) as {
      tabs: Array<{ kind: string; params: Record<string, string> }>
    }
    kept.tabs.find((t) => t.kind === 'pluginPage')!.params.db = 'a\u0000b'
    localStorage.setItem('mm:tabs', JSON.stringify(kept))
    setActivePinia(createPinia())
    const restored = useTabsStore().tabs.find((t) => t.kind === 'pluginPage')!
    // Review M2: a collection only whole — a part of it gone, all of it goes.
    expect(restored.params).toEqual({ plugin: 'p', contribution: 'c' })
  })
})

describe('plugin page tabs in the store (review 2026-10-10)', () => {
  const page = {
    kind: 'pluginPage',
    title: '',
    params: { plugin: 'p', contribution: 'c', connectionId: 'c1', db: 'shop', coll: 'orders' },
  }

  it('leaves the collection a page was on when it goes, instead of closing the page (I4)', () => {
    const tabs = useTabsStore()
    tabs.open({ kind: 'collection', title: 'x', params: { connectionId: 'c1', db: 'shop', coll: 'orders' } })
    tabs.open(page)
    tabs.closeWhere(
      (t) => t.params.connectionId === 'c1' && t.params.db === 'shop' && t.params.coll === 'orders',
    )
    expect(tabs.tabs.map((t) => t.kind)).toEqual(['pluginPage'])
    expect(tabs.tabs[0]!.params).toEqual({ plugin: 'p', contribution: 'c' })
  })

  it('drops a kept page whose ids no plugin could have (M1), and cleans what a link gives (M3)', () => {
    const tabs = useTabsStore()
    tabs.open({
      kind: 'pluginPage',
      title: '',
      params: { plugin: 'p', contribution: 'c', connectionId: 'c1', db: 'a\u0000', coll: 'x' },
    })
    expect(tabs.active!.params).toEqual({ plugin: 'p', contribution: 'c' })
    const kept = JSON.parse(localStorage.getItem('mm:tabs')!) as {
      tabs: Array<{ kind: string; params: Record<string, string> }>
    }
    kept.tabs[0]!.params.plugin = '\u202Eevil'
    localStorage.setItem('mm:tabs', JSON.stringify(kept))
    setActivePinia(createPinia())
    expect(useTabsStore().tabs.some((t) => t.kind === 'pluginPage')).toBe(false)
  })
})

describe('a plugin details page address (user request 2026-10-10)', () => {
  it('reads /plugins/:pluginId, only an id a plugin could have', () => {
    expect(tabInputFromRoute({ name: 'pluginDetails', params: { pluginId: 'sql-to-mongodb' } })).toEqual({
      kind: 'pluginDetails',
      title: '',
      params: { pluginId: 'sql-to-mongodb' },
    })
    expect(tabInputFromRoute({ name: 'pluginDetails', params: { pluginId: '../etc' } })).toBeNull()
    expect(tabLocation({ id: 'x', kind: 'pluginDetails', title: '', params: { pluginId: 'p' } })).toEqual({
      name: 'pluginDetails',
      params: { pluginId: 'p' },
    })
  })
})
