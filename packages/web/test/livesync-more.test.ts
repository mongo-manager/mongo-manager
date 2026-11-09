// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { LiveSyncDetail as Detail, LiveSyncPlan } from '@mongo-manager/shared'
import LiveSyncsView from '../src/livesync/LiveSyncsView.vue'
import LiveSyncDetail from '../src/livesync/LiveSyncDetail.vue'
import LiveSyncWizard from '../src/livesync/LiveSyncWizard.vue'
import DialogHost from '../src/ds/DsConfirmHost.vue'
import ToastHost from '../src/ds/DsToastHost.vue'
import { useSessionStore } from '../src/stores/session'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'
import { button, byLabel, choose, typeInto } from './support/dom'
import { SYNC } from './support/livesync'

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.UTC(2026, 9, 5, 12))
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})
const list = (syncs: ReturnType<typeof SYNC>[]) => () =>
  [200, { enabled: true, max: 10, perUser: 3, syncs }] as [number, unknown]
const card = (id: string) => document.querySelector<HTMLElement>(`[data-sync="${id}"]`)!
const signIn = (role: 'admin' | 'editor' = 'editor') => {
  const session = useSessionStore()
  session.status = { mode: 'team' } as never
  session.me = { mode: 'team', user: { id: 'u1', username: 'ada', role }, permissions: [] } as never
}
const press = async (id: string, label: string) => {
  ;[...card(id).querySelectorAll('button')].find((b) => b.textContent?.trim() === label)!.click()
  await flushPromises()
}
const menu = async (id: string, label: string) => {
  card(id).querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!.click()
  await flushPromises()
  ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find((m) => m.textContent?.trim() === label)!
    .click()
  await flushPromises()
}

const DETAIL = (): Detail => ({
  ...SYNC({
    verify: {
      state: 'done',
      startedAt: Date.UTC(2026, 9, 5, 11),
      finishedAt: Date.UTC(2026, 9, 5, 11, 1),
      error: 'not_settled',
      pairs: [
        {
          source: 'orders',
          target: 'orders',
          same: 10,
          different: 1,
          onlySource: 2,
          onlyTarget: 0,
          unsettled: 4,
          ids: [{ $numberInt: '7' }, 'x'],
        },
      ],
    },
  }),
  events: [
    { at: Date.UTC(2026, 9, 5, 10), kind: 'state', state: 'copying' },
    { at: Date.UTC(2026, 9, 5, 10, 1), kind: 'batch', counts: { inserted: 5, replaced: 2, deleted: 1 } },
    { at: Date.UTC(2026, 9, 5, 10, 2), kind: 'skipped', detail: '"x" · code 11000' },
    { at: Date.UTC(2026, 9, 5, 10, 3), kind: 'schema', detail: 'shop.fresh' },
    { at: Date.UTC(2026, 9, 5, 10, 4), kind: 'error', detail: 'connection' },
    { at: Date.UTC(2026, 9, 5, 10, 5), kind: 'state', state: 'attention', reason: 'write_error' },
    { at: Date.UTC(2026, 9, 5, 10, 6), kind: 'verify', detail: '3' },
  ],
})

describe('the details sheet (phase 3e-2 spec §5)', () => {
  it('shows the settings, the last verification with its ids, and the activity newest first', async () => {
    mockApi({ 'GET live-syncs/ls1': () => [200, DETAIL()] })
    mountApp(LiveSyncDetail, { props: { syncId: 'ls1' } })
    await flushPromises()
    const text = document.body.textContent ?? ''
    expect(text).toContain('Copy first')
    expect(text).toContain('Pause and ask')
    expect(text).toContain('Not followed')
    expect(text).toContain('Not masked')
    expect(text).toContain('Still different in orders:')
    // As the documents view labels ids.
    expect(text).toContain('Still different in orders: 7, x')
    expect(text).toContain('4 more were not checked again')
    expect(text).toContain('differences may be changes still on their way')
    const rows = [...document.querySelectorAll('ol li')].map((li) =>
      li.textContent?.replace(/\s+/g, ' ').trim(),
    )
    expect(rows[0]).toContain('Verified: 3 different')
    expect(rows[1]).toContain('Needs attention — The target refused a document.')
    expect(rows[2]).toContain('Error: connection')
    expect(rows[3]).toContain('Schema: shop.fresh')
    expect(rows[4]).toContain('Skipped document "x" · code 11000')
    expect(rows[5]).toContain('5 inserted, 2 replaced, 1 deleted')
    expect(rows[6]).toContain('Copying')
  })

  it('says an anonymous sync and a masked one apart, and a failed detail in words', async () => {
    mockApi({
      'GET live-syncs/ls1': () => [200, { ...DETAIL(), anonymous: true, followNew: true, verify: null }],
    })
    mountApp(LiveSyncDetail, { props: { syncId: 'ls1' } })
    await flushPromises()
    expect(document.body.textContent).toContain('Anonymous (personal data masked)')
    expect(document.body.textContent).toContain('Followed as they are created')
  })
})

