// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import AggregationView from '../src/aggregation/AggregationView.vue'
import { readNdjson } from '../src/aggregation/ndjson'
import { useCollectionViewsStore } from '../src/stores/collectionViews'
import { useDialogStore } from '../src/stores/dialogs'
import { useSessionStore } from '../src/stores/session'
import { useToastStore } from '../src/stores/toasts'
import { useWorkspaceDialogs } from '../src/stores/workspaceDialogs'
import { cardsKey, newCard } from '../src/aggregation/stages'
import { i18n } from '../src/i18n'
import { mockApi, mountApp, type Handler } from './support/app'
import { button, byLabel } from './support/dom'

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

const BASE = 'connections/c1/databases/shop/collections/orders'
const target = { connectionId: 'c1', db: 'shop', coll: 'orders' }
const TAB = 'tab-run'
const line = (value: unknown) => `${JSON.stringify(value)}\n`
const doc = (n: number) => ({ document: { n: { $numberInt: String(n) } }, hash: 'h'.repeat(64) })
const enc = new TextEncoder()

function streamOf(chunks: string[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c))
      controller.close()
    },
  })
}

describe('readNdjson (phase 2a spec §4.5)', () => {
  it('joins lines split across chunks, keeps a last line without newline, and hands them over in chunks', async () => {
    const got: unknown[][] = []
    const text = `${line({ a: 1 })}{"b"`
    await readNdjson(streamOf([text, ':2}\n{"c":3}']), (lines) => void got.push(lines), 2)
    expect(got.flat()).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }])
    const many: unknown[][] = []
    await readNdjson(
      streamOf([Array.from({ length: 5 }, (_, i) => line({ i })).join('')]),
      (lines) => void many.push(lines),
      2,
    )
    expect(many.map((l) => l.length)).toEqual([2, 2, 1])
  })
})

/** A controllable run stream: `push` adds lines, `end` closes it; the request's signal is kept. */
function runStub(handlers: Record<string, Handler>) {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) })
  const state = { signal: undefined as AbortSignal | undefined, runs: 0 }
  const { fetchMock, calls } = mockApi(handlers)
  const api = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    if (String(input).endsWith('/aggregate/run')) {
      state.runs++
      state.signal = init.signal ?? undefined
      calls.push({
        method: 'POST',
        path: `${BASE}/aggregate/run`,
        body: JSON.parse(String(init.body)),
        headers: {},
      })
      return new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson' } })
    }
    return api(input, init)
  })
  return {
    state,
    calls,
    push: (...values: unknown[]) => controller.enqueue(enc.encode(values.map(line).join(''))),
    end: () => controller.close(),
  }
}

const preview: Handler = (body) => [
  200,
  { sample: null, stages: (body as { stages: unknown[] }).stages.map(() => ({ documents: [], count: 0 })) },
]

async function mountView(canWrite = true, cards = [{ ...newCard('$match'), text: '{ a: 1 }' }]) {
  useCollectionViewsStore().stateFor(TAB).aggregation.cards = cards
  const mounted = mountApp(AggregationView, { props: { target, tabId: TAB, canWrite } })
  await flushPromises()
  return mounted
}

