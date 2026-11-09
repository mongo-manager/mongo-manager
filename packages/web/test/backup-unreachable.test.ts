// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createMemoryHistory } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'
import { computed, h, ref } from 'vue'
import { PERMISSIONS, type DumpPlan } from '@mongo-manager/shared'
import WorkspaceView from '../src/views/WorkspaceView.vue'
import DialogHost from '../src/ds/DsConfirmHost.vue'
import BackupsCard from '../src/backup/BackupsCard.vue'
import BackupDumpSheet from '../src/backup/BackupDumpSheet.vue'
import ConnectionTab from '../src/workspace/tabs/ConnectionTab.vue'
import DatabaseTab from '../src/workspace/tabs/DatabaseTab.vue'
import CollectionTab from '../src/workspace/tabs/CollectionTab.vue'
import TestResultView from '../src/connections/TestResultView.vue'
import { ApiError } from '../src/api/client'
import { queryKeys } from '../src/api/connections'
import {
  cannotReach,
  connectedIn,
  connectedNow,
  forgetAnswer,
  passesByItself,
  REREAD_UNREACHABLE_MS,
  useConnected,
} from '../src/connections/reachability'
import { onlineManager } from '@tanstack/vue-query'
import { describeError } from '../src/api/errors'
import { useRestorePlan } from '../src/backup/useRestorePlan'
import { createAppRouter } from '../src/router'
import { i18n } from '../src/i18n'
import { useCommandsStore } from '../src/stores/commands'
import { useTabsStore } from '../src/stores/tabs'
import { useToastStore } from '../src/stores/toasts'
import { useSessionStore } from '../src/stores/session'
import { useWorkspaceDialogs } from '../src/stores/workspaceDialogs'
import { mockApi, mountApp, type Handler } from './support/app'
import { button } from './support/dom'

/**
 * User reports 2026-10-23: a connection whose server could not be reached timed out, and still offered
 * "Start backup" (and "Take the first backup", "New database", its Performance, Watch, Users and roles
 * and Alerts sections); the sheet opened. What needs the server is not shown until the connection's
 * databases were read, neither while connecting nor while the last read failed; a sheet opened some
 * other way says so and starts nothing.
 */
const TIMEOUT: [number, unknown] = [
  502,
  { code: 'MONGO_ERROR', message: 'Server selection timed out after 30000 ms', details: { kind: 'timeout' } },
]
const DATABASES = { databases: [{ name: 'shop', sizeOnDisk: 2, empty: false }], totalSize: 2 }
const PASSED = [200, { ok: true, serverVersion: '8.0.4', topology: 'standalone', latencyMs: 3 }] as const

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('what says the app cannot work with a server', () => {
  const mongo = (kind: unknown, status = 502) => new ApiError(status, 'MONGO_ERROR', 'x', { kind })
  it('is a failed open or a lost connection, whatever its reason', () => {
    for (const kind of ['network', 'timeout', 'dns', 'tls', 'auth', 'ssh', 'ssh-host-key', 'config', 'oidc'])
      expect(cannotReach(mongo(kind)), kind).toBe(true)
    // A server older than the app supports is never reached either.
    expect(cannotReach(new ApiError(422, 'UNSUPPORTED_SERVER', 'x', { kind: 'unsupported' }))).toBe(true)
  })
  it('is a server, a shard or a primary not available (503, with MongoDB’s code)', () => {
    expect(cannotReach(new ApiError(503, 'MONGO_ERROR', 'x', { code: 133, codeName: 'X' }))).toBe(true)
    // ...but not a pool all busy for now.
    expect(cannotReach(mongo('pool', 503))).toBe(false)
  })
  it('is not a busy pool, an open the app itself stopped, or any other refusal', () => {
    for (const kind of ['busy', 'closed', 'pool', undefined, 3])
      expect(cannotReach(mongo(kind)), String(kind)).toBe(false)
    expect(cannotReach(new ApiError(403, 'FORBIDDEN', 'x'))).toBe(false)
    expect(cannotReach(new ApiError(504, 'MONGO_ERROR', 'The operation exceeded its time limit'))).toBe(false)
    expect(cannotReach(new Error('fetch failed'))).toBe(false)
    expect(cannotReach(null)).toBe(false)
  })
})

