// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { AlertView, ReportView } from '@mongo-manager/shared/browser'
import ReportsTable from '../src/alerts/ReportsTable.vue'
import ReportDialog from '../src/alerts/ReportDialog.vue'
import ToastHost from '../src/ds/DsToastHost.vue'
import DialogHost from '../src/ds/DsConfirmHost.vue'
import { alertTitle, reportCounts } from '../src/alerts/labels'
import { i18n } from '../src/i18n'
import { useSessionStore } from '../src/stores/session'
import { mockApi, mountApp } from './support/app'
import { byLabel, typeInto } from './support/dom'

/**
 * Design 2026-10-25 (C7): scheduled reports on the Alerts page — listed with when they run and what
 * they last counted, run now, made and changed in their dialog, the server's refusal said in words.
 */
beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
  const session = useSessionStore()
  session.status = { mode: 'team', authenticated: true, setupRequired: false } as never
  session.me = { id: 'u1', username: 'ada', role: 'admin', permissions: ['settings:manage'] } as never
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const REPORT: ReportView = {
  id: 'r1',
  connectionId: 'c1',
  name: 'Morning orders',
  measures: [
    { label: 'Orders', db: 'shop', coll: 'orders' },
    { label: 'Shipping', db: 'shop', coll: 'orders', filter: { status: 'shipping' } },
  ],
  cadence: { kind: 'daily', times: ['09:00'] },
  timeZone: 'Europe/Istanbul',
  enabled: true,
  channels: { inApp: true, email: false, webhooks: [] },
  nextRunAt: Date.now() + 3_600_000,
  lastRun: {
    at: Date.now() - 60_000,
    values: [
      { label: 'Orders', count: 1200 },
      { label: 'Shipping', count: 1_000_000, atLeast: true },
      { label: 'Gone', count: null, reason: 'personal_field' },
    ],
  },
  createdAt: 0,
}
const CHANNELS = { email: null, webhooks: [] }
const CONNECTIONS = [{ id: 'c1', name: 'Prod', settings: { hosts: [] } }]

describe('scheduled reports on the Alerts page (C7)', () => {
  it('lists each report with when it runs and what it last counted, and runs one now', async () => {
    const { calls } = mockApi({
      'GET alerts/reports': () => [200, [REPORT]],
      'POST alerts/reports/r1/run': () => [200, { values: [], sent: true }],
    })
    mountApp(ReportsTable, { props: { names: { c1: 'Prod' } } })
    mountApp(ToastHost)
    await flushPromises()
    const table = document.querySelector<HTMLElement>('[data-reports]')!
    expect(table.textContent).toContain('Morning orders')
    expect(table.textContent).toContain('Prod')
    // When, from now (not from 1970): the next in an hour, the last a minute ago.
    expect(table.textContent).toContain('next in 1 hour')
    const last = table.querySelector<HTMLElement>('[data-report-last]')!
    expect(last.textContent).toContain('Orders: 1,200')
    expect(last.textContent).toContain('Shipping: at least 1,000,000')
    expect(last.textContent).toContain('Gone: not counted — its filter names a personal field')
    expect(last.textContent).toContain('1 minute ago')
    table.querySelector<HTMLButtonElement>('[data-report-run]')!.click()
    await flushPromises()
    expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('alerts/reports/r1/run'))).toBe(true)
    expect(document.body.textContent).toContain('Morning orders ran: its counts were sent.')
  })

  it('makes a report from its dialog: its counts, a filter as JSON, its channels', async () => {
    const posted: unknown[] = []
    mockApi({
      'GET alerts/channels': () => [200, CHANNELS],
      'GET connections': () => [200, CONNECTIONS],
      'POST alerts/reports': (body) => {
        posted.push(body)
        return [201, REPORT]
      },
    })
    const { wrapper } = mountApp(ReportDialog)
    await flushPromises()
    await typeInto(byLabel('Name'), 'Morning orders')
    const connection = document.querySelector<HTMLSelectElement>(
      '[data-report-connection] select, select[data-report-connection]',
    )!
    connection.value = 'c1'
    connection.dispatchEvent(new Event('change'))
    await typeInto(byLabel('Label 1'), 'Shipping')
    await typeInto(byLabel('Database of count 1'), 'shop')
    await typeInto(byLabel('Collection of count 1'), 'orders')
    await typeInto(byLabel('Filter of count 1 (JSON, optional)'), '{"status": "shipping"}')
    document.querySelector<HTMLButtonElement>('[data-save-report]')!.click()
    await flushPromises()
    expect(posted).toEqual([
      expect.objectContaining({
        name: 'Morning orders',
        connectionId: 'c1',
        measures: [{ label: 'Shipping', db: 'shop', coll: 'orders', filter: { status: 'shipping' } }],
        cadence: { kind: 'daily', times: ['09:00'] },
        channels: { inApp: true, email: false, webhooks: [] },
      }),
    ])
    expect(wrapper.emitted('close')).toBeTruthy()
  })

  it('says a filter that is no JSON object, and the server’s refusal of a count, in words', async () => {
    mockApi({
      'GET alerts/channels': () => [200, CHANNELS],
      'GET connections': () => [200, CONNECTIONS],
      'PATCH alerts/reports/r1': () => [
        400,
        { code: 'VALIDATION_ERROR', message: 'x', details: { reason: 'personal_field', measure: 1 } },
      ],
    })
    mountApp(ReportDialog, { props: { existing: REPORT } })
    mountApp(DialogHost)
    await flushPromises()
    await typeInto(byLabel('Filter of count 2 (JSON, optional)'), '[1, 2]')
    document.querySelector<HTMLButtonElement>('[data-save-report]')!.click()
    await flushPromises()
    expect(document.body.textContent).toContain('Count 2: the filter is not a JSON object.')
    await typeInto(byLabel('Filter of count 2 (JSON, optional)'), '{"email": "a"}')
    document.querySelector<HTMLButtonElement>('[data-save-report]')!.click()
    await flushPromises()
    expect(document.body.textContent).toContain(
      'The report was not saved: count 2 — its filter names a personal field.',
    )
  })

  it('names a report’s run in the bell by its name', () => {
    const a = {
      event: 'report.ready',
      metric: null,
      state: 'event',
      connectionName: 'Prod',
      detail: { report: 'Morning orders', reportId: 'r1', Orders: 3 },
    } as unknown as AlertView
    expect(alertTitle(i18n.global.t, 'en', a)).toBe('Report “Morning orders” on Prod')
    // Without its names (not an administrator): the event's own words.
    expect(alertTitle(i18n.global.t, 'en', { ...a, detail: {} })).toBe('Report on Prod')
  })
})