describe('running a pipeline (phase 2a spec §4.5)', () => {
  it('shows rows as they stream in, then the count, and stops on request', async () => {
    const run = runStub({
      [`POST ${BASE}/aggregate/preview`]: preview,
      [`POST ${BASE}/aggregate/count`]: () => [200, { count: 1234 }],
    })
    await mountView()
    button('Run').click()
    await flushPromises()
    expect(run.calls.find((c) => c.path.endsWith('/run'))!.body).toMatchObject({
      stages: [{ $match: { a: { $numberInt: '1' } } }],
    })
    run.push(doc(1), doc(2))
    await vi.waitFor(() => expect(document.querySelectorAll('[data-results] li').length).toBe(2))
    expect(document.querySelector('[data-results]')!.textContent).toContain('2 documents')
    button('Stop').click()
    expect(run.state.signal!.aborted).toBe(true)
  })

  it('says when the run stopped at the limit, and computes the total on demand', async () => {
    const run = runStub({
      [`POST ${BASE}/aggregate/preview`]: preview,
      [`POST ${BASE}/aggregate/count`]: () => [200, { count: 1234 }],
    })
    await mountView()
    button('Run').click()
    await flushPromises()
    run.push(doc(1), { end: { count: 1, truncated: true, bytes: 10 } })
    run.end()
    await vi.waitFor(() =>
      expect(document.querySelector('[data-results]')!.textContent).toContain('Stopped at the limit'),
    )
    button('Compute total').click()
    await flushPromises()
    expect(document.querySelector('[data-results]')!.textContent).toContain('1,234')
  })

  it('names the limit the run used, not the one chosen since, and again after a section switch (reviewer C I4)', async () => {
    const run = runStub({ [`POST ${BASE}/aggregate/preview`]: preview })
    const first = await mountView()
    button('Run').click()
    await flushPromises()
    run.push(doc(1), { end: { count: 1000, truncated: true, bytes: 10 } })
    run.end()
    const results = () => document.querySelector('[data-results]')!
    await vi.waitFor(() => expect(results().textContent).toContain('Stopped at the limit (1,000)'))
    const select = byLabel<HTMLSelectElement>('Up to')
    select.value = '10000'
    select.dispatchEvent(new Event('change'))
    await flushPromises()
    expect(results().textContent).toContain('Stopped at the limit (1,000)')
    first.wrapper.unmount()
    await mountView(true, useCollectionViewsStore().stateFor(TAB).aggregation.cards)
    expect(results().textContent).toContain('Stopped at the limit (1,000)')
  })

  it('says the rows shown are from an earlier version once the pipeline changes (reviewer C Minor 9)', async () => {
    const run = runStub({ [`POST ${BASE}/aggregate/preview`]: preview })
    await mountView()
    button('Run').click()
    await flushPromises()
    run.push(doc(1), { end: { count: 1, truncated: false, bytes: 10 } })
    run.end()
    await vi.waitFor(() =>
      expect(document.querySelector('[data-results]')!.textContent).toContain('1 document'),
    )
    expect(document.querySelector('[data-run-stale]')).toBeNull()
    useCollectionViewsStore().stateFor(TAB).aggregation.cards[0]!.text = '{ a: 2 }'
    await flushPromises()
    expect(document.querySelector('[data-run-stale]')!.textContent).toContain('earlier version')
    expect(document.querySelector('[data-results]')!.textContent).not.toContain('Compute total')
  })

  it('shows an error line from the stream', async () => {
    const run = runStub({ [`POST ${BASE}/aggregate/preview`]: preview })
    await mountView()
    button('Run').click()
    await flushPromises()
    run.push(doc(1), { error: { code: 'MONGO_ERROR', message: 'Failed to parse number' } })
    run.end()
    await vi.waitFor(() =>
      expect(document.querySelector('[data-results] [role="alert"]')!.textContent).toContain(
        'Failed to parse number',
      ),
    )
  })
})