describe('more card actions (phase 3e-2 spec §5)', () => {
  it('resumes, skips, applies or ignores new options after a confirmation, and opens the details', async () => {
    const { calls } = mockApi({
      'GET live-syncs': list([
        SYNC({ id: 'p', state: 'paused', reason: 'owner', pausedBy: 'owner' }),
        SYNC({ id: 'w', state: 'attention', reason: 'write_error', detail: '"x" · code 11000' }),
        SYNC({ id: 's', state: 'attention', reason: 'schema_changed', detail: 'shop.orders' }),
        SYNC({ id: 'i', state: 'attention', reason: 'schema_changed', detail: 'shop.orders' }),
      ]),
      'POST live-syncs/p/resume': () => [200, SYNC({ id: 'p', state: 'catching_up' })],
      'POST live-syncs/w/skip': () => [200, SYNC({ id: 'w', state: 'catching_up' })],
      'POST live-syncs/s/apply-schema': () => [200, SYNC({ id: 's', state: 'catching_up' })],
      'POST live-syncs/i/apply-schema': () => [200, SYNC({ id: 'i', state: 'catching_up' })],
      'GET live-syncs/p': () => [200, { ...DETAIL(), id: 'p' }],
    })
    signIn()
    mountApp(LiveSyncsView)
    mountApp(DialogHost)
    await flushPromises()
    await press('p', 'Resume')
    await press('w', 'Skip this document')
    const confirmIn = async (label: string) => {
      ;[...document.querySelectorAll('[role="dialog"] button')]
        .find((b) => b.textContent?.trim() === label)!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flushPromises()
    }
    await press('s', 'Apply the source’s options')
    await confirmIn('Apply the source’s options')
    await press('i', 'Ignore')
    await confirmIn('Ignore')
    await menu('p', 'Details')
    expect(document.body.textContent).toContain('Settings, activity and the last verification')
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(
      expect.arrayContaining([
        'POST live-syncs/p/resume',
        'POST live-syncs/w/skip',
        'POST live-syncs/s/apply-schema',
        'POST live-syncs/i/apply-schema',
        'GET live-syncs/p',
      ]),
    )
    expect(calls.find((c) => c.path === 'live-syncs/s/apply-schema')!.body).toEqual({ ignore: false })
    expect(calls.find((c) => c.path === 'live-syncs/i/apply-schema')!.body).toEqual({ ignore: true })
  })

  it('says a refused action in words: each refusal, a known reason, else the server’s words', async () => {
    mockApi({
      'GET live-syncs': list([SYNC({ id: 'a' }), SYNC({ id: 'b' }), SYNC({ id: 'c' })]),
      'POST live-syncs/a/pause': () => [
        409,
        { code: 'CONFLICT', message: 'x', details: { reason: 'refused', reasons: ['limit_user', 'loop'] } },
      ],
      'POST live-syncs/b/pause': () => [
        409,
        { code: 'CONFLICT', message: 'x', details: { reason: 'copying' } },
      ],
      'POST live-syncs/c/pause': () => [500, { code: 'INTERNAL', message: 'Something broke' }],
    })
    signIn()
    mountApp(LiveSyncsView)
    mountApp(ToastHost)
    await flushPromises()
    await press('a', 'Pause')
    await press('b', 'Pause')
    await press('c', 'Pause')
    const text = document.body.textContent ?? ''
    expect(text).toContain('You already have 3 live syncs. Another live sync already goes the other way')
    expect(text).toContain('A sync can be paused once its copy is done; stop it instead.')
  })

  it('names another owner, a connection the viewer cannot see, and asks an administrator to lift an administrator’s pause', async () => {
    mockApi({
      'GET live-syncs': list([
        SYNC({ id: 'o', mine: false, owner: 'bob', source: { ...SYNC().source, connectionName: '' } }),
        SYNC({ id: 'h', state: 'paused', reason: 'admin', pausedBy: 'admin:root' }),
      ]),
    })
    signIn('editor')
    mountApp(LiveSyncsView)
    await flushPromises()
    expect(card('o').textContent).toContain('Owner: bob')
    expect(card('o').textContent).toContain('A connection you cannot see')
    expect(card('h').textContent).toContain('Ask an administrator to resume it.')
  })
})