// Review of C7a.
describe('scheduled reports on the Alerts page: the review of C7a', () => {
  const RAN: AlertView = {
    id: 'e1',
    ruleId: null,
    connectionId: 'c1',
    connectionName: 'Prod',
    metric: null,
    event: 'report.ready',
    state: 'event',
    value: null,
    threshold: null,
    startedAt: new Date().toISOString(),
    resolvedAt: null,
    acknowledgedAt: null,
    acknowledgedBy: null,
    detail: { report: 'Morning orders', reportId: 'r1', Orders: 1200, Shipping: '≥1000000' },
    deliveries: [],
    snoozed: false,
  }

  it('says a report run’s counts by their labels, never its id (M2)', () => {
    expect(reportCounts(i18n.global.t, 'en', RAN)).toBe('Orders: 1,200 · Shipping: ≥1000000')
    expect(reportCounts(i18n.global.t, 'en', { ...RAN, detail: {} })).toBeNull()
  })

  it('checks a count’s label as the server does, and says the switch’s refusal in words (M8)', async () => {
    mockApi({
      'GET alerts/channels': () => [200, CHANNELS],
      'GET connections': () => [200, CONNECTIONS],
    })
    mountApp(ReportDialog, {
      props: {
        existing: { ...REPORT, measures: [REPORT.measures[0]!, { ...REPORT.measures[1]!, label: 'Orders' }] },
      },
    })
    await flushPromises()
    document.querySelector<HTMLButtonElement>('[data-save-report]')!.click()
    await flushPromises()
    expect(document.body.textContent).toContain('Count 2: another count has that label.')
  })

  it('says a report due now as such, a refused switch in words, and a run that went nowhere', async () => {
    mockApi({
      'GET alerts/reports': () => [200, [{ ...REPORT, nextRunAt: Date.now() - 60_000 }]],
      'PATCH alerts/reports/r1': () => [
        400,
        { code: 'VALIDATION_ERROR', message: 'x', details: { reason: 'personal_field' } },
      ],
      'POST alerts/reports/r1/run': () => [200, { values: [], sent: false }],
    })
    mountApp(ReportsTable, { props: { names: { c1: 'Prod' } } })
    mountApp(ToastHost)
    await flushPromises()
    expect(document.querySelector('[data-reports]')!.textContent).toContain('next due now')
    document
      .querySelector<HTMLButtonElement>(
        '[data-reports] [role="switch"], [data-reports] input[type="checkbox"]',
      )!
      .click()
    await flushPromises()
    expect(document.body.textContent).toContain(
      'The report was not saved: its filter names a personal field.',
    )
    document.querySelector<HTMLButtonElement>('[data-report-run]')!.click()
    await flushPromises()
    expect(document.body.textContent).toContain('its counts were only kept')
  })
})
