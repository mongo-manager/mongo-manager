// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { ALERT_EVENTS, type DrillReport, type DumpPlan } from '@mongo-manager/shared'
import ScheduleEditor from '../src/schedules/ScheduleEditor.vue'
import RunHistory from '../src/schedules/RunHistory.vue'
import ImportReport from '../src/transfer/ImportReport.vue'
import DrillLeftovers from '../src/backup/DrillLeftovers.vue'
import { useDialogStore } from '../src/stores/dialogs'
import { kindKey } from '../src/jobs/labels'
import { i18n } from '../src/i18n'
import { mockApi, mountApp, type Handler } from './support/app'
import { button, byLabel, check, typeInto } from './support/dom'
import { KEY, RUN, SCHEDULE } from './support/schedules'

/** W4 item 4: scheduled restore drills in the schedule editor, the run history and the report. */
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
const ALL = [
  'documents:read',
  'documents:write',
  'databases:write',
  'indexes:write',
  'jobs:run',
  'data:export',
]
const PLAN: DumpPlan = {
  planHash: 'a'.repeat(64),
  namespaces: [
    { db: 'shop', coll: 'orders', type: 'collection', documents: 3, bytes: 100, ttl: [], personal: [] },
  ],
  estimate: { bytes: 100, fileBytes: 25, seconds: null },
  tools: { available: false, reason: 'missing' },
  masked: false,
  recommended: { format: 'mmbak', engine: 'builtin', reason: null },
  checks: [{ key: 'permissions', level: 'ok' }],
  refusals: [],
}
const api = (more: Record<string, Handler> = {}) =>
  mockApi({
    'GET connections': () => [
      200,
      [{ id: 'c1', name: 'Production', access: 'editor', permissions: ALL, export: true }],
    ],
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
    'POST backup-schedules/preview': () => [
      200,
      { runs: [Date.now() + 3600_000], words: 'Every day at 02:00', problem: null, removals: [] },
    ],
    ...more,
  })

describe('restore drills in the schedule editor (W4.4)', () => {
  it('turns a drill on every N runs and sends it, off by default', async () => {
    const { calls } = api({ 'POST backup-schedules': () => [201, SCHEDULE({ drill: { everyRuns: 7 } })] })
    mountApp(ScheduleEditor, { props: { connectionId: 'c1', db: 'shop' } })
    await settle()
    for (let i = 0; i < 3; i++) {
      button('Next').click()
      await settle()
    }
    document.querySelector<HTMLButtonElement>('[data-destination="d1"]')!.click()
    await settle()
    button('Next').click()
    await settle()
    // Retention step: the drill setting.
    const toggle = byLabel('Test that backups restore')
    expect(toggle.checked).toBe(false)
    await check(toggle, true)
    await settle()
    await typeInto(byLabel('Every how many runs'), '7')
    await settle()
    button('Next').click()
    await settle()
    expect(document.querySelector('[data-test="summary"]')!.textContent).toContain(
      'Restore drill every 7 runs',
    )
    button('Create schedule').click()
    await settle()
    const sent = calls.find((c) => c.method === 'POST' && c.path === 'backup-schedules')!.body
    expect(sent).toMatchObject({ drill: { everyRuns: 7 } })
  })

  it('sends no drill when it stays off', async () => {
    const { calls } = api({ 'POST backup-schedules': () => [201, SCHEDULE()] })
    mountApp(ScheduleEditor, { props: { connectionId: 'c1', db: 'shop' } })
    await settle()
    for (let i = 0; i < 3; i++) {
      button('Next').click()
      await settle()
    }
    document.querySelector<HTMLButtonElement>('[data-destination="d1"]')!.click()
    await settle()
    button('Next').click()
    await settle()
    button('Next').click()
    await settle()
    button('Create schedule').click()
    await settle()
    expect(calls.find((c) => c.method === 'POST' && c.path === 'backup-schedules')!.body).toMatchObject({
      drill: null,
    })
  })
})