// User report 2026-10-13: a pipeline the assistant wrote is run once it is opened from the chat —
// shown with its results, never a write, and never once the stages are no longer those handed over.
describe('a pipeline handed over to run', () => {
  const hand = (cards: ReturnType<typeof newCard>[]) => {
    const agg = useCollectionViewsStore().stateFor(TAB).aggregation
    agg.cards = cards
    agg.runOnArrival = cardsKey(cards)
    return agg
  }

  it('runs once on arrival and shows its results', async () => {
    const run = runStub({ [`POST ${BASE}/aggregate/preview`]: preview })
    const agg = hand([{ ...newCard('$match'), text: '{ a: 1 }' }])
    await mountView(true, agg.cards)
    await vi.waitFor(() => expect(run.state.runs).toBe(1))
    expect(agg.runOnArrival).toBeNull()
    expect(agg.pane).toBe('results')
  })

  it('runs one handed over while the builder is open', async () => {
    const run = runStub({ [`POST ${BASE}/aggregate/preview`]: preview })
    await mountView()
    expect(run.state.runs).toBe(0)
    hand([{ ...newCard('$match'), text: '{ b: 2 }' }])
    await flushPromises()
    await vi.waitFor(() => expect(run.state.runs).toBe(1))
  })

  // Review 2026-10-13 (M4): a hand-over the builder never took runs nothing later, once changed.
  it('runs nothing once the stages are no longer those handed over', async () => {
    const run = runStub({ [`POST ${BASE}/aggregate/preview`]: preview })
    const agg = hand([{ ...newCard('$match'), text: '{ a: 1 }' }])
    agg.cards[0]!.text = '{ a: 2 }'
    await mountView(true, agg.cards)
    await flushPromises()
    expect(run.state.runs).toBe(0)
    expect(agg.runOnArrival).toBeNull()
    expect(agg.pane).toBe('pipeline')
  })

  it('never runs a pipeline that writes: it is shown, for the user to run', async () => {
    const run = runStub({ [`POST ${BASE}/aggregate/preview`]: preview })
    const agg = hand([
      { ...newCard('$match'), text: '{}' },
      { ...newCard('$out'), text: '"copy"' },
    ])
    await mountView(true, agg.cards)
    await flushPromises()
    expect(run.state.runs).toBe(0)
    expect(agg.runOnArrival).toBeNull()
    expect(agg.pane).toBe('pipeline')
  })
})

describe('$out and $merge (phase 2a spec §4.5)', () => {
  const writeCards = () => [
    { ...newCard('$match'), text: '{}' },
    { ...newCard('$out'), text: '"copy"' },
  ]

  it('previews the write, asks for the target name before replacing it, then writes once', async () => {
    const { calls } = mockApi({
      [`POST ${BASE}/aggregate/preview`]: preview,
      [`POST ${BASE}/aggregate/write-preview`]: () => [
        200,
        {
          target: { db: 'shop', coll: 'copy' },
          stage: '$out',
          exists: true,
          estimatedCount: 7,
          token: 'tok',
          confirmRequired: true,
        },
      ],
      [`POST ${BASE}/aggregate/write`]: () => [200, { ok: true, target: { db: 'shop', coll: 'copy' } }],
    })
    await mountView(true, writeCards())
    expect(() => button('Run')).toThrow()
    button('Run $out / $merge…').click()
    await flushPromises()
    const dialog = useDialogStore().current!
    expect(dialog.message).toContain('shop.copy')
    expect(dialog.message).toContain('7')
    expect(dialog.requireText).toBe('copy')
    useDialogStore().settle(true)
    await flushPromises()
    const write = calls.filter((c) => c.path.endsWith('/aggregate/write'))
    expect(write).toHaveLength(1)
    expect(write[0]!.body).toMatchObject({ token: 'tok', confirm: 'copy' })
  })

  it('hides the write without the right to write', async () => {
    mockApi({ [`POST ${BASE}/aggregate/preview`]: preview })
    await mountView(false, writeCards())
    expect(() => button('Run $out / $merge…')).toThrow()
  })
})

