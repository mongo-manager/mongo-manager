// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { CopyPlan, JobView } from '@mongo-manager/shared'
import CopyWizard from '../src/transfer/CopyWizard.vue'
import RunningJobCard from '../src/jobs/RunningJobCard.vue'
import AggregationView from '../src/aggregation/AggregationView.vue'
import { useCollectionViewsStore } from '../src/stores/collectionViews'
import { newCard } from '../src/aggregation/stages'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'
import { button, byLabel, typeInto } from './support/dom'

/** W4 item 3 (completion design §2 W4.3): the copy wizard's own filter, live target, sizes, parts. */
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

const ALL = ['documents:read', 'documents:write', 'databases:write', 'indexes:write', 'jobs:run']
const CONNS = [
  { id: 'c1', name: 'Prod', access: 'editor', permissions: ALL, export: true },
  { id: 'c2', name: 'Dev', access: 'admin', permissions: ALL, export: true },
]
const PLAN: CopyPlan = {
  planHash: 'f'.repeat(64),
  collections: [
    {
      source: 'orders',
      target: 'orders',
      exists: true,
      count: 12,
      sourceCount: 30,
      sourceBytes: 4096,
      path: 'stream',
      sharded: false,
      ttlIndexes: [],
      fullSort: false,
    },
  ],
  views: [],
  masked: false,
  missingRules: [],
  mayAddRules: false,
  deployment: 'different',
  refusals: [],
}
const radio = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
    (b) => b.textContent?.trim() === text,
  )!
const PLAN_PATH = 'POST connections/c1/databases/shop/collections/orders/copy/plan'
const STATS = 'GET connections/c1/databases/shop/collections/orders/stats'

function api(extra: Record<string, (body: unknown) => [number, unknown]> = {}) {
  return mockApi({
    'GET connections': () => [200, CONNS],
    [PLAN_PATH]: () => [200, PLAN],
    [STATS]: () => [
      200,
      {
        count: 30,
        size: 4096,
        storageSize: 8192,
        avgObjSize: 136,
        totalIndexSize: 0,
        nindexes: 1,
        capped: false,
      },
    ],
    'GET transfer/presets': () => [200, { presets: [] }],
    ...extra,
  })
}

describe('copy source (W4.3)', () => {
  it("shows the source's estimated size", async () => {
    api()
    mountApp(CopyWizard, { props: { connectionId: 'c1', db: 'shop', coll: 'orders' } })
    await flushPromises()
    expect(document.querySelector('[data-test="source-size"]')!.textContent).toContain('About 30 documents')
    expect(document.querySelector('[data-test="source-size"]')!.textContent).toContain('4 KB')
  })

  it('copies the documents a filter of its own picks, parsed by the safe parser', async () => {
    const { calls } = api()
    mountApp(CopyWizard, { props: { connectionId: 'c1', db: 'shop', coll: 'orders' } })
    await flushPromises()
    radio('A filter').click()
    await flushPromises()
    await typeInto(
      byLabel<HTMLTextAreaElement>('Filter'),
      "{ status: 'paid', at: { $gt: ISODate('2026-01-01') } }",
    )
    for (let i = 0; i < 3; i++) {
      button('Next').click()
      await flushPromises()
    }
    const body = calls.filter((c) => c.path.endsWith('/copy/plan')).at(-1)!.body as {
      source: { kind: string; filter: Record<string, unknown> }
    }
    expect(body.source).toEqual({
      kind: 'query',
      filter: { status: 'paid', at: { $gt: { $date: { $numberLong: String(Date.UTC(2026, 0, 1)) } } } },
    })
  })

  it('refuses a filter that does not parse, before going on', async () => {
    api()
    mountApp(CopyWizard, { props: { connectionId: 'c1', db: 'shop', coll: 'orders' } })
    await flushPromises()
    radio('A filter').click()
    await flushPromises()
    await typeInto(byLabel<HTMLTextAreaElement>('Filter'), '{ status: ')
    await flushPromises()
    expect(button('Next').disabled).toBe(true)
    expect(document.body.textContent).toContain('The filter is not valid')
  })
})

