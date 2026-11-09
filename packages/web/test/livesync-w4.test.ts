// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import LiveSyncDetail from '../src/livesync/LiveSyncDetail.vue'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'
import { SYNC } from './support/livesync'
import { button, byLabel, check, choose, typeInto } from './support/dom'
import LiveSyncWizard from '../src/livesync/LiveSyncWizard.vue'

/** W4 item 6 (completion design §2 W4.6): live sync in the web app. */
beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})
const detail = (over: Record<string, unknown> = {}, events: unknown[] = []) => ({ ...SYNC(over), events })

describe('a filtered sync in the wizard (W4.6)', () => {
  const ALL = ['documents:read', 'documents:write', 'databases:write', 'indexes:write', 'jobs:run']
  const CONNS = [
    { id: 'c1', name: 'Prod', access: 'editor', permissions: ALL, export: true, restricted: false },
    { id: 'c2', name: 'Reporting', access: 'admin', permissions: ALL, export: true },
  ]
  it('sends the filter as canonical EJSON, and holds Next while it does not read', async () => {
    const { calls } = mockApi({
      'GET connections': () => [200, CONNS],
      'POST connections/c1/live-syncs/plan': () => [
        200,
        {
          planHash: 'a'.repeat(64),
          copy: { collections: [], views: [], missingRules: [], refusals: [] },
          masked: false,
          warnings: ['overwrite'],
          refusals: ['filter_masked'],
          estimate: { documents: 1, bytes: 1, seconds: 1 },
          oplogWindowSeconds: null,
        },
      ],
    })
    mountApp(LiveSyncWizard, { props: { connectionId: 'c1', db: 'shop', coll: 'orders' } })
    await flushPromises()
    await choose(byLabel<HTMLSelectElement>('Target connection'), 'c2')
    button('Next').click()
    await flushPromises()
    await check(byLabel('Only the documents a filter matches'))
    await typeInto(byLabel('Filter on the source'), '{ status: "paid", at: { $gt: ISODate("2026-01-01") } }')
    await typeInto(byLabel('Filter on the source'), '{ status: ')
    expect(button('Next').disabled).toBe(true)
    await typeInto(byLabel('Filter on the source'), '{ status: "paid", at: { $gt: ISODate("2026-01-01") } }')
    button('Next').click()
    await flushPromises()
    const plan = calls.find((c) => c.path === 'connections/c1/live-syncs/plan')!
    expect(plan.body).toMatchObject({
      filter: { status: 'paid', at: { $gt: { $date: { $numberLong: String(Date.UTC(2026, 0, 1)) } } } },
    })
    expect(document.body.textContent).toContain('The filter reads a field this masked sync hides')
  })
})

