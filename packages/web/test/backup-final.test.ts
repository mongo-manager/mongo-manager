import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import type { BackupView, DestinationSummary, DumpPlan, JobView, RemoteBackup } from '@mongo-manager/shared'
import WhereSection from '../src/backup/WhereSection.vue'
import BackupDumpSheet from '../src/backup/BackupDumpSheet.vue'
import BackupRestoreSheet from '../src/backup/BackupRestoreSheet.vue'
import BackupSendSheet from '../src/backup/BackupSendSheet.vue'
import BackupsCard from '../src/backup/BackupsCard.vue'
import CopyBadges from '../src/backup/CopyBadges.vue'
import RemoteList from '../src/backup/RemoteList.vue'
import RemoteSourcePicker from '../src/backup/RemoteSourcePicker.vue'
import JobRow from '../src/jobs/JobRow.vue'
import WorkspaceDialogs from '../src/workspace/WorkspaceDialogs.vue'
import ToastHost from '../src/ds/DsToastHost.vue'
import { useJobsStore } from '../src/jobs/store'
import { useJobOutcomes } from '../src/jobs/outcomes'
import { useWorkspaceDialogs } from '../src/stores/workspaceDialogs'
import { useTabsStore } from '../src/stores/tabs'
import { formatBytes } from '../src/format'
import { i18n } from '../src/i18n'
import en from '../src/i18n/locales/en.json'
import { mockApi, mountApp, type Handler } from './support/app'
import { button } from './support/dom'

/** Phase 3d-3b final review: sending, fetching, the Backups card and the job rows (C-findings). */
beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
  vi.useFakeTimers({ shouldAdvanceTime: true })
  try {
    localStorage.clear()
  } catch {
    // no storage
  }
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const t = (key: string, named: Record<string, unknown> = {}) => i18n.global.t(key, named)
const text = () => document.body.textContent ?? ''
const settle = async (ms = 400) => {
  await vi.advanceTimersByTimeAsync(ms)
  await flushPromises()
}
const CONNS = [
  {
    id: 'c1',
    name: 'Prod',
    access: 'editor',
    permissions: ['documents:read', 'documents:write', 'jobs:run', 'data:export'],
    export: true,
  },
]
const S3: DestinationSummary = {
  id: 'd1',
  name: 'Offsite S3',
  type: 's3',
  level: 'send',
  policy: { encryptedOnly: true },
}
const NAS: DestinationSummary = {
  id: 'd2',
  name: 'NAS',
  type: 'folder',
  level: 'send',
  policy: { encryptedOnly: false },
}
const DAV: DestinationSummary = {
  id: 'd3',
  name: 'Cloud',
  type: 'webdav',
  level: 'send',
  policy: { encryptedOnly: false },
}
const plan = (over: Partial<DumpPlan> = {}): DumpPlan => ({
  planHash: 'a'.repeat(64),
  namespaces: [
    { db: 'shop', coll: 'orders', type: 'collection', documents: 10, bytes: 1000, ttl: [], personal: [] },
  ],
  estimate: { bytes: 1000, fileBytes: 300, seconds: 1 },
  tools: { available: false, reason: 'not_admin' },
  masked: false,
  recommended: { format: 'gzip', engine: 'builtin', reason: null },
  checks: [],
  refusals: [],
  ...over,
})
const BACKUP = (over: Partial<BackupView> = {}): BackupView => ({
  id: 'b1',
  name: 'shop-20261003-120000.mmbak',
  jobId: 'j1',
  connectionId: 'c1',
  scope: { kind: 'database', db: 'shop', views: true },
  engine: 'builtin',
  format: 'mmbak',
  masked: false,
  anonymous: false,
  size: 1000,
  sha256: 'a'.repeat(64),
  namespaces: 1,
  startedAt: 1,
  finishedAt: Date.now() - 3_600_000,
  expiresAt: Date.now() + 3_600_000,
  copies: [],
  ...over,
})
const JOB = (over: Partial<JobView> = {}): JobView => ({
  id: 'js',
  kind: 'backup.send',
  connectionId: 'c1',
  targetConnectionId: null,
  db: 'shop',
  coll: '*',
  target: 'shop-20261003-120000.mmbak',
  state: 'running',
  progress: null,
  estimate: null,
  error: null,
  startedAt: Date.now(),
  finishedAt: null,
  mine: true,
  cancellable: true,
  ...over,
})
const REMOTE = (over: Partial<RemoteBackup> = {}): RemoteBackup => ({
  key: 'mongo-manager/2026/10/mm-20261003-120000-aaaaaaaa.mmbak',
  name: 'mm-20261003-120000-aaaaaaaa.mmbak',
  size: 1000,
  createdAt: Date.now() - 86_400_000,
  format: 'mmbak',
  archived: false,
  thaw: null,
  state: 'complete',
  copyId: 'k1',
  sender: 'me',
  mine: true,
  scope: { kind: 'database', db: 'shop', views: true },
  connectionId: 'c1',
  masked: false,
  anonymous: false,
  ...over,
})
const r = (n: number, over: Partial<RemoteBackup> = {}) =>
  REMOTE({ key: `mongo-manager/2026/10/mm-${n}.mmbak`, name: `mm-${n}.mmbak`, copyId: `k${n}`, ...over })