describe('live target check (W4.3)', () => {
  it('says whether the target exists, what the mode does to it, and the role there', async () => {
    const { calls } = api()
    mountApp(CopyWizard, { props: { connectionId: 'c1', db: 'shop', coll: 'orders' } })
    await flushPromises()
    button('Next').click()
    await flushPromises()
    await typeInto(byLabel('Collection'), 'orders')
    await vi.waitFor(() => expect(document.querySelector('[data-test="target-check"]')).toBeTruthy())
    const check = document.querySelector('[data-test="target-check"]')!
    expect(check.textContent).toContain('exists, 12 documents')
    expect(check.textContent).toContain('Insert adds documents; one whose _id is already there fails.')
    expect(check.textContent).toContain('You are editor on Prod')
    expect(calls.some((c) => c.path.endsWith('/copy/plan'))).toBe(true)
  })

  it('says a refusal as soon as the target is chosen', async () => {
    api({ [PLAN_PATH]: () => [200, { ...PLAN, refusals: ['same_namespace'] }] })
    mountApp(CopyWizard, { props: { connectionId: 'c1', db: 'shop', coll: 'orders' } })
    await flushPromises()
    button('Next').click()
    await flushPromises()
    await vi.waitFor(() =>
      expect(document.querySelector('[data-test="target-check"]')!.textContent).toContain(
        'This is the source collection itself.',
      ),
    )
  })

  it('says when the plan is refused there (no right to write)', async () => {
    api({ [PLAN_PATH]: () => [403, { code: 'FORBIDDEN', message: 'Forbidden' }] })
    mountApp(CopyWizard, { props: { connectionId: 'c1', db: 'shop', coll: 'orders' } })
    await flushPromises()
    button('Next').click()
    await flushPromises()
    await vi.waitFor(() =>
      expect(document.querySelector('[data-test="target-check"]')!.getAttribute('data-state')).toBe('error'),
    )
  })
})

describe('progress per collection (W4.3)', () => {
  const JOB: JobView = {
    id: 'j1',
    kind: 'data.copy',
    connectionId: 'c1',
    targetConnectionId: 'c2',
    db: 'shop',
    coll: '*',
    target: 'shop',
    state: 'running',
    progress: { done: 40, total: 100 },
    estimate: null,
    error: null,
    startedAt: 1,
    finishedAt: null,
    mine: true,
    cancellable: true,
    parts: {
      phase: 'copy',
      count: 3,
      finished: 1,
      items: [
        { name: 'users', state: 'done', done: 2, total: 2 },
        { name: 'orders', state: 'running', done: 40, total: 100 },
        { name: 'logs', state: 'waiting', done: 0, total: null },
      ],
    },
  }

  it('shows how many collections are done and each one with its own progress', () => {
    mockApi({ 'GET connections': () => [200, CONNS] })
    mountApp(RunningJobCard, { props: { job: JOB, now: 10_000 } })
    const parts = document.querySelector('[data-test="job-parts"]')!
    expect(parts.textContent).toContain('1 of 3 collections')
    expect(parts.textContent).toContain('orders')
    const orders = parts.querySelector('[data-part="orders"]')!
    expect(orders.getAttribute('data-state')).toBe('running')
    expect(orders.textContent).toContain('40%')
    expect(parts.querySelector('[data-part="logs"]')!.getAttribute('data-state')).toBe('waiting')
  })

  it('shows only the summary in the compact card', () => {
    mockApi({ 'GET connections': () => [200, CONNS] })
    mountApp(RunningJobCard, { props: { job: JOB, now: 10_000, compact: true } })
    const parts = document.querySelector('[data-test="job-parts"]')!
    expect(parts.textContent).toContain('1 of 3 collections · orders 40%')
    expect(parts.querySelector('[data-part]')).toBeNull()
  })
})

describe("copying a pipeline's results (W4.3)", () => {
  it('opens the copy wizard on the pipeline from the aggregation builder', async () => {
    mockApi({
      'GET connections': () => [200, CONNS],
      'POST connections/c1/databases/shop/collections/orders/aggregate/preview': () => [
        200,
        { sample: { documents: [], count: 0 }, stages: [{ documents: [], count: 0 }] },
      ],
      [STATS]: () => [200, { count: 30, size: 4096 }],
      [PLAN_PATH]: () => [200, PLAN],
      'GET transfer/presets': () => [200, { presets: [] }],
    })
    const card = newCard('$match')
    card.text = '{ status: "paid" }'
    useCollectionViewsStore().stateFor('tab-1').aggregation.cards = [card]
    mountApp(AggregationView, {
      props: {
        target: { connectionId: 'c1', db: 'shop', coll: 'orders' },
        tabId: 'tab-1',
        canWrite: true,
        canExport: true,
      },
    })
    await flushPromises()
    button('Copy results…').click()
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeTruthy())
    await flushPromises()
    expect(radio("The pipeline's results").getAttribute('aria-checked')).toBe('true')
  })
})