describe("a connection's last answer", () => {
  const mounted = () =>
    mountApp({
      setup: () => () => h('div'),
    }).queryClient
  const fail = (queryClient: ReturnType<typeof mounted>, e: unknown) =>
    queryClient
      .fetchQuery({
        queryKey: queryKeys.databases('c1'),
        queryFn: () => Promise.reject(e),
        retry: false,
      })
      .catch(() => undefined)

  it('is read from what the cache already holds (fourth review, nit)', () => {
    const queryClient = mounted()
    queryClient.setQueryData(queryKeys.databases('c1'), DATABASES)
    expect(connectedIn(queryClient, 'c1')).toBe(true)
  })

  // The cache tells of an answer a moment later (notifyManager batches on a timer).
  const told = () => new Promise((resolve) => setTimeout(resolve, 0))

  it('stands when the app stopped an open itself or its own server did not answer (M1)', async () => {
    const queryClient = mounted()
    connectedIn(queryClient, 'c1')
    await fail(queryClient, new ApiError(502, 'MONGO_ERROR', 'x', { kind: 'timeout' }))
    await told()
    expect(connectedIn(queryClient, 'c1')).toBe(false)
    await fail(queryClient, new ApiError(502, 'MONGO_ERROR', 'edited', { kind: 'closed' }))
    await told()
    expect(connectedIn(queryClient, 'c1')).toBe(false)
    await fail(queryClient, new TypeError('Failed to fetch'))
    await told()
    expect(connectedIn(queryClient, 'c1')).toBe(false)
    // Any other answer is the server's: connected.
    await fail(queryClient, new ApiError(403, 'FORBIDDEN', 'x'))
    await told()
    expect(connectedIn(queryClient, 'c1')).toBe(true)
  })

  it('is nothing a removed query says afterwards (M2), and forgotten on demand (I2)', async () => {
    const queryClient = mounted()
    connectedIn(queryClient, 'c1')
    queryClient.setQueryData(queryKeys.databases('c1'), DATABASES)
    await told()
    const query = queryClient.getQueryCache().find({ queryKey: queryKeys.databases('c1'), exact: true })!
    queryClient.removeQueries({ queryKey: queryKeys.databases('c1'), exact: true })
    await told()
    expect(connectedIn(queryClient, 'c1')).toBe(false)
    query.setData(DATABASES)
    await told()
    expect(connectedIn(queryClient, 'c1')).toBe(false)
    queryClient.setQueryData(queryKeys.databases('c1'), DATABASES)
    await told()
    expect(connectedIn(queryClient, 'c1')).toBe(true)
    forgetAnswer(queryClient, 'c1')
    expect(connectedIn(queryClient, 'c1')).toBe(false)
  })

  it('is not read for while offline: the palette refuses at once (M3)', async () => {
    const queryClient = mounted()
    const read = vi.fn()
    onlineManager.setOnline(false)
    try {
      expect(await connectedNow(queryClient, 'c1', read)).toBe(false)
    } finally {
      onlineManager.setOnline(true)
    }
    expect(read).not.toHaveBeenCalled()
  })

  it('says how a sign-in the server keeps refusing is tried again (fourth review, I1)', () => {
    const kept = new ApiError(502, 'MONGO_ERROR', 'x', { kind: 'auth', remembered: true })
    expect(describeError(kept, i18n.global.t)).toBe(
      'MongoDB rejected the username or password. Mongo Manager does not try again for up to five minutes, or until the connection is edited or a connection test passes (or, on a connection where each person signs in with their own account, until you sign in again).',
    )
    expect(describeError(new ApiError(502, 'MONGO_ERROR', 'x', { kind: 'auth' }), i18n.global.t)).toBe(
      'MongoDB rejected the username or password.',
    )
  })

  it('is kept as it settles, and forgotten with its query', async () => {
    let connected: ReturnType<typeof useConnected> | undefined
    const { queryClient } = mountApp({
      setup() {
        connected = useConnected('c1')
        return () => h('div')
      },
    })
    expect(connected!.value).toBe(false)
    queryClient.setQueryData(queryKeys.databases('c1'), DATABASES)
    await flushPromises()
    expect(connected!.value).toBe(true)
    queryClient.removeQueries({ queryKey: queryKeys.databases('c1'), exact: true })
    await flushPromises()
    expect(connected!.value).toBe(false)
  })
})

describe('what is read again unasked (third review, I3)', () => {
  const answer = (kind: string, status = 502) => new ApiError(status, 'MONGO_ERROR', 'x', { kind })
  it('is what passes by itself: the network, a timeout, DNS, a server not available', () => {
    for (const kind of ['network', 'timeout', 'dns']) expect(passesByItself(answer(kind)), kind).toBe(true)
    expect(passesByItself(new ApiError(503, 'MONGO_ERROR', 'x', { code: 133 }))).toBe(true)
  })
  it('is never a sign-in refused, settings, a host key or a server too old', () => {
    for (const kind of ['auth', 'oidc', 'config', 'ssh', 'ssh-host-key', 'tls', 'encryption'])
      expect(passesByItself(answer(kind)), kind).toBe(false)
    expect(passesByItself(new ApiError(422, 'UNSUPPORTED_SERVER', 'x', { kind: 'unsupported' }))).toBe(false)
    expect(passesByItself(new ApiError(500, 'INTERNAL', 'x'))).toBe(false)
  })
})

const conn = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  group: null,
  color: null,
  favorite: false,
  readOnly: false,
  settings: {},
  uri: `mongodb://${id}`,
  createdAt: 0,
  updatedAt: 0,
  lastUsedAt: null,
  access: 'admin',
  permissions: [...PERMISSIONS],
  export: true,
  shell: true,
  ...extra,
})

