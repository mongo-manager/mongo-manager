// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { ExplainResult } from '@mongo-manager/shared'
import ExplainView from '../src/explain/ExplainView.vue'
import AggregationView from '../src/aggregation/AggregationView.vue'
import { useCollectionViewsStore } from '../src/stores/collectionViews'
import { newCard } from '../src/aggregation/stages'
import { i18n } from '../src/i18n'
import { mockApi, mountApp, type ApiCall } from './support/app'
import { button, byLabel } from './support/dom'

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

const BASE = 'connections/c1/databases/shop/collections/orders'
const target = { connectionId: 'c1', db: 'shop', coll: 'orders' }
const TAB = 'tab-explain'

const result = (over: Partial<ExplainResult> = {}): ExplainResult => ({
  summary: { nReturned: 60, executionTimeMillis: 12, totalKeysExamined: 0, totalDocsExamined: 3000 },
  winning: {
    stage: 'SORT',
    nReturned: 60,
    children: [
      { stage: 'COLLSCAN', docsExamined: 3000, nReturned: 60, filter: '{ s: { $eq: "s3" } }', children: [] },
    ],
  },
  rejected: [{ stage: 'FETCH', children: [{ stage: 'IXSCAN', indexName: 'g_1', children: [] }] }],
  pipeline: [],
  engine: 'classic',
  warnings: [
    { code: 'COLLSCAN', stage: 'COLLSCAN', detail: { docs: 3000 } },
    { code: 'IN_MEMORY_SORT', stage: 'SORT' },
  ],
  suggestion: {
    key: [
      ['s', 1],
      ['n', -1],
    ],
    reason: { equality: ['s'], sort: ['n'], range: [] },
  },
  raw: { queryPlanner: { winningPlan: { stage: 'SORT' } } },
  ...over,
})

function setup(explain = result()) {
  const { calls } = mockApi({ [`POST ${BASE}/explain`]: () => [200, explain] })
  const state = useCollectionViewsStore().stateFor(TAB)
  state.query = { filter: { s: 's3' }, sort: { n: { $numberInt: '-1' } }, skip: 0, limit: 20 }
  return { calls, state }
}

/** W5: the screen also asks which values are hidden (the masking hint); only explains count here. */
const explains = (calls: ApiCall[]) => calls.filter((c) => c.path.endsWith('/explain'))

async function mountExplain(canManageIndexes = true) {
  const mounted = mountApp(ExplainView, { props: { target, tabId: TAB, canManageIndexes } })
  await flushPromises()
  return mounted
}