describe('saved pipelines, export and views (phase 2a spec §4.6)', () => {
  const saved = {
    id: '6f8c2d7e-8a8b-4c1d-9e0f-1a2b3c4d5e6f',
    name: 'Big orders',
    stages: [{ $limit: { $numberInt: '3' } }],
    shared: true,
    mine: false,
    owner: 'ada',
    updatedAt: '2026-09-27T10:00:00.000Z',
  }

  it('saves the enabled stages under a name', async () => {
    const { calls } = mockApi({
      [`POST ${BASE}/aggregate/preview`]: preview,
      [`GET ${BASE}/pipelines`]: () => [200, { pipelines: [] }],
      [`POST ${BASE}/pipelines`]: (body) => [201, { ...saved, ...(body as object), id: 'x', mine: true }],
    })
    await mountView(true, [
      { ...newCard('$match'), text: '{ a: 1 }' },
      { ...newCard('$limit'), text: '1', enabled: false },
    ])
    button('Save as…').click()
    await flushPromises()
    // Phase 2c: Save as asks for a name, tags and sharing.
    const field = (label: string) => {
      const el = [...document.querySelectorAll('label')].find((l) => l.textContent?.trim() === label)!
      return document.getElementById(el.htmlFor) as HTMLInputElement
    }
    field('Name').value = 'Mine'
    field('Name').dispatchEvent(new Event('input'))
    field('Tags').value = 'ETL, weekly'
    field('Tags').dispatchEvent(new Event('input'))
    await flushPromises()
    ;[...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
      .find((b) => b.textContent?.trim() === 'Save')!
      .click()
    await flushPromises()
    expect(calls.find((c) => c.method === 'POST' && c.path.endsWith('/pipelines'))!.body).toEqual({
      name: 'Mine',
      stages: [{ $match: { a: { $numberInt: '1' } } }],
      tags: ['etl', 'weekly'],
      shared: false,
    })
  })

  it('opens a saved pipeline in place of the cards, with an undo', async () => {
    mockApi({
      [`POST ${BASE}/aggregate/preview`]: preview,
      [`GET ${BASE}/pipelines`]: () => [200, { pipelines: [saved] }],
    })
    await mountView()
    const cards = () => useCollectionViewsStore().stateFor(TAB).aggregation.cards
    button('Pipelines').click()
    await flushPromises()
    const item = document.querySelector<HTMLElement>(`[data-pipeline="${saved.id}"]`)!
    expect(item.textContent).toContain('Big orders')
    expect(item.textContent).toContain('Shared')
    expect(item.textContent).toContain('ada')
    item.querySelector<HTMLButtonElement>('button[data-action="open"]')!.click()
    await flushPromises()
    expect(cards().map((c) => [c.operator, c.text])).toEqual([['$limit', '3']])
    button('Undo').click()
    await flushPromises()
    expect(cards().map((c) => c.operator)).toEqual(['$match'])
  })

  it('deletes a pipeline after asking', async () => {
    const { calls } = mockApi({
      [`POST ${BASE}/aggregate/preview`]: preview,
      [`GET ${BASE}/pipelines`]: () => [200, { pipelines: [{ ...saved, mine: true }] }],
      [`DELETE ${BASE}/pipelines/${saved.id}`]: () => [204],
    })
    await mountView()
    button('Pipelines').click()
    await flushPromises()
    document
      .querySelector<HTMLButtonElement>(`[data-pipeline="${saved.id}"] button[data-action="delete"]`)!
      .click()
    await flushPromises()
    expect(useDialogStore().current!.danger).toBe(true)
    useDialogStore().settle(true)
    await flushPromises()
    expect(calls.some((c) => c.method === 'DELETE')).toBe(true)
  })

  it('exports the pipeline to each language, and copies it', async () => {
    mockApi({ [`POST ${BASE}/aggregate/preview`]: preview })
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    await mountView()
    button('Export…').click()
    // The dialog is a lazy chunk.
    await vi.waitFor(() => expect(document.querySelector('[role="tab"][data-language]')).not.toBeNull())
    const tabs = [...document.querySelectorAll<HTMLElement>('[role="tab"][data-language]')]
    expect(tabs.map((t) => t.dataset.language)).toEqual([
      'node',
      'python',
      'java',
      'go',
      'csharp',
      'php',
      'ruby',
      'rust',
    ])
    tabs[1]!.click()
    await flushPromises()
    const code = document.querySelector('[data-export-code]')!.textContent!
    expect(code).toContain('from pymongo import MongoClient')
    expect(code).toContain('"$match": {"a": 1}')
    button('Copy').click()
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('MONGODB_URI'))
  })

  it('creates a view from the enabled stages', async () => {
    mockApi({ [`POST ${BASE}/aggregate/preview`]: preview })
    await mountView()
    button('Create view…').click()
    expect(useWorkspaceDialogs().current).toMatchObject({
      kind: 'createCollection',
      connectionId: 'c1',
      db: 'shop',
      view: { viewOn: 'orders', pipeline: expect.stringContaining('$match') },
    })
  })
})