async function workspace(handlers: Record<string, Handler>) {
  const api = mockApi({
    'GET auth/status': () => [200, { mode: 'local', setupRequired: false, authenticated: true }],
    'GET auth/me': () => [
      200,
      {
        mode: 'local',
        user: { id: 'local', username: 'owner', role: 'admin' },
        permissions: [...PERMISSIONS],
        csrfToken: 'c',
        readOnly: false,
        twoFactor: {},
      },
    ],
    'GET connections': () => [200, [conn('c1', 'Prod')]],
    ...handlers,
  })
  const router = createAppRouter(createMemoryHistory())
  await router.push('/')
  const { queryClient } = mountApp(WorkspaceView, { plugins: [router] })
  mountApp(DialogHost)
  await flushPromises()
  return { ...api, queryClient }
}
const item = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="treeitem"]')].find(
    (i) => i.getAttribute('aria-label') === label,
  )!
const expand = async (label: string) => {
  item(label).querySelector<HTMLElement>(':scope > div')!.click()
  await flushPromises()
}
const menuOf = async (label: string) => {
  document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click()
  await flushPromises()
}
const closeMenu = async () => {
  document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await flushPromises()
  expect(document.querySelector('[role="menuitem"]')).toBeNull()
}
const entries = () => [...document.querySelectorAll('[role="menuitem"]')].map((m) => m.textContent?.trim())
const entry = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (m) => m.textContent?.trim() === label,
  )!
const SERVER_ITEMS = ['Open shell', 'New database', 'Back up server…', 'Restore…']

describe('the palette on a server that cannot be reached (second review, M1)', () => {
  it('opens no shell, watch, import, export, copy, compare or live sync there', async () => {
    const { queryClient } = await workspace({
      'GET connections/c1/databases': () => TIMEOUT,
      'GET connections/c1/databases/shop/collections': () => [
        200,
        [{ name: 'orders', type: 'collection', options: {} }],
      ],
    })
    await queryClient.fetchQuery({ queryKey: queryKeys.databases('c1') }).catch(() => undefined)
    const tabs = useTabsStore()
    tabs.open({
      kind: 'collection',
      title: 'orders',
      params: { connectionId: 'c1', db: 'shop', coll: 'orders' },
    })
    await flushPromises()
    const ids = [
      'shell.open',
      'shell.open:c1',
      'watch.open',
      'data.import',
      'data.export',
      'data.exportSql',
      'data.copy',
      'data.compare',
      'data.liveSync',
    ]
    const commands = useCommandsStore()
    const push = vi.spyOn(useToastStore(), 'push')
    for (const id of ids) {
      await commands.commands.find((c) => c.id === id)!.run()
      await flushPromises()
    }
    expect(tabs.tabs.some((x) => x.kind === 'shell' || x.kind === 'sqlTransfer')).toBe(false)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    // Each reads the databases again (saying so), then refuses by the connection's name.
    expect(push.mock.calls.map(([x]) => x.message)).toEqual(
      ids.flatMap(() => ['Connecting to Prod…', 'No connection to Prod']),
    )
  })

  it('reads them again when its last answer said the server cannot be reached, and opens it', async () => {
    let up = false
    const { queryClient } = await workspace({
      'GET connections/c1/databases': () => (up ? [200, DATABASES] : TIMEOUT),
    })
    await queryClient.fetchQuery({ queryKey: queryKeys.databases('c1') }).catch(() => undefined)
    up = true
    const push = vi.spyOn(useToastStore(), 'push')
    await useCommandsStore()
      .commands.find((c) => c.id === 'shell.open:c1')!
      .run()
    await flushPromises()
    expect(useTabsStore().tabs.map((x) => x.kind)).toContain('shell')
    expect(push.mock.calls.map(([x]) => [x.kind, x.message])).toEqual([['info', 'Connecting to Prod…']])
  })

  it('reads the databases first when nothing has, and then opens it', async () => {
    const { calls } = await workspace({ 'GET connections/c1/databases': () => [200, DATABASES] })
    useTabsStore().open({ kind: 'connection', title: 'Prod', params: { connectionId: 'c1' } })
    useTabsStore().open({ kind: 'jobs', title: '' })
    await useCommandsStore()
      .commands.find((c) => c.id === 'shell.open:c1')!
      .run()
    await flushPromises()
    expect(calls.some((c) => c.path === 'connections/c1/databases')).toBe(true)
    // Connected now: the next command asks nothing again (one "Connecting" in all).
    await useCommandsStore()
      .commands.find((c) => c.id === 'shell.open:c1')!
      .run()
    expect(useTabsStore().tabs.map((x) => x.kind)).toContain('shell')
    // It said "Connecting" while it read, and no longer once the server answered (fourth review, M3).
    expect(useToastStore().toasts).toEqual([])
  })
})