describe('the Explain section (phase 2b spec §3.1)', () => {
  it('explains the Documents query, with the summary, the tree and its marks', async () => {
    const { calls } = setup()
    await mountExplain()
    button('Explain').click()
    await flushPromises()
    expect(explains(calls)[0]!.body).toMatchObject({
      kind: 'find',
      filter: { s: 's3' },
      sort: { n: { $numberInt: '-1' } },
      verbosity: 'executionStats',
    })
    const summary = document.querySelector('[data-explain-summary]')!.textContent!
    expect(summary).toContain('3,000')
    expect(summary).toContain('60')
    const tree = document.querySelector('[role="tree"]')!
    const items = [...tree.querySelectorAll<HTMLElement>('[role="treeitem"]')]
    expect(items.map((i) => i.dataset.stage)).toEqual(['SORT', 'COLLSCAN'])
    expect(items.map((i) => i.dataset.mark)).toEqual(['SORT', 'COLLSCAN'])
  })

  it('moves through the tree with the arrow keys and folds nodes', async () => {
    setup()
    await mountExplain()
    button('Explain').click()
    await flushPromises()
    // The first tree is the winning plan (rejected plans have trees of their own).
    const items = () => [
      ...document.querySelector('[role="tree"]')!.querySelectorAll<HTMLElement>('[role="treeitem"]'),
    ]
    items()[0]!.focus()
    items()[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    await flushPromises()
    expect(document.activeElement).toBe(items()[1])
    items()[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    await flushPromises()
    expect(document.activeElement).toBe(items()[0])
    items()[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    await flushPromises()
    expect(items()[0]!.getAttribute('aria-expanded')).toBe('false')
    expect(items()).toHaveLength(1)
    items()[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    await flushPromises()
    expect(items()).toHaveLength(2)
  })

  it('lists warnings in words, rejected plans folded, and suggests an index to create', async () => {
    setup()
    await mountExplain()
    button('Explain').click()
    await flushPromises()
    const warnings = document.querySelector('[data-explain-warnings]')!.textContent!
    expect(warnings).toContain('3,000')
    expect(warnings).toMatch(/sort/i)
    const rejected = document.querySelector<HTMLDetailsElement>('details[data-rejected]')!
    expect(rejected.open).toBe(false)
    expect(document.querySelector('[data-suggestion]')!.textContent).toContain('{ s: 1, n: -1 }')
    button('Create this index').click()
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull())
    const key = [...document.querySelectorAll('textarea')].find((t) => t.value.includes('s: 1'))
    expect(key!.value).toBe('{ s: 1, n: -1 }')
  })

  it('offers no index creation without the right to manage indexes', async () => {
    setup()
    await mountExplain(false)
    button('Explain').click()
    await flushPromises()
    expect(() => button('Create this index')).toThrow()
  })

  it('shows the raw output, and only that for a plan it could not read (Review Focus 1)', async () => {
    setup(result({ winning: null, rejected: [], warnings: [], suggestion: null }))
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    await mountExplain()
    button('Explain').click()
    await flushPromises()
    expect(document.querySelector('[role="tree"]')).toBeNull()
    expect(document.body.textContent).toContain('raw output')
    const raw = document.querySelector<HTMLDetailsElement>('details[data-raw]')!
    expect(raw.open).toBe(true)
    expect(raw.querySelector('pre')!.textContent).toContain('winningPlan')
    button('Copy').click()
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('winningPlan'))
  })

  it('sends the chosen verbosity, and lists the stages after the query of a pipeline', async () => {
    const { calls, state } = setup(
      result({ pipeline: [{ stage: '$sort', nReturned: 5, executionTimeMillisEstimate: 7 }], warnings: [] }),
    )
    state.aggregation.cards = [{ ...newCard('$match'), text: '{ a: 1 }' }]
    state.explain.source = 'aggregation'
    await mountExplain()
    const verbosity = byLabel<HTMLSelectElement>('Detail')
    verbosity.value = 'allPlansExecution'
    verbosity.dispatchEvent(new Event('change'))
    button('Explain').click()
    await flushPromises()
    expect(explains(calls)[0]!.body).toMatchObject({
      kind: 'aggregate',
      stages: [{ $match: { a: { $numberInt: '1' } } }],
      verbosity: 'allPlansExecution',
    })
    expect(document.querySelector('[data-explain-pipeline]')!.textContent).toContain('$sort')
  })
})

describe('"Why is it slow?" (phase 2b spec §1)', () => {
  it('opens Explain on the pipeline from the Aggregations tab, and runs it', async () => {
    const { calls, state } = setup()
    mockApi({
      [`POST ${BASE}/explain`]: () => [200, result()],
      [`POST ${BASE}/aggregate/preview`]: () => [200, { sample: null, stages: [null] }],
    })
    state.aggregation.cards = [{ ...newCard('$match'), text: '{ a: 1 }' }]
    mountApp(AggregationView, { props: { target, tabId: TAB, canWrite: true } })
    await flushPromises()
    button('Why is it slow?').click()
    expect(state.section).toBe('explain')
    expect(state.explain.source).toBe('aggregation')
    const before = state.explain.request
    expect(before).toBeGreaterThan(0)
    void calls
  })

  it('is not offered for a pipeline that writes', async () => {
    const { state } = setup()
    mockApi({ [`POST ${BASE}/aggregate/preview`]: () => [200, { sample: null, stages: [null, null] }] })
    state.aggregation.cards = [
      { ...newCard('$match'), text: '{}' },
      { ...newCard('$out'), text: '"x"' },
    ]
    mountApp(AggregationView, { props: { target, tabId: TAB, canWrite: true } })
    await flushPromises()
    expect(button('Why is it slow?').disabled).toBe(true)
  })

  it('runs as soon as Explain opens after "Why is it slow?"', async () => {
    const { calls, state } = setup()
    state.explain.request = 1
    await mountExplain()
    expect(calls.filter((c) => c.path.endsWith('/explain'))).toHaveLength(1)
  })
})

describe('explain fixes (final review 2b)', () => {
  it('does not run again when the section is opened again, and keeps the last result (I5)', async () => {
    const { calls, state } = setup()
    state.explain.request = 1
    const first = await mountExplain()
    expect(explains(calls)).toHaveLength(1)
    first.wrapper.unmount()
    await mountExplain()
    expect(explains(calls)).toHaveLength(1)
    expect(document.querySelector('[data-explain-summary]')).not.toBeNull()
  })

  it('marks a result that no longer matches what would be explained (M9)', async () => {
    const { state } = setup()
    await mountExplain()
    button('Explain').click()
    await flushPromises()
    expect(document.querySelector('[data-explain-stale]')).toBeNull()
    state.explain.verbosity = 'queryPlanner'
    await flushPromises()
    expect(document.querySelector('[data-explain-stale]')!.textContent).toContain('Explain again')
  })

  it('says when the run stopped at its time limit, and whether the plan cache was used', async () => {
    setup(
      result({
        incomplete: { code: 50, message: 'operation exceeded time limit' },
        warnings: [{ code: 'INCOMPLETE', detail: { code: 50 } }],
        summary: { nReturned: 5, planCacheUsed: true },
      }),
    )
    await mountExplain()
    button('Explain').click()
    await flushPromises()
    expect(document.querySelector('[data-explain-warnings]')!.textContent).toContain('time limit')
    expect(document.querySelector('[data-explain-summary]')!.textContent).toContain('Plan cache')
  })

  it('says when the run stopped before giving any numbers, and the plan is shown alone', async () => {
    const incomplete = {
      code: 50,
      message: 'The operation exceeded its time limit (maxTimeMS)',
      planOnly: true,
    } as const
    setup(
      result({
        incomplete,
        warnings: [
          { code: 'INCOMPLETE', detail: { ...incomplete } },
          { code: 'COLLSCAN', stage: 'COLLSCAN', detail: { uncounted: true } },
        ],
        summary: {},
      }),
    )
    await mountExplain()
    button('Explain').click()
    await flushPromises()
    const text = document.querySelector('[data-explain-warnings]')!.textContent!
    expect(text).toContain('this is the plan only')
    expect(text).not.toContain('these numbers are partial')
    // A scan with no count is named without one.
    expect(text).toContain('Scans the whole collection. An index')
    expect(text).not.toContain('{docs}')
    expect(text).not.toContain('documents read')
    // No figures that were never measured: the summary says why there are none.
    const summary = document.querySelector('[data-explain-summary]')!.textContent!
    expect(summary).toContain('Not measured: stopped at its time limit')
    for (const figure of ['Returned', 'Keys examined', 'Documents examined', 'Time'])
      expect(summary).not.toContain(figure)
    expect(summary).toContain('Engine')
    i18n.global.locale.value = 'tr'
    await flushPromises()
    const tr = document.querySelector('[data-explain-warnings]')!.textContent!
    expect(tr).toContain('yalnızca plan')
    expect(tr).toContain('Koleksiyonun tamamını tarar. Filtrelenen')
    expect(document.querySelector('[data-explain-summary]')!.textContent).toContain(
      'Ölçülmedi: süre sınırında durdu',
    )
  })

  it('says the run stopped, not that it ran out of time, when MongoDB stopped it otherwise', async () => {
    setup(
      result({
        incomplete: { code: 292, message: 'Sort exceeded memory limit' },
        warnings: [{ code: 'INCOMPLETE', detail: { code: 292, message: 'Sort exceeded memory limit' } }],
        summary: { nReturned: 5 },
      }),
    )
    await mountExplain()
    button('Explain').click()
    await flushPromises()
    const text = document.querySelector('[data-explain-warnings]')!.textContent!
    expect(text).toContain('The run stopped before it finished')
    expect(text).not.toContain('time limit')
  })

  it('says the run stopped when MongoDB named no reason at all', async () => {
    setup(
      result({
        incomplete: { message: 'stopped' },
        warnings: [{ code: 'INCOMPLETE', detail: { message: 'stopped' } }],
        summary: { nReturned: 5 },
      }),
    )
    await mountExplain()
    button('Explain').click()
    await flushPromises()
    expect(document.querySelector('[data-explain-warnings]')!.textContent).toContain(
      'The run stopped before it finished',
    )
  })

  it('keeps the tree reachable with Tab after folding the focused row away, and resets on a new plan (M8)', async () => {
    setup(
      result({
        winning: {
          stage: 'LIMIT',
          children: [{ stage: 'SORT', children: [{ stage: 'COLLSCAN', children: [] }] }],
        },
        rejected: [],
      }),
    )
    await mountExplain()
    button('Explain').click()
    await flushPromises()
    const tree = () => document.querySelector('[role="tree"]')!
    const items = () => [...tree().querySelectorAll<HTMLElement>('[role="treeitem"]')]
    items()[2]!.click()
    await flushPromises()
    items()[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    await flushPromises()
    expect(items()).toHaveLength(1)
    expect(items().filter((i) => i.tabIndex === 0)).toHaveLength(1)
    button('Explain').click()
    await flushPromises()
    expect(items()).toHaveLength(3)
  })
})