describe('restore drills in the run history (W4.4)', () => {
  it('says whether a run’s drill passed, failed and where, or why it was skipped', async () => {
    api({
      'GET backup-schedules/s1/runs': () => [
        200,
        [
          RUN({
            id: 'r3',
            drill: { state: 'failed', reason: 'drill_mismatch', mismatched: ['shop.orders'], namespaces: 2 },
          }),
          RUN({ id: 'r2', drill: { state: 'skipped', reason: 'drill_rights' } }),
          RUN({ id: 'r1', drill: { state: 'passed', namespaces: 2 } }),
        ],
      ],
    })
    mountApp(RunHistory, { props: { schedule: SCHEDULE({ drill: { everyRuns: 1 } }) } })
    await settle()
    const text = (id: string) =>
      document.querySelector(`[data-run="${id}"] [data-test="drill"]`)?.textContent ?? ''
    expect(text('r1')).toContain('Restore drill passed')
    expect(text('r3')).toContain('Restore drill failed')
    expect(text('r3')).toContain('shop.orders')
    expect(text('r2')).toContain('not allowed to write')
  })
})

// W4 review I4: a failed drill, two-way conflicts and Watch matches are events an alert rule follows.
describe('alert events from W4', () => {
  it('are offered to alert rules, named in English and Turkish', () => {
    for (const e of ['backup.drillFailed', 'liveSync.conflicts', 'watch.matched'])
      expect(ALERT_EVENTS as readonly string[]).toContain(e)
    for (const locale of ['en', 'tr'] as const)
      for (const e of ALERT_EVENTS)
        expect(i18n.global.te(`alerts.events.${e}`, locale), `${locale} ${e}`).toBe(true)
  })
})

describe('the drill report and job (W4.4)', () => {
  it('names the job kind', () => {
    expect(i18n.global.t(kindKey('backup.drill'))).toBe('Restore drill')
  })

  it('shows each namespace with what the backup held and what came back', () => {
    const report: DrillReport = {
      kind: 'drill',
      backupId: 'b1',
      backupName: 'shop.mmbak',
      ok: false,
      namespaces: [
        {
          ns: 'shop.orders',
          type: 'collection',
          archived: 25,
          restored: 24,
          crc: 'ok',
          contents: 'mismatch',
        },
        { ns: 'shop.v', type: 'view', archived: 0, restored: 0, crc: 'absent', contents: 'skipped' },
      ],
      startedAt: 1,
      finishedAt: 2,
    }
    mountApp(ImportReport, { props: { jobId: 'j1', report } })
    const table = document.querySelector('[data-test="drill-report"]')!
    expect(table.textContent).toContain('shop.orders')
    expect(table.textContent).toContain('25')
    expect(table.textContent).toContain('24')
    expect(table.textContent).toContain('Differs')
    expect(document.body.textContent).toContain('The drill found differences')
    expect(document.querySelector('[data-test="drill-cleanup"]')).toBeNull()
  })

  // W4 review I2: a scratch database left behind is named, to be dropped by hand.
  it('says when its scratch database is still there', () => {
    const report: DrillReport = {
      kind: 'drill',
      backupId: 'b1',
      backupName: 'shop.mmbak',
      ok: false,
      code: 'drill_cleanup',
      cleanup: 'failed',
      scratch: 'mm_drill_0123456789ab',
      namespaces: [],
      startedAt: 1,
      finishedAt: 2,
    }
    mountApp(ImportReport, { props: { jobId: 'j1', report } })
    expect(document.querySelector('[data-test="drill-cleanup"]')!.textContent).toContain(
      'mm_drill_0123456789ab could not be dropped',
    )
  })
})

// W4 re-review (minor): a scratch database a drill left behind, dropped from the app.
describe('a drill’s leftover scratch database', () => {
  it('is named to the connection’s admins and dropped by its typed name', async () => {
    let left = ['mm_drill_abcdefabcdef']
    const { calls } = mockApi({
      'GET connections/c1/backup/drill-leftovers': () => [
        200,
        { databases: left.map((name) => ({ name, sizeOnDisk: 4096 })), running: false },
      ],
      'POST connections/c1/backup/drill-leftovers/drop': () => {
        left = []
        return [200, { dropped: 'mm_drill_abcdefabcdef' }]
      },
    })
    mountApp(DrillLeftovers, { props: { connectionId: 'c1' } })
    await flushPromises()
    expect(document.querySelector('[data-drill-leftover]')!.textContent).toContain('mm_drill_abcdefabcdef')
    button('Drop…').click()
    await flushPromises()
    expect(useDialogStore().current!.requireText).toBe('mm_drill_abcdefabcdef')
    useDialogStore().settle(true)
    await flushPromises()
    expect(calls.find((c) => c.path.endsWith('/drop'))!.body).toEqual({
      name: 'mm_drill_abcdefabcdef',
      confirm: 'mm_drill_abcdefabcdef',
    })
    expect(document.querySelector('[data-drill-leftovers]')).toBeNull()
  })
})