describe('a connection in the tree (user reports 2026-10-23)', () => {
  it('offers what needs its server only once connected, as Compass', async () => {
    let up = false
    await workspace({ 'GET connections/c1/databases': () => (up ? [200, DATABASES] : TIMEOUT) })
    // Not connected yet (collapsed): only what needs no server.
    await menuOf('Actions for Prod')
    for (const label of SERVER_ITEMS) expect(entries(), label).not.toContain(label)
    expect(entries()).toContain('Test connection')
    expect(entries()).toContain('Edit')
    await closeMenu()
    // Its server cannot be reached: still nothing that needs it.
    await expand('Prod')
    await menuOf('Actions for Prod')
    for (const label of SERVER_ITEMS) expect(entries(), label).not.toContain(label)
    await closeMenu()
    up = true
    button('Retry').click()
    await flushPromises()
    await menuOf('Actions for Prod')
    for (const label of SERVER_ITEMS) expect(entries(), label).toContain(label)
  })

  it('shows no database of an earlier read while the last one failed', async () => {
    let up = true
    await workspace({ 'GET connections/c1/databases': () => (up ? [200, DATABASES] : TIMEOUT) })
    await expand('Prod')
    expect(item('shop')).toBeDefined()
    up = false
    await menuOf('Actions for Prod')
    entry('Refresh').click()
    await flushPromises()
    expect(item('shop')).toBeUndefined()
    expect(item('Prod').querySelector('[role="alert"]')).not.toBeNull()
  })

  it('a passing test reads its databases again, so what needs the server comes back', async () => {
    let up = false
    const { calls } = await workspace({
      'GET connections/c1/databases': () => (up ? [200, DATABASES] : TIMEOUT),
      'POST connections/c1/test': () => [...PASSED],
    })
    await expand('Prod')
    up = true
    const before = calls.filter((c) => c.path === 'connections/c1/databases').length
    await menuOf('Actions for Prod')
    entry('Test connection').click()
    await flushPromises()
    expect(calls.filter((c) => c.path === 'connections/c1/databases').length).toBeGreaterThan(before)
    await menuOf('Actions for Prod')
    expect(entries()).toContain('Back up server…')
  })

  it('the palette backs up or restores nothing there, and says why', async () => {
    const { queryClient } = await workspace({ 'GET connections/c1/databases': () => TIMEOUT })
    await queryClient.fetchQuery({ queryKey: queryKeys.databases('c1') }).catch(() => undefined)
    useTabsStore().open({ kind: 'connection', title: 'Prod', params: { connectionId: 'c1' } })
    await flushPromises()
    const commands = useCommandsStore()
    for (const id of ['backup.dump', 'backup.restore']) {
      await commands.commands.find((c) => c.id === id)!.run()
      await flushPromises()
    }
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(
      useToastStore()
        .toasts.filter((x) => x.kind === 'error')
        .map((x) => x.message),
    ).toEqual(['No connection to Prod', 'No connection to Prod'])
  })
})