// Final review of the masking side channels (M-1): a collection the copy leaves out is named, with
// why, where its plan is refused for it (left_out).
describe('a collection the copy leaves out', () => {
  const ALL = ['documents:read', 'documents:write', 'databases:write', 'indexes:write', 'jobs:run']
  it('is named in the plan, with its reason', async () => {
    mockApi({
      'GET connections': () => [
        200,
        [
          { id: 'c1', name: 'Prod', access: 'admin', permissions: ALL, export: true, restricted: false },
          { id: 'c2', name: 'Reporting', access: 'admin', permissions: ALL, export: true },
        ],
      ],
      'POST connections/c1/live-syncs/plan': () => [
        200,
        {
          planHash: 'a'.repeat(64),
          copy: {
            collections: [
              {
                source: 'keyed',
                target: 'keyed',
                exists: false,
                count: null,
                path: 'stream',
                sharded: false,
                ttlIndexes: [],
                fullSort: false,
                skipped: 'Stored in the order of a hidden value',
              },
            ],
            views: [],
            missingRules: [],
            refusals: [],
          },
          masked: true,
          warnings: [],
          refusals: ['left_out'],
          leftOut: ['keyed'],
          estimate: { documents: 1, bytes: 1, seconds: 1 },
          oplogWindowSeconds: null,
        },
      ],
    })
    mountApp(LiveSyncWizard, { props: { connectionId: 'c1', db: 'shop', coll: 'keyed' } })
    await flushPromises()
    await choose(byLabel<HTMLSelectElement>('Target connection'), 'c2')
    button('Next').click()
    await flushPromises()
    button('Next').click()
    await flushPromises()
    const text = document.body.textContent ?? ''
    expect(text).toContain(
      i18n.global.t('dataTransfer.copy.skipped', {
        name: 'keyed',
        reason: 'Stored in the order of a hidden value',
      }),
    )
    expect(text).toContain(i18n.global.t('liveSync.refusal.left_out'))
  })

  it('is not named where something else refuses the sync (its own reason is said)', async () => {
    mockApi({
      'GET connections': () => [
        200,
        [
          { id: 'c1', name: 'Prod', access: 'admin', permissions: ALL, export: true, restricted: false },
          { id: 'c2', name: 'Reporting', access: 'admin', permissions: ALL, export: true },
        ],
      ],
      'POST connections/c1/live-syncs/plan': () => [
        200,
        {
          planHash: 'a'.repeat(64),
          copy: {
            collections: [
              {
                source: 'keyed',
                target: 'keyed',
                exists: true,
                count: null,
                path: 'stream',
                sharded: false,
                ttlIndexes: [],
                fullSort: false,
                skipped: 'A time series takes only inserts: copy it with inserts',
              },
            ],
            views: [],
            missingRules: [],
            refusals: [],
          },
          masked: false,
          warnings: [],
          refusals: ['timeseries_target'],
          estimate: { documents: 1, bytes: 1, seconds: 1 },
          oplogWindowSeconds: null,
        },
      ],
    })
    mountApp(LiveSyncWizard, { props: { connectionId: 'c1', db: 'shop', coll: 'keyed' } })
    await flushPromises()
    await choose(byLabel<HTMLSelectElement>('Target connection'), 'c2')
    button('Next').click()
    await flushPromises()
    button('Next').click()
    await flushPromises()
    expect(document.body.textContent).toContain(i18n.global.t('liveSync.refusal.timeseries_target'))
    expect(document.querySelector('[data-skipped]')).toBeNull()
  })
})

