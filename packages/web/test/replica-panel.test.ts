// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ReplicaSetPanel from '../src/monitor/ReplicaSetPanel.vue'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'
import { chartOptions, pick } from './support/dom'

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const ROUTE = 'GET connections/c1/server/replica'
const member = (over: object) => ({
  name: 'db1:27017',
  state: 'SECONDARY',
  healthy: true,
  self: false,
  uptimeSeconds: 100,
  lagSeconds: 0,
  pingMs: 2,
  lastHeartbeat: new Date(Date.now() - 3_000).toISOString(),
  lastHeartbeatMessage: null,
  syncSource: 'db0:27017',
  priority: 1,
  hidden: false,
  votes: 1,
  arbiter: false,
  ...over,
})
const replica = (over: object = {}) => ({
  mode: 'replicaSet',
  set: 'rs0',
  date: new Date().toISOString(),
  primary: 'db0:27017',
  majorityLagSeconds: 0,
  oplogWindowHours: 48.5,
  members: [
    member({
      name: 'db0:27017',
      state: 'PRIMARY',
      self: true,
      pingMs: null,
      lastHeartbeat: null,
      syncSource: null,
    }),
    member({ name: 'db1:27017', lagSeconds: 12 }),
    member({ name: 'db2:27017', lagSeconds: 75 }),
    member({
      name: 'db3:27017',
      state: '(not reachable/healthy)',
      healthy: false,
      lagSeconds: null,
      lastHeartbeatMessage: 'Connection refused',
    }),
    member({ name: 'db4:27017', state: 'ARBITER', arbiter: true, lagSeconds: null, priority: 0 }),
  ],
  ...over,
})

/** A member's row of the members table (UI redesign R3: a DsDataTable). */
const row = (name: string) => document.querySelector(`[data-member="${name}"]`)!.closest('tr')!

describe('the Replica set section (phase 1j spec §3)', () => {
  it('shows the primary, and each member with its state, health and lag coloured by threshold', async () => {
    mockApi({ [ROUTE]: () => [200, replica()] })
    mountApp(ReplicaSetPanel, { props: { connectionId: 'c1' } })
    await flushPromises()
    expect(document.body.textContent).toContain('rs0')
    // Minor 8: every value in the summary has its term.
    const terms = [...document.querySelectorAll('dl > div')].map((d) => [
      d.querySelector('dt')?.textContent?.trim(),
      d.querySelector('dd')?.textContent?.trim(),
    ])
    expect(terms).toContainEqual(['Primary', 'db0:27017'])
    // Minor 9: the table says what it lists, and health is a column of its own, not only a colour.
    expect(document.querySelector('table[aria-label]')!.getAttribute('aria-label')).toBe('Members of rs0')
    const health = (name: string) => row(name).querySelector('[data-health]')!.textContent!.trim()
    expect([health('db0:27017'), health('db3:27017')]).toEqual(['Up', 'Down'])
    expect(document.body.textContent).toContain('48.5 h')
    expect(row('db0:27017').querySelector('[data-tone]')!.getAttribute('data-tone')).toBe('primary')
    expect(row('db1:27017').querySelector('[data-tone]')!.getAttribute('data-tone')).toBe('secondary')
    expect(row('db3:27017').querySelector('[data-tone]')!.getAttribute('data-tone')).toBe('down')
    expect(row('db4:27017').querySelector('[data-tone]')!.getAttribute('data-tone')).toBe('arbiter')
    const lag = (name: string) => row(name).querySelector('[data-lag]')!
    expect(lag('db0:27017').getAttribute('data-lag')).toBe('ok')
    expect(lag('db1:27017').getAttribute('data-lag')).toBe('warn')
    expect(lag('db2:27017').getAttribute('data-lag')).toBe('bad')
    expect(lag('db3:27017').textContent).toBe('—')
    expect(row('db3:27017').textContent).toContain('Connection refused')
    // UI redesign R3: the state is a status dot with its words; the lag a badge in the threshold's tone.
    const dot = (name: string) => row(name).querySelector('[data-tone] .sr-only')!.textContent
    expect([dot('db0:27017'), dot('db3:27017')]).toEqual(['PRIMARY', '(not reachable/healthy)'])
    expect(lag('db1:27017').firstElementChild!.className).toContain('bg-warning-soft')
    expect(lag('db2:27017').firstElementChild!.className).toContain('bg-danger-soft')
    expect(row('db1:27017').textContent).toContain('3 s ago')
  })

  it('says loudly when the set has no primary', async () => {
    mockApi({ [ROUTE]: () => [200, replica({ primary: null })] })
    mountApp(ReplicaSetPanel, { props: { connectionId: 'c1' } })
    await flushPromises()
    expect(document.querySelector('[role="alert"]')!.textContent).toContain('No primary')
  })

  it('explains a standalone, a sharded cluster and a MongoDB refusal', async () => {
    for (const [answer, text] of [
      [[200, { mode: 'standalone' }], 'This server is not a replica set.'],
      // Phase 3b: a mongos shows the sharding overview instead of a note.
      [[200, { mode: 'sharded' }], 'Sharding'],
      [
        [403, { code: 'FORBIDDEN', message: 'x', details: { reason: 'mongo_not_permitted' } }],
        'the account needs the clusterMonitor role',
      ],
    ] as const) {
      mockApi({ [ROUTE]: () => answer as [number, unknown] })
      const { wrapper } = mountApp(ReplicaSetPanel, { props: { connectionId: 'c1' } })
      await flushPromises()
      expect(document.body.textContent).toContain(text)
      wrapper.unmount()
      document.body.innerHTML = ''
    }
  })

  it('charts the lag of each data-bearing member over the polls, every 5 seconds', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })
    let lag = 12
    mockApi({
      [ROUTE]: () => [
        200,
        replica({
          members: replica().members.map((m) => (m.name === 'db1:27017' ? { ...m, lagSeconds: lag++ } : m)),
        }),
      ],
    })
    mountApp(ReplicaSetPanel, { props: { connectionId: 'c1' } })
    await flushPromises()
    await vi.advanceTimersByTimeAsync(5_000)
    await flushPromises()
    const chart = chartOptions().find((c) => c.label.startsWith('Replication lag'))!
    const series = pick(chart.option, 'series') as Array<{ name: string; data: Array<number | null> }>
    expect(series.map((s) => s.name)).toEqual(['db0:27017', 'db1:27017', 'db2:27017', 'db3:27017'])
    expect(series.find((s) => s.name === 'db1:27017')!.data).toEqual([12, 13])
  })
})