const ALL = ['documents:read', 'documents:write', 'databases:write', 'jobs:run', 'data:export']
const FULL = { ...conn('c1', 'Prod'), permissions: [...ALL, 'server:monitor', 'databases:admin'] }
const KEPT = {
  id: 'b1',
  name: 'shop.mmbak',
  jobId: 'j1',
  connectionId: 'c1',
  scope: { kind: 'database', db: 'shop', views: true },
  engine: 'builtin',
  format: 'mmbak',
  masked: false,
  anonymous: false,
  size: 5,
  sha256: 'x',
  namespaces: 1,
  startedAt: 1,
  finishedAt: 2,
  expiresAt: Date.now() + 3600_000,
  copies: [],
}
const SECTIONS = () => [...document.querySelectorAll('[role="tab"]')].map((x) => x.textContent?.trim())
const tab = (name: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find((x) => x.textContent?.trim() === name)!

describe("a connection's tab (user reports 2026-10-23)", () => {
  it('shows only its overview, with the error, until its databases are read', async () => {
    let up = false
    mockApi({
      'GET connections': () => [200, [FULL]],
      'GET connections/c1/databases': () => (up ? [200, DATABASES] : TIMEOUT),
      'GET backups': () => [200, []],
      'GET backups/usage': () => [200, { used: 0, quota: 1024 ** 3, ttlHours: 24 }],
      'POST connections/c1/test': () => [...PASSED],
    })
    mountApp(ConnectionTab, { props: { connectionId: 'c1' } })
    // Connecting: nothing that needs the server yet.
    expect(document.body.textContent).not.toContain('Backups')
    await flushPromises()
    const text = () => document.body.textContent ?? ''
    // Its overview alone: no Performance, Watch, Users and roles or Alerts to switch to.
    expect(SECTIONS()).toEqual([])
    expect(text()).toContain('The server did not answer in time.')
    for (const gone of [
      'New database',
      'Shell',
      'Start backup',
      'Take the first backup',
      'Backups',
      'Personal data',
    ])
      expect(text(), gone).not.toContain(gone)
    await menuOf('More actions for Prod')
    expect(entries()).not.toContain('Back up server…')
    expect(entries()).toEqual(['Test connection', 'Refresh'])
    up = true
    entry('Test connection').click()
    await flushPromises()
    await flushPromises()
    expect(SECTIONS()).toEqual(expect.arrayContaining(['Overview', 'Performance', 'Watch', 'Users & roles']))
    expect(button('New database')).toBeDefined()
    // Backups is a tab of its own now (user request 2026-10-23).
    expect(SECTIONS()).toContain('Backups')
    await menuOf('More actions for Prod')
    expect(entries()).toContain('Back up server…')
  })
  it('shows only its overview while it connects', async () => {
    let answer: (v: [number, unknown]) => void = () => {}
    mockApi({
      'GET connections': () => [200, [FULL]],
      'GET connections/c1/databases': () => new Promise((resolve) => (answer = resolve)),
      'GET backups': () => [200, []],
      'GET backups/usage': () => [200, { used: 0, quota: 1024 ** 3, ttlHours: 24 }],
    })
    mountApp(ConnectionTab, { props: { connectionId: 'c1' } })
    await flushPromises()
    // The connection is known (its permissions allow all this), its databases not read yet.
    expect(document.body.textContent).toContain('Prod')
    expect(SECTIONS()).toEqual([])
    // Nor a total size read before, nor the personal-data rules (user report, second review N1).
    for (const gone of ['New database', 'Shell', 'Take the first backup', 'Total size', 'Personal data'])
      expect(document.body.textContent, gone).not.toContain(gone)
    answer([200, DATABASES])
    await flushPromises()
    expect(SECTIONS()).toContain('Performance')
    expect(SECTIONS()).toContain('Backups')
  })

  it('keeps its sections when a later read is answered by a busy pool', async () => {
    let busy = false
    mockApi({
      'GET connections': () => [200, [FULL]],
      'GET connections/c1/databases': () =>
        busy
          ? [
              503,
              { code: 'MONGO_ERROR', message: 'No connection was free in time', details: { kind: 'pool' } },
            ]
          : [200, DATABASES],
      'GET backups': () => [200, []],
      'GET backups/usage': () => [200, { used: 0, quota: 1024 ** 3, ttlHours: 24 }],
    })
    mountApp(ConnectionTab, { props: { connectionId: 'c1' } })
    await flushPromises()
    busy = true
    await menuOf('More actions for Prod')
    entry('Refresh').click()
    await flushPromises()
    expect(SECTIONS()).toContain('Performance')
    expect(SECTIONS()).toContain('Backups')
  })

  it('reads its databases once when the server answers them with another error', async () => {
    // A 500 (or a right refused) is the server answering: connected, so its Backups section and its
    // Users and roles open. Opening them must not read them again: that read would be pending, hide
    // what opened it, fail, show it again, and so on for ever (it ran the tests out of memory).
    let reads = 0
    const { calls } = mockApi({
      'GET connections': () => [200, [FULL]],
      'GET connections/c1/databases': () =>
        ++reads > 3 ? new Promise(() => {}) : [500, { code: 'INTERNAL', message: 'down' }],
      'GET backups': () => [200, []],
      'GET backups/usage': () => [200, { used: 0, quota: 1024 ** 3, ttlHours: 24 }],
    })
    mountApp(ConnectionTab, { props: { connectionId: 'c1' } })
    for (let i = 0; i < 5; i++) await flushPromises()
    expect(SECTIONS()).toContain('Backups')
    tab('Users & roles').click()
    // Under a full run's load the section's lazy view can take longer than a second to come.
    await vi.waitFor(() => expect(document.body.textContent).toContain('Custom roles'), { timeout: 10_000 })
    for (let i = 0; i < 5; i++) await flushPromises()
    expect(calls.filter((c) => c.path === 'connections/c1/databases').length).toBe(1)
    expect(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim()).toBe(
      'Users & roles',
    )
  })

  it('keeps the error, Retry and Edit while it reads them again (third review, I2)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let reads = 0
    mockApi({
      'GET connections': () => [200, [FULL]],
      'GET connections/c1/databases': () => (++reads === 1 ? TIMEOUT : new Promise(() => {})),
    })
    useSessionStore().me = { permissions: [...PERMISSIONS] } as never
    mountApp(ConnectionTab, { props: { connectionId: 'c1' } })
    await flushPromises()
    expect(document.body.textContent).toContain('The server did not answer in time.')
    // The reread starts and does not answer yet.
    await vi.advanceTimersByTimeAsync(REREAD_UNREACHABLE_MS)
    await flushPromises()
    expect(reads).toBe(2)
    expect(document.body.textContent).toContain('The server did not answer in time.')
    expect(button('Retry')).toBeDefined()
    expect(document.querySelector('[data-edit-connection]')).not.toBeNull()
    expect(SECTIONS()).toEqual([])
  })

  it('never reads them again unasked after a sign-in was refused (third review, I3)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let reads = 0
    mockApi({
      'GET connections': () => [200, [FULL]],
      'GET connections/c1/databases': () => {
        reads++
        return [502, { code: 'MONGO_ERROR', message: 'Authentication failed', details: { kind: 'auth' } }]
      },
    })
    mountApp(ConnectionTab, { props: { connectionId: 'c1' } })
    await flushPromises()
    await vi.advanceTimersByTimeAsync(REREAD_UNREACHABLE_MS * 3)
    await flushPromises()
    expect(reads).toBe(1)
    expect(SECTIONS()).toEqual([])
  })

  it('hides it all again when a later read fails', async () => {
    let up = true
    mockApi({
      // An administrator of the connection: its personal-data rules are theirs to edit.
      'GET connections': () => [200, [{ ...FULL, permissions: [...FULL.permissions, 'connections:manage'] }]],
      'GET connections/c1/databases': () => (up ? [200, DATABASES] : TIMEOUT),
      'GET backups': () => [200, []],
      'GET backups/usage': () => [200, { used: 0, quota: 1024 ** 3, ttlHours: 24 }],
    })
    mountApp(ConnectionTab, { props: { connectionId: 'c1' } })
    await flushPromises()
    expect(SECTIONS()).toContain('Performance')
    expect(document.body.textContent).toContain('Total size')
    expect(SECTIONS()).toContain('Personal data')
    up = false
    await menuOf('More actions for Prod')
    entry('Refresh').click()
    await flushPromises()
    expect(SECTIONS()).toEqual([])
    // Nor a total size read before, nor the personal-data rules (user report, second review N1).
    for (const gone of ['New database', 'Shell', 'Take the first backup', 'Total size'])
      expect(document.body.textContent, gone).not.toContain(gone)
    expect(document.querySelector('[data-personal-data]')).toBeNull()
  })
})