describe('a scheduled start (W4.6)', () => {
  it('says when a scheduled sync starts, and offers its owner alone to start it now', async () => {
    const at = Date.UTC(2026, 9, 20, 3, 30)
    mockApi({
      'GET live-syncs': () => [
        200,
        {
          enabled: true,
          max: 10,
          perUser: 3,
          syncs: [
            SYNC({ id: 'mine', state: 'paused', reason: 'scheduled', pausedBy: 'system', scheduledAt: at }),
            SYNC({
              id: 'theirs',
              mine: false,
              state: 'paused',
              reason: 'scheduled',
              pausedBy: 'system',
              scheduledAt: at,
            }),
            SYNC({
              id: 'refused',
              state: 'attention',
              reason: 'scheduled_refused',
              detail: 'target_not_empty',
            }),
            // Sixth review of the open's stop (minor 1): what a plan threw, which the card has no
            // words of its own for, is said as a plan that failed, never as its code.
            SYNC({
              id: 'unworded',
              state: 'attention',
              reason: 'scheduled_refused',
              detail: 'oidc_sign_in,some_reason_to_come',
            }),
            // Seventh review (minor 2): a copy's refusal, a connection's reason, and a copy that did
            // not start, each in its own words.
            SYNC({
              id: 'worded',
              state: 'attention',
              reason: 'scheduled_refused',
              detail: 'sharded_replace,kms_provider_missing',
            }),
            SYNC({ id: 'nocopy', state: 'attention', reason: 'scheduled_refused', detail: 'copy' }),
          ],
        },
      ],
    })
    const { useSessionStore } = await import('../src/stores/session')
    const { default: LiveSyncsView } = await import('../src/livesync/LiveSyncsView.vue')
    mountApp(LiveSyncsView)
    const session = useSessionStore()
    session.status = { mode: 'team' } as never
    session.me = {
      mode: 'team',
      user: { id: 'u1', username: 'ada', role: 'admin' },
      permissions: [],
    } as never
    await flushPromises()
    const card = (id: string) => document.querySelector<HTMLElement>(`[data-sync="${id}"]`)!
    expect(card('mine').textContent).toMatch(/Starts .*2026.*nothing is copied or read until then/)
    expect(card('mine').textContent).toContain('Start now')
    expect(card('mine').textContent).not.toContain('Verify')
    expect(card('theirs').textContent).not.toContain('Start now')
    expect(card('refused').textContent).toContain('At its time, its plan no longer held')
    expect(card('refused').textContent).toContain('Start again')
    const unworded = card('unworded').textContent!
    expect(unworded).toContain('sign in')
    expect(unworded).toContain('The sync could not be planned.')
    expect(unworded).not.toMatch(/oidc_sign_in|some_reason_to_come/)
    const worded = card('worded').textContent!
    expect(worded).toContain('A sharded collection cannot be replaced.')
    expect(worded).not.toContain('could not be planned')
    expect(worded).not.toMatch(/sharded_replace|kms_provider_missing/)
    expect(card('nocopy').textContent).toContain('copy could not start')
  })

  it('schedules from the wizard, a minute to 30 days ahead', async () => {
    const ALL = ['documents:read', 'documents:write', 'databases:write', 'indexes:write', 'jobs:run']
    const { calls } = mockApi({
      'GET connections': () => [
        200,
        [
          { id: 'c1', name: 'Prod', access: 'editor', permissions: ALL, export: true, restricted: false },
          { id: 'c2', name: 'Reporting', access: 'admin', permissions: ALL, export: true },
        ],
      ],
      'POST connections/c1/live-syncs/plan': () => [
        200,
        {
          planHash: 'a'.repeat(64),
          copy: { collections: [], views: [], missingRules: [], refusals: [] },
          masked: false,
          warnings: [],
          refusals: [],
          estimate: { documents: 1, bytes: 1, seconds: 1 },
          oplogWindowSeconds: null,
        },
      ],
    })
    mountApp(LiveSyncWizard, { props: { connectionId: 'c1', db: 'shop', coll: 'orders' } })
    await flushPromises()
    await choose(byLabel<HTMLSelectElement>('Target connection'), 'c2')
    button('Next').click()
    await flushPromises()
    await check(byLabel('Start at a time of my choosing'))
    const local = (ms: number) => {
      const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000)
      return d.toISOString().slice(0, 16)
    }
    await typeInto(byLabel('Start at'), local(Date.now() + 40 * 86_400_000))
    expect(button('Next').disabled).toBe(true)
    expect(document.body.textContent).toContain('Choose a time between a minute and 30 days from now')
    const when = Date.now() + 2 * 3600_000
    await typeInto(byLabel('Start at'), local(when))
    button('Next').click()
    await flushPromises()
    const body = calls.find((c) => c.path === 'connections/c1/live-syncs/plan')!.body as { startAt: number }
    expect(Math.abs(body.startAt - when)).toBeLessThan(60_000)
    expect(button('Schedule live sync')).toBeTruthy()
  })
})