describe('the wizard’s source step (phase 3e-2 spec §5)', () => {
  it('chooses a source connection, a database and a collection when opened from the tab', async () => {
    const ALL = ['documents:read', 'documents:write', 'databases:write', 'indexes:write', 'jobs:run']
    const { calls } = mockApi({
      'GET connections': () => [
        200,
        [
          { id: 'c1', name: 'Prod', access: 'editor', permissions: ALL, export: true },
          { id: 'c2', name: 'Reporting', access: 'admin', permissions: ALL, export: true },
        ],
      ],
      'POST connections/c1/live-syncs/plan': () => [
        200,
        {
          planHash: 'a'.repeat(64),
          copy: {
            planHash: 'c'.repeat(64),
            collections: [],
            views: [],
            masked: false,
            missingRules: [],
            mayAddRules: false,
            deployment: 'unknown',
            refusals: [],
          },
          masked: false,
          warnings: ['oplog_unknown', 'ttl'],
          refusals: ['confirm_ttl'],
          estimate: { documents: 1, bytes: 1, seconds: null },
          oplogWindowSeconds: null,
        } satisfies LiveSyncPlan,
      ],
    })
    mountApp(LiveSyncWizard)
    await flushPromises()
    expect(button('Next').disabled).toBe(true)
    await choose(byLabel<HTMLSelectElement>('Source connection'), 'c1')
    await typeInto(byLabel('Database'), 'shop')
    await typeInto(byLabel('Collection (empty: the whole database)'), 'orders')
    button('Next').click()
    await flushPromises()
    await choose(byLabel<HTMLSelectElement>('Target connection'), 'c2')
    await typeInto(byLabel('Database'), 'copy')
    button('Next').click()
    await flushPromises()
    button('Next').click()
    await flushPromises()
    const text = document.body.textContent ?? ''
    expect(calls.find((c) => c.path.endsWith('/plan'))!.body).toMatchObject({
      source: { connectionId: 'c1', db: 'shop', coll: 'orders' },
      target: { connectionId: 'c2', db: 'copy', coll: 'orders' },
    })
    expect(text).toContain('cannot be read with this connection’s user')
    expect(text).toContain('TTL indexes delete target documents')
    expect(text).toContain('make sure the target is not the source itself')
    expect(button('Start live sync').disabled).toBe(true)
  })
})

describe('final review fixes on the cards (phase 3e-2)', () => {
  it('says why a sync retries, and which stream error waits for a person', async () => {
    mockApi({
      'GET live-syncs': list([
        SYNC({
          id: 'r',
          state: 'retrying',
          reason: null,
          detail: 'connection',
          retryAt: Date.UTC(2026, 9, 5, 12, 0, 30),
        }),
        SYNC({ id: 'e', state: 'attention', reason: 'stream_error', detail: 'event_too_large' }),
      ]),
    })
    signIn()
    mountApp(LiveSyncsView)
    await flushPromises()
    expect(card('r').textContent).toContain('A server is out of reach.')
    expect(card('e').textContent).toContain(
      'The source’s change stream stopped with an error that waiting will not fix.',
    )
    expect(card('e').textContent).toContain('A change was larger than MongoDB can send (16 MB).')
    expect(card('e').textContent).not.toContain('event_too_large')
  })

  it('offers Start again for a target gone, and Try again for a stream error', async () => {
    mockApi({
      'GET live-syncs': list([
        SYNC({ id: 'g', state: 'attention', reason: 'target_gone', detail: 'shop.orders' }),
        SYNC({ id: 'e', state: 'attention', reason: 'stream_error', detail: 'unauthorized' }),
      ]),
    })
    signIn()
    mountApp(LiveSyncsView)
    await flushPromises()
    const labels = (id: string) => [...card(id).querySelectorAll('button')].map((b) => b.textContent?.trim())
    expect(labels('g')).toContain('Start again')
    expect(labels('g')).not.toContain('Try again')
    expect(labels('e')).toContain('Try again')
  })

  it('names each counter before its value (m17)', async () => {
    mockApi({ 'GET live-syncs': list([SYNC({ id: 'c' })]) })
    signIn()
    mountApp(LiveSyncsView)
    await flushPromises()
    const pair = card('c').querySelector('dl div')!
    expect([...pair.children].map((e) => e.tagName)).toEqual(['DT', 'DD'])
  })

  it('promises no more at the cutover than it keeps (I11)', () => {
    i18n.global.locale.value = 'en'
    const en = i18n.global.t('liveSync.finish.apply.help')
    expect(en).not.toContain('none after')
    expect(en).toContain('may still be applied')
    i18n.global.locale.value = 'tr'
    const tr = i18n.global.t('liveSync.finish.apply.help')
    expect(tr).not.toContain('sonrakileri uygulamaz')
    expect(tr).toContain('yine de uygulanabilir')
  })

  it('has words for every refusal and reason the server may send, in both languages', () => {
    for (const locale of ['en', 'tr'] as const) {
      i18n.global.locale.value = locale
      for (const code of ['view_source', 'deployment_changed', 'paused_by_admin', 'validator_masked'])
        expect(i18n.global.te(`liveSync.refusal.${code}`), `${locale} refusal ${code}`).toBe(true)
      expect(i18n.global.te('liveSync.reason.stream_error'), `${locale} stream_error`).toBe(true)
      for (const cause of [
        'connection',
        'internal',
        'event_too_large',
        'unauthorized',
        'not_replica_set',
        'view',
      ])
        expect(i18n.global.te(`liveSync.cause.${cause}`), `${locale} cause ${cause}`).toBe(true)
    }
  })
})