describe("a database's and a collection's tab while the server cannot be reached", () => {
  const handlers = (up: () => boolean) => ({
    'GET connections': () => [200, [FULL]] as [number, unknown],
    'GET connections/c1/databases': () => (up() ? [200, DATABASES] : TIMEOUT) as [number, unknown],
    'GET connections/c1/databases/shop/collections': () =>
      [200, [{ name: 'orders', type: 'collection', options: {}, readOnly: false }]] as [number, unknown],
    'GET backups': () => [200, [KEPT]] as [number, unknown],
    'GET backups/usage': () => [200, { used: 0, quota: 1024 ** 3, ttlHours: 24 }] as [number, unknown],
  })

  it('show no backup, restore, drop or new collection, and show them again after a Refresh', async () => {
    let up = false
    mockApi(handlers(() => up))
    mountApp(DatabaseTab, { props: { connectionId: 'c1', db: 'shop' } })
    await flushPromises()
    await menuOf('More actions for shop')
    expect(entries()).toEqual(['Copy name', 'Refresh'])
    await closeMenu()
    expect(document.body.textContent).not.toContain('New collection')
    expect(document.body.textContent).not.toContain('Start backup')
    expect(document.querySelector('#backups-c1-shop')).toBeNull()
    // The server is back: the database's own Refresh reads the connection's databases again too.
    up = true
    await menuOf('More actions for shop')
    entry('Refresh').click()
    await flushPromises()
    await menuOf('More actions for shop')
    expect(entries()).toEqual(expect.arrayContaining(['Back up database…', 'Drop database']))
    await closeMenu()
    // User request 2026-10-24: the database's backups are a tab of their own, there once connected.
    expect(SECTIONS()).toContain('Backups')
    tab('Backups').click()
    await flushPromises()
    expect(button('Start backup')).toBeDefined()
  })

  it('show none of it while connecting either (second review, I1)', async () => {
    let answer: (v: [number, unknown]) => void = () => {}
    mockApi({
      ...handlers(() => true),
      'GET connections/c1/databases': () => new Promise((resolve) => (answer = resolve)),
    })
    mountApp(DatabaseTab, { props: { connectionId: 'c1', db: 'shop' } })
    await flushPromises()
    expect(document.body.textContent).toContain('orders')
    await menuOf('More actions for shop')
    expect(entries()).toEqual(['Copy name', 'Refresh'])
    await closeMenu()
    expect(document.body.textContent).not.toContain('New collection')
    expect(document.querySelector('#backups-c1-shop')).toBeNull()
    // No Model or Watch to switch to, and no change of a collection from its row.
    expect(document.querySelector('[role="tablist"][aria-label="Database sections"]')).toBeNull()
    await menuOf('Actions for orders')
    expect(entries()).toEqual(['Open', 'Copy name'])
    await closeMenu()
    answer([200, DATABASES])
    await flushPromises()
    await menuOf('Actions for orders')
    expect(entries()).toEqual(expect.arrayContaining(['Rename', 'Duplicate', 'Drop']))
    await closeMenu()
    expect(document.querySelector('[role="tablist"][aria-label="Database sections"]')).not.toBeNull()
  })

  it('read the databases again while the server cannot be reached, so all comes back (M4)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let up = false
    const { calls } = mockApi(handlers(() => up))
    mountApp(DatabaseTab, { props: { connectionId: 'c1', db: 'shop' } })
    await flushPromises()
    expect(document.querySelector('#backups-c1-shop')).toBeNull()
    expect(SECTIONS()).not.toContain('Backups')
    up = true
    await vi.advanceTimersByTimeAsync(REREAD_UNREACHABLE_MS)
    await flushPromises()
    tab('Backups').click()
    await flushPromises()
    expect(document.querySelector('#backups-c1-shop')).not.toBeNull()
    // Connected now: no more reads unasked.
    const reads = calls.filter((c) => c.path === 'connections/c1/databases').length
    await vi.advanceTimersByTimeAsync(REREAD_UNREACHABLE_MS * 2)
    expect(calls.filter((c) => c.path === 'connections/c1/databases').length).toBe(reads)
  })

  it('a collection tab shows no backup, restore, sync or change of the collection', async () => {
    mockApi(handlers(() => false))
    mountApp(CollectionTab, { props: { connectionId: 'c1', db: 'shop', coll: 'orders', tabId: 't-orders' } })
    await flushPromises()
    await flushPromises()
    await menuOf('More actions for orders')
    for (const gone of ['Back up collection…', 'Restore here…', 'Rename', 'Drop', 'Duplicate'])
      expect(entries(), gone).not.toContain(gone)
    expect(entries()).toEqual(expect.arrayContaining(['Copy name', 'Refresh']))
    await closeMenu()
    // Nor its Watch section (third review, M2).
    const sections = [...document.querySelectorAll('[role="tab"]')].map((x) => x.textContent?.trim())
    expect(sections).toContain('Documents')
    expect(sections).not.toContain('Watch')
  })
})