describe('run fixes (final review 2a)', () => {
  it('shows nothing more from a stopped run (I6)', async () => {
    const run = runStub({ [`POST ${BASE}/aggregate/preview`]: preview })
    await mountView()
    button('Run').click()
    await flushPromises()
    run.push(doc(1))
    await vi.waitFor(() => expect(document.querySelectorAll('[data-results] li').length).toBe(1))
    button('Stop').click()
    run.push(doc(2), doc(3))
    await new Promise((r) => setTimeout(r, 50))
    await flushPromises()
    expect(document.querySelectorAll('[data-results] li').length).toBe(1)
  })

  it('says so when the stream ends without its end line (Minor 5)', async () => {
    const run = runStub({ [`POST ${BASE}/aggregate/preview`]: preview })
    await mountView()
    button('Run').click()
    await flushPromises()
    run.push(doc(1))
    run.end()
    await vi.waitFor(() =>
      expect(document.querySelector('[data-results] [role="alert"]')!.textContent).toContain('ended before'),
    )
  })

  it('shows the results as a table too (Minor 6)', async () => {
    const run = runStub({ [`POST ${BASE}/aggregate/preview`]: preview })
    await mountView()
    button('Run').click()
    await flushPromises()
    run.push(doc(1), doc(2), { end: { count: 2, truncated: false, bytes: 10 } })
    run.end()
    await vi.waitFor(() => expect(document.querySelectorAll('[data-results] li').length).toBe(2))
    ;[
      ...document.querySelectorAll<HTMLButtonElement>(
        '[data-results] [aria-label="Show results as"] [role="radio"]',
      ),
    ]
      .find((r) => r.textContent?.trim() === 'Table')!
      .click()
    await flushPromises()
    expect(document.querySelectorAll('[data-results] tbody tr[data-row]').length).toBe(2)
  })

  it('forgets the total when the pipeline changes (Minor 8)', async () => {
    const run = runStub({
      [`POST ${BASE}/aggregate/preview`]: preview,
      [`POST ${BASE}/aggregate/count`]: () => [200, { count: 1234 }],
    })
    await mountView()
    button('Run').click()
    await flushPromises()
    run.push(doc(1), { end: { count: 1, truncated: true, bytes: 10 } })
    run.end()
    await vi.waitFor(() => expect(document.body.textContent).toContain('Stopped at the limit'))
    button('Compute total').click()
    await flushPromises()
    expect(document.querySelector('[data-results]')!.textContent).toContain('1,234')
    useCollectionViewsStore().stateFor(TAB).aggregation.cards[0]!.text = '{ a: 2 }'
    await flushPromises()
    expect(document.querySelector('[data-results]')!.textContent).not.toContain('1,234')
  })

  it('warns that $merge is not atomic (I7)', async () => {
    mockApi({
      [`POST ${BASE}/aggregate/preview`]: preview,
      [`POST ${BASE}/aggregate/write-preview`]: () => [
        200,
        {
          target: { db: 'shop', coll: 'm' },
          stage: '$merge',
          exists: true,
          estimatedCount: 3,
          token: 't',
          confirmRequired: false,
        },
      ],
    })
    await mountView(true, [
      { ...newCard('$match'), text: '{}' },
      { ...newCard('$merge'), text: '"m"' },
    ])
    button('Run $out / $merge…').click()
    await flushPromises()
    expect(useDialogStore().current!.message).toContain('not atomic')
    useDialogStore().settle(false)
  })

  it('restores the saved pipeline and the text mode with Undo (Minor 7)', async () => {
    mockApi({
      [`POST ${BASE}/aggregate/preview`]: preview,
      [`GET ${BASE}/pipelines`]: () => [
        200,
        {
          pipelines: [
            {
              id: '6f8c2d7e-8a8b-4c1d-9e0f-1a2b3c4d5e6f',
              name: 'Other',
              stages: [{ $limit: { $numberInt: '3' } }],
              shared: false,
              mine: true,
              owner: null,
              updatedAt: '2026-09-27T10:00:00.000Z',
            },
          ],
        },
      ],
    })
    const state = useCollectionViewsStore().stateFor(TAB).aggregation
    state.saved = { id: 'mine-1', name: 'Mine', shared: false }
    await mountView()
    button('Pipelines').click()
    await flushPromises()
    document.querySelector<HTMLButtonElement>('button[data-action="open"]')!.click()
    await flushPromises()
    expect(state.saved).toMatchObject({ name: 'Other' })
    button('Undo').click()
    await flushPromises()
    expect(state.saved).toEqual({ id: 'mine-1', name: 'Mine', shared: false })
  })
})