describe('C2: a chosen destination that becomes blocked', () => {
  it('is dropped when the format changes, and comes back when the format allows it again', async () => {
    const update = vi.fn()
    const { wrapper } = mountApp(WhereSection, {
      props: {
        destinations: [S3, NAS],
        modelValue: ['d1', 'd2'],
        deleteLocal: false,
        format: 'mmbak',
        plainPersonal: false,
        'onUpdate:modelValue': (ids: string[]) => {
          update(ids)
          void wrapper.setProps({ modelValue: ids })
        },
      },
    })
    await flushPromises()
    await wrapper.setProps({ format: 'gzip' })
    await flushPromises()
    expect(update).toHaveBeenLastCalledWith(['d2'])
    await wrapper.setProps({ format: 'mmbak' })
    await flushPromises()
    expect(update).toHaveBeenLastCalledWith(['d2', 'd1'])
  })

  it('can always be deselected', async () => {
    const update = vi.fn()
    mountApp(WhereSection, {
      props: {
        destinations: [S3],
        modelValue: ['d1'],
        deleteLocal: false,
        format: 'gzip',
        plainPersonal: false,
        'onUpdate:modelValue': update,
      },
    })
    await flushPromises()
    const before = update.mock.calls.length
    document.querySelector<HTMLButtonElement>('[data-destination="d1"]')!.click()
    await flushPromises()
    expect(update.mock.calls.length).toBe(before + 1)
    expect(update).toHaveBeenLastCalledWith([])
  })

  it('is not sent from the remembered choice while blocked, and is sent once Encrypt allows it', async () => {
    localStorage.setItem('mm:backup-where:anon', JSON.stringify(['d1', 'd2']))
    const { calls } = mockApi({
      'GET connections': () => [200, CONNS],
      'GET connections/c1/databases/shop/collections': () => [200, []],
      'GET backup-destinations': () => [200, [S3, NAS]],
      'POST connections/c1/backup/plan': () => [200, plan()],
    })
    mountApp(BackupDumpSheet, { props: { connectionId: 'c1', db: 'shop' } })
    await settle()
    await settle()
    const planBody = () =>
      calls.filter((c) => c.path === 'connections/c1/backup/plan').at(-1)!.body as { destinations: string[] }
    expect(planBody().destinations).toEqual(['d2'])
    button('Encrypt').click()
    await settle()
    await settle()
    expect([...planBody().destinations].sort()).toEqual(['d1', 'd2'])
  })
})

describe('C22, C27: Where says why, and what "verified" means', () => {
  it('ties a blocked chip to its reason, says the server copy state in words, and explains verification', async () => {
    mountApp(WhereSection, {
      props: {
        destinations: [S3, NAS, DAV],
        modelValue: ['d2', 'd3'],
        deleteLocal: true,
        format: 'gzip',
        plainPersonal: false,
      },
    })
    await flushPromises()
    const chip = document.querySelector<HTMLButtonElement>('[data-destination="d1"]')!
    const describedBy = chip.getAttribute('aria-describedby')!
    expect(document.getElementById(describedBy)!.textContent).toContain(
      'Offsite S3 accepts encrypted backups only',
    )
    const server = document.querySelector('[data-kept]')!
    expect(server.textContent).toContain(t('backup.where.serverGoes'))
    // WebDAV without reading back checks the size only: the sentence names it.
    expect(text()).toContain(t('backup.where.verifiedSize', { names: 'Cloud' }))
  })

  it('does not promise a read-back for every copy', () => {
    expect(en.backup.send.lead).not.toMatch(/read back and checked/)
    expect(en.backup.send.lead).toMatch(/size/)
  })
})