describe('the Backups card of a server that cannot be reached', () => {
  it('starts no backup or restore there, from any of its buttons, and says why', async () => {
    mockApi({
      'GET connections': () => [200, [FULL]],
      'GET connections/c1/databases': () => TIMEOUT,
      'GET backups': () => [200, []],
      'GET backups/usage': () => [200, { used: 0, quota: 20 * 1024 ** 3, ttlHours: 24 }],
    })
    mountApp(BackupsCard, { props: { connectionId: 'c1' } })
    await flushPromises()
    const text = document.body.textContent ?? ''
    for (const gone of ['Start backup', 'Restore…', 'Take the first backup'])
      expect(text, gone).not.toContain(gone)
    expect(text).toContain('No connection to the server: backups and restores')
  })

  it("a kept backup's menu offers no restore there", async () => {
    mockApi({
      'GET connections': () => [200, [FULL]],
      'GET connections/c1/databases': () => TIMEOUT,
      'GET backups': () => [200, [KEPT]],
      'GET backups/usage': () => [200, { used: 0, quota: 20 * 1024 ** 3, ttlHours: 24 }],
    })
    mountApp(BackupsCard, { props: { connectionId: 'c1' } })
    await flushPromises()
    await menuOf('Actions for shop.mmbak')
    expect(entries()).toContain('Download')
    expect(entries()).not.toContain('Restore…')
  })
})

const plan = (over: Partial<DumpPlan> = {}): DumpPlan => ({
  planHash: 'a'.repeat(64),
  namespaces: [
    { db: 'shop', coll: 'orders', type: 'collection', documents: 1, bytes: 1, ttl: [], personal: [] },
  ],
  estimate: { bytes: 1, fileBytes: 1, seconds: 1 },
  tools: { available: false, reason: 'not_admin' },
  masked: false,
  recommended: { format: 'gzip', engine: 'builtin', reason: null },
  checks: [],
  refusals: [],
  ...over,
})
const settle = async () => {
  await vi.advanceTimersByTimeAsync(400)
  await flushPromises()
}
const CONNS = [{ id: 'c1', name: 'Prod', access: 'editor', permissions: ALL, export: true }]

describe('the backup sheet of a server that cannot be reached', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }))

  it('says so with Retry instead of the settings, and starts nothing', async () => {
    let up = false
    mockApi({
      'GET connections': () => [200, CONNS],
      'GET connections/c1/databases/shop/collections': () => [200, []],
      'POST connections/c1/backup/plan': () => (up ? [200, plan()] : TIMEOUT),
    })
    mountApp(BackupDumpSheet, { props: { connectionId: 'c1', db: 'shop' } })
    await settle()
    const alert = document.querySelector('[role="alert"]')!
    expect(alert.textContent).toContain('No connection to this MongoDB server')
    expect(alert.textContent).toContain('A backup reads the data from the server.')
    expect(document.body.textContent).not.toContain('Recommended for this backup')
    // Nothing to customize or step through behind it (review N1).
    expect(document.body.textContent).not.toContain('Customize')
    expect(button('Start backup').disabled).toBe(true)
    up = true
    button('Retry').click()
    await settle()
    expect(document.querySelector('[role="alert"]')).toBeNull()
    expect(button('Start backup').disabled).toBe(false)
  })

  it('never starts from a plan made before the server stopped answering', async () => {
    let up = true
    const { calls } = mockApi({
      'GET connections': () => [200, CONNS],
      'GET connections/c1/databases/shop/collections': () => [200, []],
      'POST connections/c1/backup/plan': () => (up ? [200, plan()] : TIMEOUT),
    })
    mountApp(BackupDumpSheet, { props: { connectionId: 'c1', db: 'shop' } })
    await settle()
    expect(button('Start backup').disabled).toBe(false)
    // A change of settings plans again; the server has stopped answering meanwhile.
    up = false
    document.querySelector<HTMLInputElement>('input[name="format"][value="archive"]')!.click()
    await settle()
    expect(button('Start backup').disabled).toBe(true)
    button('Start backup').click()
    await flushPromises()
    expect(calls.some((c) => c.path === 'connections/c1/backup')).toBe(false)
  })

  it('a plan that failed for another reason says it, with Retry (review M4)', async () => {
    let busy = true
    mockApi({
      'GET connections': () => [200, CONNS],
      'GET connections/c1/databases/shop/collections': () => [200, []],
      'POST connections/c1/backup/plan': () =>
        busy
          ? [
              503,
              { code: 'MONGO_ERROR', message: 'No connection was free in time', details: { kind: 'pool' } },
            ]
          : [200, plan()],
    })
    mountApp(BackupDumpSheet, { props: { connectionId: 'c1', db: 'shop' } })
    await settle()
    expect(document.body.textContent).not.toContain('No connection to this MongoDB server')
    expect(button('Start backup').disabled).toBe(true)
    busy = false
    button('Retry').click()
    await settle()
    expect(button('Start backup').disabled).toBe(false)
  })
})