describe('coming back to Aggregations (UI redesign R1 review: "her seferinde yeniden çalışıyor")', () => {
  it('neither previews nor runs again when nothing changed, and shows the last results', async () => {
    const run = runStub({ [`POST ${BASE}/aggregate/preview`]: preview })
    const first = await mountView()
    await vi.waitFor(() => expect(run.calls.filter((c) => c.path.endsWith('/preview'))).toHaveLength(1))
    button('Run').click()
    await flushPromises()
    run.push(doc(1), doc(2), { end: { count: 2, truncated: false, bytes: 10 } })
    run.end()
    await vi.waitFor(() =>
      expect(document.querySelector('[data-results]')!.textContent).toContain('2 documents'),
    )
    first.wrapper.unmount()
    mountApp(AggregationView, { props: { target, tabId: TAB, canWrite: true } })
    await new Promise((r) => setTimeout(r, 500))
    await flushPromises()
    expect(run.calls.filter((c) => c.path.endsWith('/preview'))).toHaveLength(1)
    expect(run.state.runs).toBe(1)
    expect(document.querySelector('[data-results]')!.textContent).toContain('2 documents')
    expect(document.querySelectorAll('[data-results] li')).toHaveLength(2)
  })

  it('forgets what it kept at sign-out (the documents belong to that user)', async () => {
    const run = runStub({ [`POST ${BASE}/aggregate/preview`]: preview })
    const first = await mountView()
    await vi.waitFor(() => expect(run.calls.filter((c) => c.path.endsWith('/preview'))).toHaveLength(1))
    first.wrapper.unmount()
    useCollectionViewsStore().reset()
    await mountView()
    await vi.waitFor(() => expect(run.calls.filter((c) => c.path.endsWith('/preview'))).toHaveLength(2))
  })
})