describe('C3: a fetch on its way', () => {
  const handlers = (fetch: Handler): Record<string, Handler> => ({
    'GET connections': () => [200, CONNS],
    'GET backups': () => [200, []],
    'GET backup-destinations': () => [200, [S3]],
    'GET backup-destinations/d1/backups': () => [200, { items: [REMOTE()], cursor: null }],
    'POST backup-destinations/d1/backups/fetch': fetch,
    'POST backups/inspect': () => [200, { state: 'waiting', received: 0 }],
    'POST jobs/jf/cancel': () => [200, { job: JOB({ id: 'jf', kind: 'backup.fetch', state: 'cancelled' }) }],
  })

  it('shows progress, starts one fetch however often it is picked, and cancels a job that arrives after closing', async () => {
    let answer: (v: [number, unknown]) => void = () => undefined
    const { calls } = mockApi(handlers(() => new Promise((res) => (answer = res))))
    const { wrapper } = mountApp(BackupRestoreSheet, { props: { connectionId: 'c1', db: 'shop' } })
    await flushPromises()
    button('From a destination').click()
    await flushPromises()
    const pick = () => document.querySelector<HTMLButtonElement>('[data-remote-pick]')!
    pick().click()
    await flushPromises()
    expect(text()).toContain(t('backup.remote.starting'))
    expect(pick().disabled).toBe(true)
    pick().click()
    await flushPromises()
    expect(calls.filter((c) => c.path === 'backup-destinations/d1/backups/fetch')).toHaveLength(1)
    wrapper.unmount()
    answer([
      202,
      { uploadId: '7c9e6679-7425-40de-944b-e07fc1f90ae7', job: JOB({ id: 'jf', kind: 'backup.fetch' }) },
    ])
    await flushPromises()
    await settle(3000)
    expect(calls.some((c) => c.path === 'jobs/jf/cancel')).toBe(true)
    expect(calls.some((c) => c.path === 'backups/inspect')).toBe(false)
  })

  it('says a cancelled download was cancelled, and an empty error in a full sentence', async () => {
    mockApi(
      handlers(() => [
        202,
        { uploadId: '7c9e6679-7425-40de-944b-e07fc1f90ae7', job: JOB({ id: 'jf', kind: 'backup.fetch' }) },
      ]),
    )
    const { wrapper } = mountApp(BackupRestoreSheet, {
      props: { connectionId: 'c1', remote: { destinationId: 'd1', key: REMOTE().key, name: 'x.mmbak' } },
    })
    await flushPromises()
    useJobsStore().upsert(JOB({ id: 'jf', kind: 'backup.fetch', state: 'cancelled', finishedAt: 2 }))
    await flushPromises()
    expect(text()).toContain(t('backup.remote.fetchCancelled'))
    expect(text()).not.toContain('The download failed')
    wrapper.unmount()
    await flushPromises()
  })

  it('warns that a file without a manifest cannot be verified before restoring (C28)', async () => {
    mockApi(
      handlers(() => [
        202,
        {
          uploadId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
          job: JOB({ id: 'jf', kind: 'backup.fetch', verified: false }),
        },
      ]),
    )
    const { wrapper } = mountApp(BackupRestoreSheet, {
      props: { connectionId: 'c1', remote: { destinationId: 'd1', key: REMOTE().key, name: 'x.mmbak' } },
    })
    await flushPromises()
    expect(text()).toContain(t('backup.remote.unverified'))
    wrapper.unmount()
    await flushPromises()
  })
})

describe('C9: refusals in words on every backup path', () => {
  it('says why the file cannot be read yet instead of a generic conflict', async () => {
    mockApi({
      'GET connections': () => [200, CONNS],
      'GET backups': () => [200, []],
      'GET backup-destinations': () => [200, [S3]],
      'POST backup-destinations/d1/backups/fetch': () => [
        202,
        { uploadId: '7c9e6679-7425-40de-944b-e07fc1f90ae7', job: JOB({ id: 'jf', kind: 'backup.fetch' }) },
      ],
      'POST backups/inspect': () => [
        409,
        {
          code: 'CONFLICT',
          message: 'This file is being downloaded',
          details: { reason: 'upload_fetching' },
        },
      ],
    })
    const { wrapper } = mountApp(BackupRestoreSheet, {
      props: { connectionId: 'c1', remote: { destinationId: 'd1', key: REMOTE().key, name: 'x.mmbak' } },
    })
    await flushPromises()
    expect(text()).toContain(t('destinations.reason.upload_fetching'))
    wrapper.unmount()
    await flushPromises()
  })
})