describe('a two-way sync (W4.6)', () => {
  it('is asked for in the wizard: from now, no filter or later start, with its warning confirmed', async () => {
    const ALL = ['documents:read', 'documents:write', 'databases:write', 'indexes:write', 'jobs:run']
    const bodies: Array<Record<string, unknown>> = []
    mockApi({
      'GET connections': () => [
        200,
        [
          { id: 'c1', name: 'Prod', access: 'editor', permissions: ALL, export: true, restricted: false },
          { id: 'c2', name: 'Reporting', access: 'admin', permissions: ALL, export: true },
        ],
      ],
      'POST connections/c1/live-syncs/plan': (body) => {
        const b = body as Record<string, unknown>
        bodies.push(b)
        return [
          200,
          {
            planHash: 'a'.repeat(64),
            copy: { collections: [], views: [], missingRules: [], refusals: [] },
            masked: false,
            warnings: ['two_way', 'overwrite'],
            refusals: [
              ...(b.confirmTwoWay ? [] : ['confirm_two_way']),
              ...(b.enablePreImages ? [] : ['pre_images_off']),
            ],
            estimate: { documents: 1, bytes: 1, seconds: null },
            oplogWindowSeconds: null,
          },
        ]
      },
    })
    mountApp(LiveSyncWizard, { props: { connectionId: 'c1', db: 'shop', coll: 'orders' } })
    await flushPromises()
    await choose(byLabel<HTMLSelectElement>('Target connection'), 'c2')
    button('Next').click()
    await flushPromises()
    await check(byLabel('Two-way: changes on the target come back to the source'))
    expect(document.body.textContent).not.toContain('Copy first')
    expect(document.body.textContent).not.toContain('Only the documents a filter matches')
    expect(document.body.textContent).not.toContain('Start at a time of my choosing')
    button('Next').click()
    await flushPromises()
    expect(bodies.at(-1)).toMatchObject({ twoWay: true, startMode: 'from_now', confirmTwoWay: false })
    const card = document.querySelector('[data-test="two-way-warning"]')!
    expect(card.textContent).toContain('the later change wins')
    await check(byLabel('Turn on pre- and post-images on both collections (collMod)'))
    await check(byLabel('I understand: the later of two conflicting changes wins, and the other is lost'))
    await flushPromises()
    expect(bodies.at(-1)).toMatchObject({ enablePreImages: true, confirmTwoWay: true })
  })

  it('shows each direction, its conflicts, no cutover, and words the conflicts listed', async () => {
    const twoWay = SYNC({
      id: 'tw1',
      twoWay: { partner: 'tw2', side: 'forward' },
      counters: { ...SYNC().counters, conflicts: 2 },
    })
    mockApi({
      'GET live-syncs': () => [200, { enabled: true, max: 10, perUser: 3, syncs: [twoWay] }],
      'GET live-syncs/tw1': () => [
        200,
        {
          ...twoWay,
          events: [{ at: Date.now(), kind: 'conflict', detail: '{"$numberInt":"1"} · both · reverse' }],
        },
      ],
      'GET live-syncs/tw1/lag': () => [200, { points: [] }],
    })
    const { default: LiveSyncsView } = await import('../src/livesync/LiveSyncsView.vue')
    mountApp(LiveSyncsView)
    await flushPromises()
    const card = document.querySelector<HTMLElement>('[data-sync="tw1"]')!
    expect(card.querySelector('[data-test="two-way"]')!.textContent).toMatch(
      /Two-way: this way.*2 conflicts settled/,
    )
    expect(card.textContent).not.toContain('Finish')
    document.body.innerHTML = ''
    mountApp(LiveSyncDetail, { props: { syncId: 'tw1' } })
    await flushPromises()
    expect(document.body.textContent).toContain(
      'Conflict on {"$numberInt":"1"}: both sides changed it; the later change, on Reporting · shop.orders, won.',
    )
  })
})

describe('a verification’s samples (W4.6)', () => {
  const verify = {
    state: 'done',
    startedAt: 1,
    finishedAt: 2,
    pairs: [
      {
        source: 'orders',
        target: 'orders',
        same: 5,
        different: 1,
        onlySource: 0,
        onlyTarget: 1,
        unsettled: 0,
        ids: [],
      },
    ],
  }
  it('shows its owner what differs, field by field, as the compare view does — only when asked', async () => {
    const { calls } = mockApi({
      'GET live-syncs/ls1': () => [200, detail({ verify })],
      'GET live-syncs/ls1/verify/samples': () => [
        200,
        {
          finishedAt: 2,
          masked: false,
          pairs: [
            {
              ...verify.pairs[0],
              samples: {
                onlySource: [],
                onlyTarget: [{ id: { $numberInt: '3' }, doc: { _id: { $numberInt: '3' }, stray: true } }],
                different: [
                  {
                    id: { $numberInt: '1' },
                    changes: [{ path: 'total', before: { $numberInt: '99' }, after: { $numberInt: '10' } }],
                    more: false,
                  },
                ],
              },
            },
          ],
        },
      ],
    })
    mountApp(LiveSyncDetail, { props: { syncId: 'ls1' } })
    await flushPromises()
    expect(calls.some((c) => c.path.endsWith('/samples'))).toBe(false)
    button('Show what differs').click()
    await flushPromises()
    const box = document.querySelector('[data-test="verify-samples"]')!
    expect(box.querySelectorAll('[data-sample]')).toHaveLength(1)
    expect(box.textContent).toContain('total')
    expect(box.textContent).toContain('99')
    box.querySelectorAll<HTMLElement>('[role="radio"]')[2]!.click()
    await flushPromises()
    expect(box.textContent).toContain('stray')
  })

  it('offers nothing to another user, and words a refusal', async () => {
    mockApi({ 'GET live-syncs/ls1': () => [200, detail({ verify, mine: false })] })
    mountApp(LiveSyncDetail, { props: { syncId: 'ls1' } })
    await flushPromises()
    expect(document.querySelector('[data-test="verify-samples"]')).toBeNull()
    document.body.innerHTML = ''
    mockApi({
      'GET live-syncs/ls1': () => [200, detail({ verify })],
      'GET live-syncs/ls1/verify/samples': () => [
        403,
        {
          code: 'FORBIDDEN',
          message: 'Personal values are hidden from you on the source now',
          details: { reason: 'masked_now' },
        },
      ],
    })
    mountApp(LiveSyncDetail, { props: { syncId: 'ls1' } })
    await flushPromises()
    button('Show what differs').click()
    await flushPromises()
    expect(document.querySelector('[data-test="verify-samples"]')!.textContent).toMatch(
      /hidden|not allowed|permission/i,
    )
  })
})