describe('the results (UI redesign R1 review: "çalıştı mı, datalar nerede, ya 1000 sonuç olsa?")', () => {
  it('switches to the results on Run, says how the run went, and pages a long result', async () => {
    const run = runStub({ [`POST ${BASE}/aggregate/preview`]: preview })
    await mountView()
    button('Run').click()
    await flushPromises()
    const results = document.querySelector<HTMLElement>('[data-results]')!
    expect(results.closest('[hidden]'), 'results shown').toBeNull()
    expect(results.textContent).toContain('Running')
    run.push(...Array.from({ length: 120 }, (_, i) => doc(i)), {
      end: { count: 120, truncated: false, bytes: 10 },
    })
    run.end()
    await vi.waitFor(() => expect(results.textContent).toContain('120 documents'))
    expect(results.querySelector('[data-run-status]')!.textContent).toMatch(/Done/)
    // 50 at a time, with the place in the result said.
    expect(results.querySelectorAll('li[data-row-item], ol > li').length).toBeLessThanOrEqual(50)
    expect(results.textContent).toContain('1–50 of 120')
    results.querySelector<HTMLButtonElement>('button[aria-label="Next results"]')!.click()
    await flushPromises()
    expect(results.textContent).toContain('51–100 of 120')
    // Back to the pipeline, and to the results again: nothing is lost.
    ;[...document.querySelectorAll<HTMLElement>('[role="tab"]')]
      .find((t) => t.textContent?.includes('Pipeline'))!
      .click()
    await flushPromises()
    expect(results.closest('[hidden], [style*="display: none"]')).not.toBeNull()
    ;[...document.querySelectorAll<HTMLElement>('[role="tab"]')]
      .find((t) => t.textContent?.includes('Results'))!
      .click()
    await flushPromises()
    expect(results.textContent).toContain('120 documents')
    expect(run.state.runs).toBe(1)
  })
})