describe('C21: source tabs', () => {
  it('falls back to this server when a remembered destination is gone, with Home/End and a tab panel', async () => {
    localStorage.setItem('mm:backups-source:c1:shop', 'gone')
    mockApi({
      'GET connections': () => [200, CONNS],
      'GET backups': () => [200, [BACKUP()]],
      'GET backups/usage': () => [200, { used: 0, quota: 1, ttlHours: 24, chunkMb: 64 }],
      'GET backup-destinations': () => [200, [S3, NAS]],
      'GET backup-destinations/d1/backups': () => [200, { items: [], cursor: null }],
      'GET backup-destinations/d2/backups': () => [200, { items: [], cursor: null }],
    })
    mountApp(BackupsCard, { props: { connectionId: 'c1', db: 'shop' } })
    await flushPromises()
    const tabs = () => [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    expect(tabs().map((b) => b.tabIndex)).toEqual([0, -1, -1])
    expect(tabs()[0]!.getAttribute('aria-selected')).toBe('true')
    const panel = document.getElementById(tabs()[0]!.getAttribute('aria-controls')!)!
    expect(panel.getAttribute('role')).toBe('tabpanel')
    tabs()[0]!.focus()
    tabs()[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    await flushPromises()
    expect(tabs()[2]!.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(tabs()[2])
    tabs()[2]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    await flushPromises()
    expect(tabs()[0]!.getAttribute('aria-selected')).toBe('true')
  })

  it('makes the restore sheet’s source switch a real tab list', async () => {
    mockApi({
      'GET connections': () => [200, CONNS],
      'GET backups': () => [200, [BACKUP()]],
      'GET backup-destinations': () => [200, [S3]],
      'GET backup-destinations/d1/backups': () => [200, { items: [], cursor: null }],
    })
    const { wrapper } = mountApp(BackupRestoreSheet, { props: { connectionId: 'c1' } })
    await flushPromises()
    const list = document.querySelector('[role="tablist"]')!
    expect(list.getAttribute('aria-label')).toBe(t('backup.restore.source.label'))
    const tabs = () => [...list.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    expect(tabs().map((b) => b.tabIndex)).toEqual([0, -1, -1])
    tabs()[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    await flushPromises()
    expect(tabs()[1]!.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(tabs()[1])
    const panel = document.getElementById(tabs()[1]!.getAttribute('aria-controls')!)!
    expect(panel.getAttribute('role')).toBe('tabpanel')
    wrapper.unmount()
    await flushPromises()
  })
})

describe('C5, C22: the picker pages and says why a row cannot be picked', () => {
  it('loads more with the cursor, searches every loaded page, and shows the reasons in words', async () => {
    const { calls } = mockApi({
      'GET backup-destinations/d1/backups': (_b, url) =>
        url.searchParams.get('cursor') === 'c2'
          ? [200, { items: [r(3, { name: 'mm-older-orders.mmbak' })], cursor: null }]
          : [
              200,
              {
                items: [r(1, { archived: true }), r(2, { state: 'incomplete' })],
                cursor: 'c2',
              },
            ],
    })
    mountApp(RemoteSourcePicker, { props: { destinations: [S3] } })
    await flushPromises()
    const rows = () => [...document.querySelectorAll('[data-remote-pick]')]
    expect(rows()[0]!.textContent).toContain(t('backup.remote.archived'))
    expect(rows()[1]!.textContent).toContain(t('backup.remote.incomplete'))
    button(t('backup.remote.more')).click()
    await flushPromises()
    expect(calls.at(-1)!.path).toBe('backup-destinations/d1/backups')
    expect(rows()).toHaveLength(3)
    const search = document.querySelector<HTMLInputElement>('input[type="search"]')!
    search.value = 'older'
    search.dispatchEvent(new Event('input'))
    await flushPromises()
    expect(rows()).toHaveLength(1)
    expect(() => button(t('backup.remote.more'))).toThrow()
  })
})

describe('C7: the send dialog', () => {
  it('waits, then says when there is nowhere left to send to, and offers no Encrypt it cannot do', async () => {
    let answer: (v: [number, unknown]) => void = () => undefined
    mockApi({ 'GET backup-destinations': () => new Promise((res) => (answer = res)) })
    const plain = BACKUP({ format: 'gzip', masked: true })
    mountApp(BackupSendSheet, {
      props: {
        backup: {
          ...plain,
          copies: [
            {
              id: 'k1',
              destinationId: 'd2',
              destinationName: 'NAS',
              state: 'complete',
              sent: 1,
              size: 1,
              error: null,
              completedAt: 1,
            },
          ],
        },
      },
    })
    await flushPromises()
    expect(document.querySelector('[role="dialog"] [aria-busy="true"]')).not.toBeNull()
    answer([200, [S3, NAS]])
    await flushPromises()
    // NAS has it already; Offsite refuses a plain archive and this one cannot be re-encrypted.
    expect(() => button('Encrypt')).toThrow()
    expect(text()).toContain(t('backup.send.cannotEncrypt'))
  })

  it('says when there is no destination to send to at all', async () => {
    mockApi({ 'GET backup-destinations': () => [200, []] })
    mountApp(BackupSendSheet, { props: { backup: BACKUP() } })
    await flushPromises()
    expect(text()).toContain(t('backup.send.none'))
    expect(button('Send').disabled).toBe(true)
  })

  it('says when every destination already holds it, and why destinations cannot be read', async () => {
    mockApi({ 'GET backup-destinations': () => [200, [NAS]] })
    mountApp(BackupSendSheet, {
      props: {
        backup: BACKUP({
          copies: [
            {
              id: 'k1',
              destinationId: 'd2',
              destinationName: 'NAS',
              state: 'complete',
              sent: 1,
              size: 1,
              error: null,
              completedAt: 1,
            },
          ],
        }),
      },
    })
    await flushPromises()
    expect(text()).toContain(t('backup.send.allSent'))
    document.body.innerHTML = ''
    mockApi({ 'GET backup-destinations': () => [500, { code: 'INTERNAL', message: 'x' }] })
    mountApp(BackupSendSheet, { props: { backup: BACKUP() } })
    await flushPromises()
    expect(document.querySelector('[role="dialog"] [role="alert"]')).not.toBeNull()
    expect(button(t('common.retry'))).toBeDefined()
  })
})

describe('C8: copies left "sending" by a restart', () => {
  it('stops polling when no send is running for them', async () => {
    const sending = {
      id: 'k1',
      destinationId: 'd1',
      destinationName: 'Offsite S3',
      state: 'sending' as const,
      sent: 10,
      size: 1000,
      error: null,
      completedAt: null,
    }
    const { calls } = mockApi({
      'GET connections': () => [200, CONNS],
      'GET backups': () => [200, [BACKUP({ copies: [sending] })]],
      'GET backups/usage': () => [200, { used: 0, quota: 1, ttlHours: 24, chunkMb: 64 }],
      'GET backup-destinations': () => [200, [S3]],
    })
    mountApp(BackupsCard, { props: { connectionId: 'c1', db: 'shop' } })
    await flushPromises()
    const reads = () => calls.filter((c) => c.path === 'backups' && c.method === 'GET').length
    const first = reads()
    await settle(10_000)
    expect(reads()).toBe(first)
    useJobsStore().upsert(JOB())
    await settle(4_500)
    expect(reads()).toBeGreaterThan(first)
  })
})

describe('C22, C25: a failed copy says why, in the reader’s words', () => {
  it('shows the reason on the badge, not only in a tooltip, and Discard does not read as Cancel', async () => {
    i18n.global.locale.value = 'tr'
    mountApp(CopyBadges, {
      props: {
        copies: [
          {
            id: 'k2',
            destinationId: 'd2',
            destinationName: 'NAS',
            state: 'failed',
            sent: 1,
            size: 2,
            error: 'NAS: The destination is full',
            reason: 'quota',
            completedAt: null,
          },
        ],
      },
    })
    await flushPromises()
    expect(text()).toContain(i18n.global.t('destinations.reason.quota'))
    expect(text()).not.toContain('The destination is full')
    expect(text()).not.toContain('Vazgeç')
  })
})

describe('C11, C24: send and fetch rows', () => {
  it('shows bytes, speed and time left, waits for a destination in words, and reads as finished once done', async () => {
    const { wrapper } = mountApp(JobRow, {
      props: { job: JOB({ progress: { done: 0, total: 10 * 1024 * 1024 } }), now: Date.now() },
    })
    await wrapper.setProps({ job: JOB({ progress: { done: 2 * 1024 * 1024, total: 10 * 1024 * 1024 } }) })
    await vi.advanceTimersByTimeAsync(2000)
    await wrapper.setProps({
      job: JOB({ progress: { done: 4 * 1024 * 1024, total: 10 * 1024 * 1024 } }),
      now: Date.now(),
    })
    const line = text()
    expect(line).toContain(`${formatBytes(4 * 1024 * 1024, 'en')} / ${formatBytes(10 * 1024 * 1024, 'en')}`)
    expect(line).toMatch(/\/s/)
    expect(line).toContain(t('jobs.left', { time: '' }).trim())
    await wrapper.setProps({ job: JOB({ waitingFor: ['Offsite S3'] }) })
    expect(text()).toContain(t('jobs.waitingFor', { names: 'Offsite S3' }))
    await wrapper.setProps({ job: JOB({ state: 'done', finishedAt: Date.now() }) })
    expect(text()).toContain(t('backup.send.rowDone', { name: JOB().target }))
    expect(text()).not.toContain(t('backup.send.row', { name: JOB().target }))
  })

  it('retries a failed send’s failed copies from its row', async () => {
    const failed = {
      id: 'k2',
      destinationId: 'd2',
      destinationName: 'NAS',
      state: 'failed' as const,
      sent: 1,
      size: 2,
      error: 'x',
      completedAt: null,
    }
    const { calls } = mockApi({
      'GET backups': () => [200, [BACKUP({ copies: [failed] })]],
      'POST backup-copies/k2/retry': () => [202, { job: JOB({ id: 'j9' }) }],
    })
    mountApp(JobRow, { props: { job: JOB({ state: 'failed', error: 'x', finishedAt: 1 }), now: Date.now() } })
    await flushPromises()
    button(t('backup.copies.retry')).click()
    await flushPromises()
    expect(calls.some((c) => c.path === 'backup-copies/k2/retry')).toBe(true)
  })
})

describe('C24, C29, C26: outcome toasts and dialogs', () => {
  const Outcomes = defineComponent(() => {
    useJobOutcomes()
    return () => h('div')
  })
  function finish(over: Partial<JobView>) {
    const store = useJobsStore()
    store.upsert(JOB({ ...over, state: 'running' }))
    store.upsert(JOB({ ...over, state: over.state ?? 'done', finishedAt: Date.now() }))
  }

  it('says a failed send in the reader’s language without a doubled prefix, and why the local copy stayed', async () => {
    i18n.global.locale.value = 'tr'
    mockApi({})
    mountApp(Outcomes)
    mountApp(ToastHost)
    finish({
      state: 'failed',
      error: 'Not sent — NAS: The destination is full. The local copy was kept.',
      failures: [{ destination: 'NAS', reason: 'quota' }],
      localKept: true,
    } as Partial<JobView>)
    await flushPromises()
    const toast = text()
    expect(toast).not.toContain('Not sent')
    expect(toast).not.toContain('The local copy was kept')
    expect(toast).toContain(i18n.global.t('destinations.reason.quota'))
    expect(toast).toContain(i18n.global.t('backup.send.localKept', { names: 'NAS' }))
    // Backup review M12: and for how long.
    expect(toast).toContain('yerel kopya 7 gün tutuldu')
  })

  it('says a failed download with no error in a full sentence', async () => {
    mockApi({})
    mountApp(Outcomes)
    mountApp(ToastHost)
    finish({ kind: 'backup.fetch', state: 'failed', error: '' })
    await flushPromises()
    expect(text()).toContain(t('backup.remote.fetchFailedPlain'))
    expect(text()).not.toMatch(/failed: $/m)
  })

  it('opens the Backups section even when connections were not read yet, after the tab is there', async () => {
    const { calls } = mockApi({ 'GET connections': () => [200, CONNS] })
    mountApp(Outcomes)
    mountApp(ToastHost)
    finish({ state: 'done' })
    await flushPromises()
    button(t('backup.send.open')).click()
    await flushPromises()
    expect(calls.some((c) => c.path === 'connections')).toBe(true)
    expect(useTabsStore().tabs.some((tab) => tab.kind === 'connection')).toBe(true)
  })

  it('reads the backup a send dialog is for when no list holds it', async () => {
    mockApi({
      'GET backups': () => [200, [BACKUP()]],
      'GET backup-destinations': () => [200, [NAS]],
    })
    mountApp(WorkspaceDialogs)
    useWorkspaceDialogs().open({ kind: 'backupSend', backupId: 'b1', connectionId: 'c1' })
    await flushPromises()
    await settle(100)
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(BACKUP().name)
  })
})

describe('C23: a destination’s list after a delete', () => {
  it('never lists a backup twice once later pages shift, and Undo after leaving the page restores nothing', async () => {
    let gone = false
    const { calls } = mockApi({
      'GET backup-destinations/d1/backups': (_b, url) =>
        url.searchParams.get('cursor') === 'c2'
          ? [200, { items: [r(3)], cursor: null }]
          : [200, { items: gone ? [r(1), r(3)] : [r(1), r(2)], cursor: gone ? null : 'c2' }],
      'DELETE backup-destinations/d1/backups/k2': () => {
        gone = true
        return [204]
      },
    })
    mountApp(RemoteList, { props: { destination: S3, connectionId: 'c1', db: 'shop', canRestore: true } })
    mountApp(ToastHost)
    await flushPromises()
    button(t('backup.remote.more')).click()
    await flushPromises()
    const keys = () => [...document.querySelectorAll('[data-remote-row]')].map((x) => x.textContent)
    const row2 = [...document.querySelectorAll<HTMLElement>('[data-remote-row]')].find((x) =>
      x.textContent?.includes('mm-2.mmbak'),
    )!
    row2.querySelector<HTMLButtonElement>('[data-action="delete"]')!.click()
    await flushPromises()
    window.dispatchEvent(new Event('pagehide'))
    await flushPromises()
    const pageshow = new Event('pageshow') as Event & { persisted: boolean }
    Object.defineProperty(pageshow, 'persisted', { value: true })
    window.dispatchEvent(pageshow)
    await flushPromises()
    const undo = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Undo')
    undo?.click()
    await flushPromises()
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1)
    expect(keys().some((k) => k?.includes('mm-2.mmbak'))).toBe(false)
    const listed = keys()
    expect(new Set(listed).size).toBe(listed.length)
  })
})

// Follow-up after fixer B: the server's new fields and reasons, and a failed fetch that resumes.
describe('follow-up: reasons that surface on copies, listings and dump reports', () => {
  it('says each new copy failure reason in words, in both languages', async () => {
    const tr = (await import('../src/i18n/locales/tr.json')).default as typeof en
    const codes = [
      'destination_encrypted_only',
      'destination_personal_plain',
      'job_time',
      'interrupted',
      'cursor',
      // Review of db45c424 (M-1): a send whose own file could not be read.
      'body',
    ]
    for (const code of codes)
      for (const locale of [en, tr])
        expect((locale.destinations.reason as Record<string, string>)[code], code).toBeTruthy()
    mountApp(CopyBadges, {
      props: {
        copies: [
          {
            id: 'k1',
            destinationId: 'd1',
            destinationName: 'Offsite S3',
            state: 'failed',
            sent: 0,
            size: 1,
            error: 'Offsite S3 accepts encrypted backups only',
            reason: 'destination_encrypted_only',
            completedAt: null,
          },
          {
            id: 'k2',
            destinationId: 'd2',
            destinationName: 'NAS',
            state: 'failed',
            sent: 0,
            size: 1,
            error: 'The send was interrupted (the server restarted)',
            reason: 'interrupted',
            completedAt: null,
          },
        ],
      },
    })
    await flushPromises()
    expect(text()).toContain(t('destinations.reason.destination_encrypted_only'))
    expect(text()).toContain(t('destinations.reason.interrupted'))
    expect(text()).not.toContain(t('destinations.reason.provider'))
  })

  it('says a listing over the limit in words, in the list and in the picker', async () => {
    mockApi({
      'GET backup-destinations/d1/backups': () => [
        429,
        { code: 'RATE_LIMITED', message: 'Too many requests', details: { retryAfterMs: 30_000 } },
      ],
      'GET backup-destinations/d2/backups': () => [
        409,
        { code: 'CONFLICT', message: '2 uploads are already running', details: { reason: 'upload_busy' } },
      ],
    })
    mountApp(RemoteList, { props: { destination: S3, connectionId: 'c1', canRestore: true } })
    mountApp(RemoteList, { props: { destination: NAS, connectionId: 'c1', canRestore: true } })
    mountApp(RemoteSourcePicker, { props: { destinations: [S3] } })
    await flushPromises()
    const alerts = [...document.querySelectorAll('[role="alert"]')].map((a) => a.textContent ?? '')
    expect(alerts.filter((a) => a.includes(t('backup.remote.tooMany')))).toHaveLength(2)
    expect(alerts.some((a) => a.includes(t('backup.remote.listBusy')))).toBe(true)
    expect(alerts.join(' ')).not.toContain('uploads')
  })

  it('says, in the reader’s words, why a backup’s send could not start', async () => {
    i18n.global.locale.value = 'tr'
    mockApi({
      'GET transfer/jobs/jd/report': () => [
        200,
        {
          kind: 'dump',
          backupId: 'b1',
          sendJobId: null,
          sendError: 'The account that started this backup can no longer send it',
        },
      ],
    })
    const Outcomes = defineComponent(() => {
      useJobOutcomes()
      return () => h('div')
    })
    mountApp(Outcomes)
    mountApp(ToastHost)
    const store = useJobsStore()
    store.upsert(JOB({ id: 'jd', kind: 'backup.dump', state: 'running' }))
    store.upsert(JOB({ id: 'jd', kind: 'backup.dump', state: 'done', finishedAt: Date.now() }))
    await flushPromises()
    expect(text()).toContain(i18n.global.t('backup.send.accountGone'))
    expect(text()).not.toContain('can no longer send it')
  })
})

describe('follow-up: a failed fetch keeps its bytes for a resume (B26)', () => {
  const UPLOAD = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
  const handlers = () => ({
    'GET connections': (): [number, unknown] => [200, CONNS],
    'GET backups': (): [number, unknown] => [200, []],
    'GET backup-destinations': (): [number, unknown] => [200, [S3]],
    'POST backup-destinations/d1/backups/fetch': (): [number, unknown] => [
      202,
      { uploadId: UPLOAD, job: JOB({ id: 'jf', kind: 'backup.fetch' }), verified: true },
    ],
    'POST backups/inspect': (): [number, unknown] => [200, { state: 'waiting', received: 0 }],
    [`DELETE backups/uploads/${UPLOAD}`]: (): [number, unknown] => [204, undefined],
  })

  it('does not discard the upload of a failed fetch, even when the sheet closes at once', async () => {
    const { calls } = mockApi(handlers())
    const { wrapper } = mountApp(BackupRestoreSheet, {
      props: { connectionId: 'c1', remote: { destinationId: 'd1', key: REMOTE().key, name: 'x.mmbak' } },
    })
    await flushPromises()
    // The failure and the close in the same moment: no watcher has run yet.
    useJobsStore().upsert(JOB({ id: 'jf', kind: 'backup.fetch', state: 'failed', error: 'x', finishedAt: 2 }))
    wrapper.unmount()
    await flushPromises()
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    expect(calls.some((c) => c.path === 'jobs/jf/cancel')).toBe(false)
  })

  it('still discards a finished download nobody restores', async () => {
    const { calls } = mockApi(handlers())
    const { wrapper } = mountApp(BackupRestoreSheet, {
      props: { connectionId: 'c1', remote: { destinationId: 'd1', key: REMOTE().key, name: 'x.mmbak' } },
    })
    await flushPromises()
    useJobsStore().upsert(JOB({ id: 'jf', kind: 'backup.fetch', state: 'done', finishedAt: 2 }))
    await flushPromises()
    wrapper.unmount()
    await flushPromises()
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual([
      `backups/uploads/${UPLOAD}`,
    ])
  })
})

describe('follow-up: verification as the server reports it (C27, B34)', () => {
  it('trusts DestinationSummary.verify over the type', async () => {
    mountApp(WhereSection, {
      props: {
        destinations: [
          { ...DAV, verify: 'readBack' },
          {
            id: 'd4',
            name: 'Bucket',
            type: 's3',
            level: 'send',
            policy: { encryptedOnly: false },
            verify: 'size',
          },
        ],
        modelValue: ['d3', 'd4'],
        deleteLocal: true,
        format: 'mmbak',
        plainPersonal: false,
      },
    })
    await flushPromises()
    expect(text()).toContain(t('backup.where.verifiedSize', { names: 'Bucket' }))
    expect(text()).not.toContain('Cloud and Bucket')
  })
})

describe('a send stopped before any destination failed (short names review 13, M-2)', () => {
  it('says the local copy was kept so it can be sent again, not that a destination failed', async () => {
    mockApi({})
    const Outcomes = defineComponent(() => {
      useJobOutcomes()
      return () => h('div')
    })
    mountApp(Outcomes)
    mountApp(ToastHost)
    const store = useJobsStore()
    store.upsert(JOB({ state: 'running' }))
    store.upsert(
      JOB({
        state: 'failed',
        error: 'The send ran longer than allowed',
        localKept: true,
        finishedAt: Date.now(),
      }),
    )
    await flushPromises()
    expect(text()).toContain(t('backup.send.localKeptStopped'))
    expect(text()).not.toContain(t('backup.send.localKeptPlain'))
  })
})

describe('a cancelled send that kept its only local copy (short names review 14, M3)', () => {
  it('says the copy stayed, in the toast and on its row', async () => {
    mockApi({})
    const Outcomes = defineComponent(() => {
      useJobOutcomes()
      return () => h('div')
    })
    mountApp(Outcomes)
    mountApp(ToastHost)
    const store = useJobsStore()
    store.upsert(JOB({ state: 'running' }))
    store.upsert(JOB({ state: 'cancelled', localKept: true, finishedAt: Date.now() }))
    await flushPromises()
    // Short names review 15 (M2): one sentence after the other, not run together.
    expect(text()).toContain(t('backup.send.cancelledKept', { name: JOB().target }))
    document.body.innerHTML = ''
    mountApp(JobRow, {
      props: { job: JOB({ state: 'cancelled', localKept: true, finishedAt: 1 }), now: Date.now() },
    })
    await flushPromises()
    expect(text()).toContain(t('backup.send.localKeptStopped'))
    document.body.innerHTML = ''
    const JobDetails = (await import('../src/jobs/JobDetails.vue')).default
    mountApp(JobDetails, {
      props: { job: JOB({ state: 'cancelled', localKept: true, finishedAt: 1 }), now: Date.now() },
    })
    await flushPromises()
    expect(text()).toContain(t('backup.send.localKeptStopped'))
  })
})

describe('follow-up: a finished send that kept the local copy (B12)', () => {
  it('says the local copy stayed even when this send itself completed', async () => {
    mockApi({})
    const Outcomes = defineComponent(() => {
      useJobOutcomes()
      return () => h('div')
    })
    mountApp(Outcomes)
    mountApp(ToastHost)
    const store = useJobsStore()
    store.upsert(JOB({ state: 'running' }))
    store.upsert(JOB({ state: 'done', localKept: true, finishedAt: Date.now() }))
    await flushPromises()
    expect(text()).toContain(t('backup.send.localKeptPlain'))
  })
})

// Final gate: the copy badge said 42% where the job row said 41% for the same bytes.
describe('final gate: one percentage for one transfer', () => {
  it('floors a sending copy like the job row, never showing 100% before it is done', () => {
    mountApp(CopyBadges, {
      props: {
        copies: [
          {
            id: 'k1',
            destinationId: 'd1',
            destinationName: 'Disk',
            state: 'sending',
            sent: 4199,
            size: 10_000,
            error: null,
            reason: null,
            completedAt: null,
          },
          {
            id: 'k2',
            destinationId: 'd2',
            destinationName: 'Cloud',
            state: 'sending',
            sent: 9999,
            size: 10_000,
            error: null,
            reason: null,
            completedAt: null,
          },
        ],
      },
    })
    const bars = [...document.querySelectorAll('[role="progressbar"]')].map((b) =>
      b.getAttribute('aria-valuenow'),
    )
    expect(bars).toEqual(['41', '99'])
  })
})