describe('the lag history (W4.6)', () => {
  it('draws the server’s history in the detail, over the period chosen', async () => {
    const asked: string[] = []
    mockApi({
      'GET live-syncs/ls1': () => [200, detail()],
      'GET live-syncs/ls1/lag': (_b, url) => {
        asked.push(url.searchParams.get('minutes')!)
        return [
          200,
          {
            points: [
              { at: 1, lag: 1000 },
              { at: 2, lag: 4500 },
              { at: 3, lag: 0 },
            ],
          },
        ]
      },
    })
    mountApp(LiveSyncDetail, { props: { syncId: 'ls1' } })
    await flushPromises()
    const section = document.querySelector('[data-test="lag-history"]')!
    expect(section.querySelector('[data-lag]')).not.toBeNull()
    expect(section.textContent).toContain('Largest: 4.5 sec behind')
    section.querySelectorAll<HTMLElement>('[role="radio"]')[2]!.click()
    await flushPromises()
    expect(asked).toEqual(['60', '1440'])
  })

  it('fills a card’s chart from the server once, then adds what is pushed', async () => {
    const { useLiveSyncs } = await import('../src/livesync/useLiveSyncs')
    let lagCalls = 0
    mockApi({
      'GET live-syncs': () => [200, { enabled: true, max: 10, perUser: 3, syncs: [SYNC({ id: 'ls9' })] }],
      'GET live-syncs/ls9/lag': () => {
        lagCalls++
        return [200, { points: [{ at: Date.now() - 60_000, lag: 800 }] }]
      },
    })
    let api: ReturnType<typeof useLiveSyncs> | null = null
    mountApp({
      setup() {
        api = useLiveSyncs()
        return () => null
      },
    })
    await flushPromises()
    await flushPromises()
    expect(lagCalls).toBe(1)
    expect(api!.lagOf('ls9')[0]).toMatchObject({ lag: 800 })
    await api!.list.refetch()
    await flushPromises()
    expect(lagCalls).toBe(1)
  })
})

describe('the rejected-records file in a sync’s detail (W4.6)', () => {
  it('offers its owner the refused documents, and says when the space ran out', async () => {
    mockApi({
      'GET live-syncs/ls1': () => [
        200,
        detail({ errorPolicy: 'skip', counters: { ...SYNC().counters, skipped: 3 } }, [
          { at: Date.now(), kind: 'error', detail: 'rejected_file_full' },
        ]),
      ],
    })
    mountApp(LiveSyncDetail, { props: { syncId: 'ls1' } })
    await flushPromises()
    const section = document.querySelector('[data-test="rejected"]')!
    expect(section.textContent).toContain('The target refused 3 documents')
    const link = section.querySelector('a')!
    expect(link.getAttribute('href')).toMatch(/\/api\/live-syncs\/ls1\/rejected$/)
    expect(link.hasAttribute('download')).toBe(true)
    expect(document.body.textContent).toContain('Your transfer space is full')
  })

  it('offers nothing to another user, nor when nothing was refused or the policy pauses', async () => {
    for (const over of [
      { mine: false, errorPolicy: 'skip', counters: { ...SYNC().counters, skipped: 3 } },
      { errorPolicy: 'skip', counters: { ...SYNC().counters, skipped: 0 } },
      { errorPolicy: 'pause', counters: { ...SYNC().counters, skipped: 3 } },
    ]) {
      mockApi({ 'GET live-syncs/ls1': () => [200, detail(over)] })
      mountApp(LiveSyncDetail, { props: { syncId: 'ls1' } })
      await flushPromises()
      expect(document.querySelector('[data-test="rejected"]'), JSON.stringify(over)).toBeNull()
      document.body.innerHTML = ''
    }
  })
})