describe('the Replica set section: review fixes (final review 1j)', () => {
  it('marks what it shows as the last answer when a poll fails, not as the current state (Critical 1)', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })
    let fail = false
    mockApi({
      [ROUTE]: () =>
        fail
          ? [502, { code: 'MONGO_ERROR', message: 'Could not read the replica set status' }]
          : [200, replica()],
    })
    mountApp(ReplicaSetPanel, { props: { connectionId: 'c1' } })
    await flushPromises()
    expect(document.querySelector('[data-stale]')).toBeNull()
    fail = true
    await vi.advanceTimersByTimeAsync(5_000)
    await flushPromises()
    expect(document.querySelector('[role="alert"]')!.textContent).toContain(
      'Could not read the replica set status',
    )
    const stale = document.querySelector('[data-stale]')!
    expect(stale).not.toBeNull()
    expect(stale.textContent).toContain('last answer')
  })

  it('leaves a gap in the lag chart for a poll that failed (Minor 10)', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })
    let fail = false
    mockApi({ [ROUTE]: () => (fail ? [502, { code: 'MONGO_ERROR', message: 'x' }] : [200, replica()]) })
    mountApp(ReplicaSetPanel, { props: { connectionId: 'c1' } })
    await flushPromises()
    fail = true
    await vi.advanceTimersByTimeAsync(5_000)
    await flushPromises()
    fail = false
    await vi.advanceTimersByTimeAsync(5_000)
    await flushPromises()
    const chart = chartOptions().find((c) => c.label.startsWith('Replication lag'))!
    const series = pick(chart.option, 'series') as Array<{ name: string; data: Array<number | null> }>
    expect(series.find((s) => s.name === 'db1:27017')!.data).toEqual([12, null, 12])
  })

  it('refreshes "ago" every 5 seconds, not every second (Minor 16)', async () => {
    const spy = vi.spyOn(globalThis, 'setInterval')
    mockApi({ [ROUTE]: () => [200, replica()] })
    mountApp(ReplicaSetPanel, { props: { connectionId: 'c1' } })
    await flushPromises()
    expect(spy.mock.calls.some(([, ms]) => ms === 1_000)).toBe(false)
    expect(spy.mock.calls.some(([, ms]) => ms === 5_000)).toBe(true)
    spy.mockRestore()
  })
})
