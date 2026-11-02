import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { BackupView, DumpPlan } from '@mongo-manager/shared'
import BackupDumpSheet from '../src/backup/BackupDumpSheet.vue'
import BackupsCard from '../src/backup/BackupsCard.vue'
import { useTabsStore } from '../src/stores/tabs'
import { useCollectionViewsStore } from '../src/stores/collectionViews'
import { useTabSectionsStore } from '../src/stores/tabSections'
import { useWorkspaceDialogs } from '../src/stores/workspaceDialogs'
import { newDraft } from '../src/schedules/useScheduleDraft'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'
import { button } from './support/dom'

/**
 * User request 2026-10-30: a backup started from a collection opens that collection's Backups; one of
 * a database, the database's; and a collection's Backups lists the backups that hold it.
 */
const ALL = ['documents:read', 'documents:write', 'databases:write', 'jobs:run', 'data:export']
const CONNS = [{ id: 'c1', name: 'Prod', access: 'editor', permissions: ALL, export: true }]
const plan = (coll: string | null): DumpPlan => ({
  planHash: 'a'.repeat(64),
  namespaces: [
    {
      db: 'shop',
      coll: coll ?? 'orders',
      type: 'collection',
      documents: 10,
      bytes: 1000,
      ttl: [],
      personal: [],
    },
  ],
  estimate: { bytes: 1000, fileBytes: 300, seconds: 1 },
  tools: { available: false, reason: 'not_admin' },
  masked: false,
  recommended: { format: 'gzip', engine: 'builtin', reason: null },
  checks: [],
  refusals: [],
})
const JOB = (coll: string) => ({
  id: 'j1',
  kind: 'backup.dump',
  state: 'running',
  connectionId: 'c1',
  db: 'shop',
  coll,
  target: 'shop.gz',
  targetConnectionId: null,
  progress: null,
  estimate: null,
  error: null,
  startedAt: 1,
  finishedAt: null,
  mine: true,
  cancellable: true,
})
const settle = async () => {
  await vi.advanceTimersByTimeAsync(400)
  await flushPromises()
}
beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
  vi.useFakeTimers({ shouldAdvanceTime: true })
  localStorage.clear()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

async function startDump(props: { db: string; coll?: string }): Promise<void> {
  mockApi({
    'GET connections': () => [200, CONNS],
    'GET connections/c1/databases/shop/collections': () => [200, [{ name: 'orders', type: 'collection' }]],
    'GET backup-destinations': () => [200, []],
    'POST connections/c1/backup/plan': () => [200, plan(props.coll ?? null)],
    'POST connections/c1/backup': () => [202, { job: JOB(props.coll ?? '*') }],
  })
  mountApp(BackupDumpSheet, { props: { connectionId: 'c1', ...props } })
  await settle()
  await settle()
  button('Start backup').click()
  await settle()
}

describe('a backup started', () => {
  it('opens the collection’s Backups when it was the collection’s', async () => {
    await startDump({ db: 'shop', coll: 'orders' })
    const tabs = useTabsStore()
    const active = tabs.tabs.find((t) => t.id === tabs.activeId)!
    expect(active).toMatchObject({
      kind: 'collection',
      params: { connectionId: 'c1', db: 'shop', coll: 'orders' },
    })
    expect(useCollectionViewsStore().stateFor(active.id).section).toBe('backups')
  })

  it('opens the database’s Backups when it was the database’s', async () => {
    await startDump({ db: 'shop' })
    const tabs = useTabsStore()
    const active = tabs.tabs.find((t) => t.id === tabs.activeId)!
    expect(active).toMatchObject({ kind: 'database', params: { connectionId: 'c1', db: 'shop' } })
    expect(useTabSectionsStore().get(active.id, 'overview')).toBe('backups')
  })
})

const NOW = Date.now()
const B = (id: string, scope: BackupView['scope']): BackupView => ({
  id,
  name: `${id}.gz`,
  jobId: 'j1',
  connectionId: 'c1',
  scope,
  engine: 'builtin',
  format: 'gzip',
  masked: false,
  anonymous: false,
  size: 1000,
  sha256: 'x',
  namespaces: 1,
  startedAt: NOW - 3600_000,
  finishedAt: NOW - 3500_000,
  expiresAt: NOW + 3600_000,
  copies: [],
})

describe('a collection’s Backups', () => {
  it('lists the backups that hold the collection, and backs up, restores or schedules it', async () => {
    mockApi({
      'GET connections': () => [200, CONNS],
      'GET backups': () => [
        200,
        [
          B('orders-only', { kind: 'collection', db: 'shop', coll: 'orders' }),
          B('users-only', { kind: 'collection', db: 'shop', coll: 'users' }),
          B('whole-shop', { kind: 'database', db: 'shop', views: true }),
          B('shop-users', { kind: 'database', db: 'shop', collections: ['users'], views: true }),
          B('whole-server', { kind: 'server' }),
          B('server-shop', { kind: 'server', databases: ['shop', 'crm'] }),
          B('server-crm', { kind: 'server', databases: ['crm'] }),
          B('other-db', { kind: 'database', db: 'crm', views: true }),
        ],
      ],
      'GET backups/usage': () => [200, { used: 0, quota: 20 * 1024 ** 3, ttlHours: 24 }],
    })
    mountApp(BackupsCard, { props: { connectionId: 'c1', db: 'shop', coll: 'orders' } })
    await flushPromises()
    const text = document.body.textContent ?? ''
    for (const shown of ['orders-only.gz', 'whole-shop.gz', 'whole-server.gz', 'server-shop.gz'])
      expect(text).toContain(shown)
    for (const hidden of ['users-only.gz', 'shop-users.gz', 'other-db.gz', 'server-crm.gz'])
      expect(text).not.toContain(hidden)
    // Review of the branch (M5): each action is the collection's, not its database's.
    const dialogs = useWorkspaceDialogs()
    for (const [label, kind] of [
      ['Start backup', 'backupDump'],
      ['Restore…', 'backupRestore'],
      ['Schedule…', 'backupSchedule'],
    ] as const) {
      button(label).click()
      expect(dialogs.current, label).toMatchObject({ kind, connectionId: 'c1', db: 'shop', coll: 'orders' })
    }
  })
})

describe('a schedule drafted from a collection', () => {
  it('backs up that collection', () => {
    expect(newDraft({ connectionId: 'c1', db: 'shop', coll: 'orders' })).toMatchObject({
      scope: 'collection',
      db: 'shop',
      coll: 'orders',
    })
    expect(newDraft({ connectionId: 'c1', db: 'shop' })).toMatchObject({ scope: 'database', coll: '' })
  })
})