describe('the restore plan of a target that cannot be reached (review M5)', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }))

  it('drops that error once there is nothing to plan, so another target does not inherit it', async () => {
    mockApi({ 'POST connections/c1/restore/plan': () => TIMEOUT })
    const body = ref<object | null>({ source: { kind: 'backup', backupId: 'b1' } })
    let state: ReturnType<typeof useRestorePlan> | undefined
    mountApp({
      setup() {
        state = useRestorePlan(
          ref('c1'),
          computed(() => body.value),
        )
        return () => h('div')
      },
    })
    await settle()
    expect(cannotReach(state!.error.value)).toBe(true)
    body.value = null
    await settle()
    expect(state!.error.value).toBeNull()
  })
})

describe("a connection test's answer kept by the server (sixth review, M4)", () => {
  it('says nothing was dialled, and who may test it again', () => {
    mountApp(TestResultView, {
      props: {
        result: { ok: false, error: { kind: 'auth', message: 'Authentication failed', remembered: true } },
      },
    })
    expect(document.querySelector('[data-test="test-remembered"]')!.textContent).toContain(
      "Nothing was dialled: the server refused this sign-in a moment ago, and for up to five minutes only the connection's administrators can test it again.",
    )
    document.body.innerHTML = ''
    mountApp(TestResultView, {
      props: { result: { ok: false, error: { kind: 'auth', message: 'Authentication failed' } } },
    })
    expect(document.querySelector('[data-test="test-remembered"]')).toBeNull()
  })
})

// User report 2026-11-02: in Docker a connection to localhost is refused (ECONNREFUSED ::1) — its tab
// says why, and opens the connection to change its host.
describe('a connection to localhost that fails while Mongo Manager runs in Docker', () => {
  const LOCAL = { ...FULL, settings: { scheme: 'mongodb', hosts: [{ host: 'localhost', port: 27021 }] } }
  const REFUSED: [number, unknown] = [
    502,
    {
      code: 'MONGO_ERROR',
      message: 'Could not reach the server: connect ECONNREFUSED ::1:27021',
      details: { kind: 'network' },
    },
  ]
  const caps = (distribution: string) => ({
    mode: 'local',
    distribution,
    kerberos: { available: false, status: 'not_in_package', allowed: true },
    encryption: {
      available: false,
      status: 'not_in_package',
      serverCryptShared: false,
      ownCryptSharedPath: true,
    },
    oidc: { workloadIdentity: false, redirectUri: 'http://localhost:4321/oidc/callback' },
  })

  it('says localhost is the container, and opens the connection to change it', async () => {
    mockApi({
      'GET connections': () => [200, [LOCAL]],
      'GET connections/c1/databases': () => REFUSED,
      'GET connections/capabilities': () => [200, caps('docker')],
    })
    useSessionStore().me = { permissions: [...PERMISSIONS] } as never
    mountApp(ConnectionTab, { props: { connectionId: 'c1' } })
    await flushPromises()
    await flushPromises()
    const hint = document.querySelector('[data-docker-localhost]')!
    expect(hint.textContent).toContain('localhost is its own container')
    ;[...hint.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent?.trim() === 'Edit connection')!
      .click()
    expect(useWorkspaceDialogs().current).toMatchObject({ kind: 'connection', connection: { id: 'c1' } })
  })

  const SIGN_IN: [number, unknown] = [
    502,
    { code: 'MONGO_ERROR', message: 'Authentication failed', details: { kind: 'auth' } },
  ]
  it.each([
    ['outside Docker', LOCAL, 'npm', REFUSED],
    [
      'for another host',
      { ...FULL, settings: { scheme: 'mongodb', hosts: [{ host: 'db' }] } },
      'docker',
      REFUSED,
    ],
    // Review of 1.0.1 (M4): a server that answered refused the sign-in — localhost reached it.
    ['for a refused sign-in', LOCAL, 'docker', SIGN_IN],
  ])('says nothing %s', async (_, connection, distribution, answer) => {
    mockApi({
      'GET connections': () => [200, [connection]],
      'GET connections/c1/databases': () => answer,
      'GET connections/capabilities': () => [200, caps(distribution)],
    })
    mountApp(ConnectionTab, { props: { connectionId: 'c1' } })
    await flushPromises()
    await flushPromises()
    expect(document.querySelector('[data-docker-localhost]')).toBeNull()
  })
})
