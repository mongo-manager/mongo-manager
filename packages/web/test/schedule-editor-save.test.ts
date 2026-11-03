import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { BackupView, DumpPlan } from '@mongo-manager/shared'
import ScheduleEditor from '../src/schedules/ScheduleEditor.vue'
import BackupsCard from '../src/backup/BackupsCard.vue'
import DialogHost from '../src/ds/DsConfirmHost.vue'
import { useWorkspaceDialogs } from '../src/stores/workspaceDialogs'
import { i18n } from '../src/i18n'
import { mockApi, mountApp, type Handler } from './support/app'
import { button } from './support/dom'
import { KEY, SCHEDULE } from './support/schedules'

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
  vi.useFakeTimers({ shouldAdvanceTime: true })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})
const settle = async (ms = 400) => {
  await vi.advanceTimersByTimeAsync(ms)
  await flushPromises()
}
const text = () => document.body.textContent ?? ''
const ALL = [
  'documents:read',
  'documents:write',
  'databases:write',
  'indexes:write',
  'jobs:run',
  'data:export',
]
const CONNS = [{ id: 'c1', name: 'Production', access: 'editor', permissions: ALL, export: true }]
const PLAN: DumpPlan = {
  planHash: 'a'.repeat(64),
  namespaces: [
    { db: 'shop', coll: 'orders', type: 'collection', documents: 3, bytes: 100, ttl: [], personal: [] },
  ],
  estimate: { bytes: 100, fileBytes: 25, seconds: null },
  tools: { available: false, reason: 'missing' },
  masked: false,
  recommended: { format: 'mmbak', engine: 'builtin', reason: null },
  checks: [
    { key: 'permissions', level: 'ok' },
    { key: 'destination', level: 'ok', params: { name: 'Offsite' } },
  ],
  refusals: [],
}
const base = (more: Record<string, Handler> = {}) =>
  mockApi({
    'GET connections': () => [200, CONNS],
    'GET connections/c1/databases': () => [
      200,
      { databases: [{ name: 'shop', sizeOnDisk: 1, empty: false }], totalSize: 1 },
    ],
    'GET connections/c1/databases/shop/collections': () => [
      200,
      [{ name: 'orders', type: 'collection', options: {}, readOnly: false }],
    ],
    'GET backup-keys': () => [200, [KEY()]],
    'GET backup-destinations': () => [
      200,
      [
        {
          id: 'd1',
          name: 'Offsite',
          type: 'folder',
          level: 'send',
          policy: { encryptedOnly: true },
          coldStorage: false,
        },
      ],
    ],
    'GET backups/usage': () => [200, { used: 0, quota: 20 * 1024 ** 3, ttlHours: 24, chunkMb: 64 }],
    'POST connections/c1/backup/plan': () => [200, PLAN],
    ...more,
  })
const next = async () => {
  button('Next').click()
  await settle()
}