describe('saved pipelines, share, delete and new (UI redesign R1 review)', () => {
  const SAVED = {
    id: '7a8c2d7e-8a8b-4c1d-9e0f-1a2b3c4d5e6f',
    name: 'Test',
    stages: [{ $limit: { $numberInt: '3' } }],
    tags: [],
    shared: false,
    mine: true,
    owner: null,
    updatedAt: '2026-10-07T10:00:00.000Z',
  }
  const openMenu = async () => {
    button('Pipelines').click()
    await flushPromises()
    return document.querySelector<HTMLElement>(`[data-pipeline="${SAVED.id}"]`)!
  }

  it('offers no sharing where there is no one to share with (local mode)', async () => {
    mockApi({
      [`POST ${BASE}/aggregate/preview`]: preview,
      [`GET ${BASE}/pipelines`]: () => [200, { pipelines: [SAVED] }],
    })
    useSessionStore().status = { mode: 'local', setupRequired: false, authenticated: true }
    await mountView()
    expect((await openMenu()).querySelector('button[data-action="share"]')).toBeNull()
  })

  it('says what sharing does, in team mode', async () => {
    mockApi({
      [`POST ${BASE}/aggregate/preview`]: preview,
      [`GET ${BASE}/pipelines`]: () => [200, { pipelines: [SAVED] }],
      [`PUT ${BASE}/pipelines/${SAVED.id}`]: () => [200, { ...SAVED, shared: true }],
    })
    useSessionStore().status = { mode: 'team', setupRequired: false, authenticated: true }
    await mountView()
    const share = (await openMenu()).querySelector<HTMLButtonElement>('button[data-action="share"]')!
    expect(share.title).toContain('Everyone who can open this collection')
    share.click()
    await flushPromises()
    expect(useToastStore().toasts.at(-1)?.message).toContain('Everyone who can open this collection')
  })

  it('forgets the name of the open pipeline when it is deleted', async () => {
    mockApi({
      [`POST ${BASE}/aggregate/preview`]: preview,
      [`GET ${BASE}/pipelines`]: () => [200, { pipelines: [SAVED] }],
      [`DELETE ${BASE}/pipelines/${SAVED.id}`]: () => [204],
    })
    await mountView()
    ;(await openMenu()).querySelector<HTMLButtonElement>('button[data-action="open"]')!.click()
    await flushPromises()
    const state = useCollectionViewsStore().stateFor(TAB).aggregation
    expect(state.saved?.name).toBe('Test')
    ;(await openMenu()).querySelector<HTMLButtonElement>('button[data-action="delete"]')!.click()
    await flushPromises()
    useDialogStore().settle(true)
    await flushPromises()
    expect(state.saved).toBeNull()
    expect(state.cards.map((c) => c.operator)).toEqual(['$limit'])
  })

  it('keeps a share made from the menu when the open pipeline is saved again (reviewer C I3)', async () => {
    const { calls } = mockApi({
      [`POST ${BASE}/aggregate/preview`]: preview,
      [`GET ${BASE}/pipelines`]: () => [200, { pipelines: [SAVED] }],
      [`PUT ${BASE}/pipelines/${SAVED.id}`]: (body) => [200, { ...SAVED, ...(body as object) }],
    })
    useSessionStore().status = { mode: 'team', setupRequired: false, authenticated: true }
    await mountView()
    ;(await openMenu()).querySelector<HTMLButtonElement>('button[data-action="open"]')!.click()
    await flushPromises()
    ;(await openMenu()).querySelector<HTMLButtonElement>('button[data-action="share"]')!.click()
    await flushPromises()
    button('Save').click()
    await flushPromises()
    const puts = calls.filter((c) => c.method === 'PUT')
    expect(puts).toHaveLength(2)
    expect(puts[1]!.body).toMatchObject({ name: 'Test', shared: true })
  })

  it('clears the saved steps when the steps were cleared', async () => {
    const { calls } = mockApi({
      [`POST ${BASE}/aggregate/preview`]: preview,
      [`PUT ${BASE}/pipelines/${SAVED.id}`]: (body) => [200, { ...SAVED, ...(body as object) }],
    })
    await mountView()
    const state = useCollectionViewsStore().stateFor(TAB).aggregation
    state.saved = { id: SAVED.id, name: 'Test', shared: false, tags: [] }
    state.steps = []
    button('Save').click()
    await flushPromises()
    expect(calls.find((c) => c.method === 'PUT')!.body).toMatchObject({ assistant: { steps: [] } })
  })

  it('does not bring a deleted pipeline back as the one to save to with Undo (reviewer C Minor 8)', async () => {
    const OTHER = { ...SAVED, id: '8b8c2d7e-8a8b-4c1d-9e0f-1a2b3c4d5e6f', name: 'Other' }
    mockApi({
      [`POST ${BASE}/aggregate/preview`]: preview,
      [`GET ${BASE}/pipelines`]: () => [200, { pipelines: [SAVED, OTHER] }],
      [`DELETE ${BASE}/pipelines/${SAVED.id}`]: () => [204],
    })
    await mountView()
    const state = useCollectionViewsStore().stateFor(TAB).aggregation
    state.saved = { id: SAVED.id, name: 'Test', shared: false }
    ;(await openMenu())
      .parentElement!.querySelector<HTMLButtonElement>(
        `[data-pipeline="${OTHER.id}"] button[data-action="open"]`,
      )!
      .click()
    await flushPromises()
    expect(state.saved?.name).toBe('Other')
    ;(await openMenu()).querySelector<HTMLButtonElement>('button[data-action="delete"]')!.click()
    await flushPromises()
    useDialogStore().settle(true)
    await flushPromises()
    button('Undo').click()
    await flushPromises()
    expect(state.saved).toBeNull()
  })

  it('starts a new pipeline, and Undo brings the old one back', async () => {
    mockApi({ [`POST ${BASE}/aggregate/preview`]: preview })
    await mountView()
    const state = useCollectionViewsStore().stateFor(TAB).aggregation
    state.saved = { id: SAVED.id, name: 'Test', shared: false }
    state.intent = 'paid orders'
    button('New').click()
    await flushPromises()
    expect(state.cards).toEqual([])
    expect(state.saved).toBeNull()
    expect(state.intent).toBeNull()
    button('Undo').click()
    await flushPromises()
    expect(state.cards.map((c) => c.operator)).toEqual(['$match'])
    expect(state.saved?.name).toBe('Test')
  })
})