describe('the schedule editor (phase 3d-3c spec §5)', () => {
  it('creates a schedule step by step, with everything in words and the server’s checks', async () => {
    const { calls } = base({ 'POST backup-schedules': () => [201, SCHEDULE()] })
    const { wrapper } = mountApp(ScheduleEditor, { props: { connectionId: 'c1', db: 'shop' } })
    await settle()
    expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-labelledby')).toBeTruthy()
    await next() // What → When
    await next() // When → Protection
    expect(text()).toContain('Key 1 · K-1a2b3c4d')
    await next() // Protection → Where
    expect(button('Next').disabled).toBe(true)
    document.querySelector<HTMLButtonElement>('[data-destination="d1"]')!.click()
    await settle()
    // Final review minor 22: "keep on the server too" says the space it will use, not only what is free.
    expect(text()).toMatch(/about [\d.,]+ (B|kB|KB|MB|GB) for the \d+ backups it keeps/)
    await next() // Where → Retention
    await next() // Retention → Summary
    const summary = document.querySelector('[data-test="summary"]')!.textContent ?? ''
    expect(summary).toContain('shop')
    expect(summary).toMatch(/Every day at 02:00/)
    expect(summary).toContain('Offsite')
    expect(summary).toContain('K-1a2b3c4d')
    expect(text()).toContain('Offsite')
    button('Create schedule').click()
    await settle()
    const sent = calls.find((c) => c.method === 'POST' && c.path === 'backup-schedules')!.body
    expect(sent).toMatchObject({
      name: 'shop backups',
      connectionId: 'c1',
      dump: { scope: { kind: 'database', db: 'shop', views: true } },
      format: 'mmbak',
      cadence: { kind: 'daily', times: ['02:00'] },
      destinations: ['d1'],
      keepOnServer: false,
      retention: { last: 7, daily: 14, weekly: 8, monthly: 12 },
    })
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  // Second review of the personal-data rework (A): planned as the owner views the data, a plain format
  // was offered that the save refuses (the schedule runs on its own, where that view masks nothing).
  it('plans the backup as the schedule will run it', async () => {
    const asked: Array<string | null> = []
    base({
      'POST connections/c1/backup/plan': (_body, url) => {
        asked.push(url.searchParams.get('asScheduled'))
        return [200, PLAN]
      },
    })
    mountApp(ScheduleEditor, { props: { connectionId: 'c1', db: 'shop' } })
    await settle()
    expect(asked.length).toBeGreaterThan(0)
    expect(asked.every((v) => v === '1')).toBe(true)
  })

  // Third review (N4): the save judges by the rules' names; a rule naming a collection no longer there
  // reaches no namespace of the plan, and plain was offered all the same.
  it('offers no plain format where the plan says the schedule would hold personal data', async () => {
    base({
      'POST connections/c1/backup/plan': () => [200, { ...PLAN, scheduledPersonal: true }],
    })
    mountApp(ScheduleEditor, { props: { connectionId: 'c1', db: 'shop' } })
    await settle()
    await next() // What → When
    await next() // When → Protection
    expect(document.querySelector<HTMLInputElement>('input[name="format"][value="gzip"]')!.disabled).toBe(
      true,
    )
    expect(text()).toContain('The scope holds personal data')
  })

  it('edits a saved schedule, and asks before a policy that removes many', async () => {
    let patches = 0
    const { calls } = base({
      'GET backup-schedules': () => [200, { enabled: true, schedules: [SCHEDULE()] }],
      'POST backup-schedules/preview': () => [
        200,
        { runs: [], words: null, problem: null, removals: [{ location: 'd1', name: 'Offsite', count: 14 }] },
      ],
      'PATCH backup-schedules/s1': () =>
        ++patches === 1
          ? [409, { code: 'CONFLICT', message: 'x', details: { reason: 'retention_confirm', count: 14 } }]
          : [200, SCHEDULE({ retention: { last: 7, daily: 30, weekly: 0, monthly: 0 } })],
    })
    const { wrapper } = mountApp(ScheduleEditor, { props: { scheduleId: 's1', connectionId: 'c1' } })
    mountApp(DialogHost)
    await settle()
    expect(text()).toContain('Edit Nightly shop')
    // Final review minor 5: a Turkish title that reads as Turkish.
    i18n.global.locale.value = 'tr'
    await flushPromises()
    expect(text()).toContain('Zamanlamayı düzenle: Nightly shop')
    i18n.global.locale.value = 'en'
    await flushPromises()
    ;[...document.querySelectorAll<HTMLButtonElement>('nav button')]
      .find((b) => b.textContent?.includes('Retention'))!
      .click()
    await settle()
    document.querySelector<HTMLInputElement>('input[name="retention"][value="daily30"]')!.click()
    await settle()
    expect(text()).toContain('These settings would remove 14 backups now.')
    button('Save changes').click()
    await settle()
    expect(text()).toContain('Remove 14 backups?')
    button('Save and remove').click()
    await settle()
    const sent = calls.filter((c) => c.method === 'PATCH').map((c) => c.body as Record<string, unknown>)
    expect(sent).toHaveLength(2)
    expect(sent[0]).not.toHaveProperty('connectionId')
    expect(sent[1]).toMatchObject({ confirmRemovals: 14, retention: { daily: 30, weekly: 0 } })
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  // Final review minor 20: a schedule deleted meanwhile left an endless skeleton.
  it('says a schedule that no longer exists is gone, instead of loading for ever', async () => {
    base({ 'GET backup-schedules': () => [200, { enabled: true, schedules: [] }] })
    mountApp(ScheduleEditor, { props: { scheduleId: 'gone', connectionId: 'c1' } })
    await settle()
    expect(text()).toContain('This schedule no longer exists.')
    expect(document.querySelector('[aria-busy="true"]')).toBeNull()
  })

  it('asks before closing a changed editor', async () => {
    base()
    mountApp(ScheduleEditor, { props: { connectionId: 'c1', db: 'shop' } })
    await settle()
    const name = document.querySelector<HTMLInputElement>('input[maxlength="80"]')!
    name.value = 'Renamed'
    name.dispatchEvent(new Event('input'))
    await settle()
    button('Cancel').click()
    await settle()
    expect(text()).toContain('Discard these settings?')
  })
})

describe('scheduling from a Backups card (spec §5)', () => {
  it('offers Schedule… and marks a scheduled backup with its schedule’s name', async () => {
    const backup: BackupView = {
      id: 'b1',
      name: 'shop-20261004-020000.mmbak',
      jobId: 'j1',
      connectionId: 'c1',
      scope: { kind: 'database', db: 'shop', views: true },
      engine: 'builtin',
      format: 'mmbak',
      masked: false,
      anonymous: false,
      size: 5_000,
      sha256: 'x',
      namespaces: 1,
      startedAt: Date.now() - 3600_000,
      finishedAt: Date.now() - 3500_000,
      expiresAt: Date.now() + 3600_000,
      copies: [],
      schedule: { id: 's1', name: 'Nightly shop' },
    }
    mockApi({
      'GET connections': () => [200, CONNS],
      'GET backups': () => [200, [backup]],
      'GET backups/usage': () => [200, { used: 0, quota: 20 * 1024 ** 3, ttlHours: 24, chunkMb: 64 }],
    })
    mountApp(BackupsCard, { props: { connectionId: 'c1', db: 'shop' } })
    await flushPromises()
    expect(document.querySelector('[data-backup-row]')?.textContent).toContain('Nightly shop')
    button('Schedule…').click()
    expect(useWorkspaceDialogs().current).toEqual({ kind: 'backupSchedule', connectionId: 'c1', db: 'shop' })
  })
})
