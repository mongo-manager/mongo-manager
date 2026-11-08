// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { JobView } from '@mongo-manager/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import IndexesView from '../src/indexes/IndexesView.vue'
import IndexCreateDialog from '../src/indexes/IndexCreateDialog.vue'
import DialogHost from '../src/ds/DsConfirmHost.vue'
import { i18n } from '../src/i18n'
import { useToastStore } from '../src/stores/toasts'
import { useJobsStore } from '../src/jobs/store'
import { mockApi, mountApp, type Handler } from './support/app'
import { button, byLabel, check, choose, typeInto } from './support/dom'
import { rowsToText, textToRows } from '../src/indexes/keyRows'

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const PREFIX = 'connections/c1/databases/shop/collections/orders/indexes'
const JOB: JobView = {
  id: 'j1',
  kind: 'index.create',
  connectionId: 'c1',
  targetConnectionId: null,
  db: 'shop',
  coll: 'orders',
  target: 'n_1',
  state: 'running',
  progress: null,
  estimate: null,
  error: null,
  startedAt: 1,
  finishedAt: null,
  mine: true,
  cancellable: true,
}
const INDEXES = [
  {
    name: '_id_',
    key: { _id: { $numberInt: '1' } },
    options: {},
    usage: { ops: 12, since: '2026-09-01T00:00:00.000Z' },
  },
  {
    name: 'email_1',
    key: { email: { $numberInt: '1' } },
    options: {
      unique: true,
      expireAfterSeconds: { $numberInt: '3600' },
      partialFilterExpression: { active: true },
    },
    usage: null,
  },
  { name: 'old_1', key: { old: { $numberInt: '-1' } }, options: { hidden: true }, usage: null },
]

async function mountIndexes(handlers: Record<string, Handler> = {}, canManage = true) {
  const api = mockApi({ [`GET ${PREFIX}`]: () => [200, INDEXES], ...handlers })
  mountApp(IndexesView, { props: { target: { connectionId: 'c1', db: 'shop', coll: 'orders' }, canManage } })
  mountApp(DialogHost)
  await flushPromises()
  return api
}

const row = (name: string) =>
  [...document.querySelectorAll('tbody tr')].find((r) => r.textContent?.includes(name))!

describe('indexes', () => {
  it('lists keys, properties and usage; _id_ has no actions', async () => {
    await mountIndexes()
    expect(row('email_1').querySelector('[title="{ email: 1 }"]')).not.toBeNull()
    expect(row('email_1').textContent).toContain('unique')
    expect(row('email_1').textContent).toContain('TTL 1 h')
    expect(row('email_1').textContent).toContain('partial')
    expect(row('email_1').textContent).toContain('No data')
    expect(row('_id_').textContent).toContain('12')
    expect(row('old_1').textContent).toContain('hidden')
    expect(row('_id_').querySelectorAll('button')).toHaveLength(0)
  })

  it('creates an index from keys and options', async () => {
    const { calls } = await mountIndexes({
      [`POST ${PREFIX}`]: () => [202, { job: { ...JOB, target: 'a_1_b_-1' } }],
    })
    button('Create index').click()
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull())
    await typeInto(byLabel<HTMLTextAreaElement>('Keys'), '{ a: 2 }')
    button('Create').click()
    await flushPromises()
    expect(document.body.textContent).toContain('Keys must look like { field: 1 }.')
    await typeInto(byLabel<HTMLTextAreaElement>('Keys'), "{ a: 1, b: -1, c: 'text' }")
    await check(byLabel('Unique'))
    await typeInto(byLabel('Delete documents after (seconds)'), '3600')
    await typeInto(byLabel<HTMLTextAreaElement>('Partial filter'), '{ active: true }')
    button('Create').click()
    await flushPromises()
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({
      key: { a: 1, b: -1, c: 'text' },
      options: { unique: true, expireAfterSeconds: 3600, partialFilterExpression: { active: true } },
    })
    // The build runs in the background: the dialog closes and says so.
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull())
    expect(useToastStore().toasts.at(-1)?.message).toBe('Building the index a_1_b_-1 in the background.')
  })

  /** UI redesign R2 §3: a row's actions are in its menu ("Actions for <name>"). */
  async function rowAction(name: string, label: string): Promise<void> {
    ;(row(name).querySelector(`button[aria-label="Actions for ${name}"]`) as HTMLButtonElement).click()
    await flushPromises()
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (el) => el.textContent?.trim() === label,
    )!
    item.click()
    await flushPromises()
  }

  // Review of K+R2 (C1): a row's actions are reached with Tab, as the buttons before them were.
  it('lets the keyboard reach each row’s actions', async () => {
    await mountIndexes()
    const trigger = row('email_1').querySelector<HTMLButtonElement>(
      'button[aria-label="Actions for email_1"]',
    )!
    expect(trigger.tabIndex).toBe(0)
    trigger.focus()
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    trigger.click()
    await flushPromises()
    expect([...document.querySelectorAll('[role="menuitem"]')].map((m) => m.textContent?.trim())).toEqual([
      'Hide',
      'Drop index',
    ])
  })

  it('hides, unhides and drops after confirmation', async () => {
    const { calls } = await mountIndexes({
      [`PATCH ${PREFIX}/email_1`]: () => [200, { name: 'email_1', hidden: true }],
      [`PATCH ${PREFIX}/old_1`]: () => [200, { name: 'old_1', hidden: false }],
      [`DELETE ${PREFIX}/email_1`]: () => [204],
    })
    await rowAction('email_1', 'Hide')
    await rowAction('old_1', 'Unhide')
    expect(calls.filter((c) => c.method === 'PATCH').map((c) => c.body)).toEqual([
      { hidden: true },
      { hidden: false },
    ])
    await rowAction('email_1', 'Drop index')
    ;(document.querySelector('[data-test="confirm"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(calls.some((c) => c.method === 'DELETE' && c.path === `${PREFIX}/email_1`)).toBe(true)
  })

  // UI redesign R2 §3: keys as chips with their direction (said, not only drawn), sizes from the stats.
  it('reads each key with its direction and shows each index’s size', async () => {
    await mountIndexes({
      ['GET connections/c1/databases/shop/collections/orders/stats']: () => [
        200,
        {
          count: 3,
          size: 1,
          storageSize: 1,
          avgObjSize: 1,
          totalIndexSize: 3072,
          nindexes: 3,
          capped: false,
          indexSizes: { email_1: 2048 },
        },
      ],
    })
    await vi.waitFor(() => expect(row('email_1').textContent).toContain('2 KB'))
    const chips = (name: string) =>
      [...row(name).querySelectorAll('td:nth-child(2) span.inline-flex')].map((c) =>
        c.textContent!.replace(/\s+/g, ' ').trim(),
      )
    expect(chips('email_1')).toEqual(['email ascending'])
    expect(chips('old_1')).toEqual(['old descending'])
  })

  it('says each index’s size is hidden where personal data is hidden from you (twelfth review)', async () => {
    await mountIndexes({
      ['GET connections/c1/databases/shop/collections/orders/stats']: () => [
        200,
        {
          count: 3,
          size: null,
          storageSize: null,
          avgObjSize: null,
          totalIndexSize: null,
          nindexes: 3,
          capped: false,
          indexSizes: {},
          sizesHidden: true,
        },
      ],
    })
    await vi.waitFor(() => expect(row('email_1').textContent).toContain('Hidden'))
  })

  it('offers no changes without the index permission', async () => {
    await mountIndexes({}, false)
    expect(document.body.textContent).not.toContain('Create index')
    expect(row('email_1').querySelectorAll('button')).toHaveLength(0)
  })
})

describe('index options and progress (phase 1g-2)', () => {
  async function openCreate(handlers: Record<string, Handler> = {}) {
    const api = await mountIndexes(handlers)
    button('Create index').click()
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull())
    return api
  }

  it('sends collation, wildcard projection, text weights and language, parsed', async () => {
    const { calls } = await openCreate({
      [`POST ${PREFIX}`]: () => [202, { job: { ...JOB, target: 'body_text' } }],
    })
    await typeInto(byLabel<HTMLTextAreaElement>('Keys'), "{ body: 'text' }")
    await typeInto(byLabel<HTMLTextAreaElement>('Text weights'), '{ body: 5 }')
    await typeInto(byLabel('Default language'), 'turkish')
    await typeInto(byLabel<HTMLTextAreaElement>('Collation'), "{ locale: 'simple' }")
    button('Create').click()
    await flushPromises()
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({
      key: { body: 'text' },
      options: { weights: { body: 5 }, default_language: 'turkish', collation: { locale: 'simple' } },
    })
  })

  it('refuses options that do not fit the keys, and bad weights', async () => {
    const { calls } = await openCreate()
    await typeInto(byLabel<HTMLTextAreaElement>('Keys'), '{ a: 1 }')
    await typeInto(byLabel<HTMLTextAreaElement>('Text weights'), '{ a: 2 }')
    button('Create').click()
    await flushPromises()
    expect(document.body.textContent).toContain('Text weights and language need a text key.')
    await typeInto(byLabel<HTMLTextAreaElement>('Text weights'), '')
    await typeInto(byLabel<HTMLTextAreaElement>('Wildcard projection'), '{ a: 1 }')
    button('Create').click()
    await flushPromises()
    expect(document.body.textContent).toContain('A wildcard projection needs the key { "$**": 1 }.')
    await typeInto(byLabel<HTMLTextAreaElement>('Keys'), "{ body: 'text' }")
    await typeInto(byLabel<HTMLTextAreaElement>('Wildcard projection'), '')
    await typeInto(byLabel<HTMLTextAreaElement>('Text weights'), '{ body: 0 }')
    button('Create').click()
    await flushPromises()
    expect(document.body.textContent).toContain('Weights must be whole numbers from 1 to 99999.')
    expect(calls.some((c) => c.method === 'POST')).toBe(false)
  })

  it('shows running builds with their measured progress, and drops them when they end (phase 1h)', async () => {
    const { calls } = await mountIndexes({
      [`GET ${PREFIX}/jobs`]: () => [200, { jobs: [{ ...JOB, progress: { done: 50, total: 200 } }] }],
    })
    await vi.waitFor(() => expect(document.body.textContent).toContain('Building n_1: 25% (50 of 200)'))
    expect(document.querySelector('[role="progressbar"]')!.getAttribute('aria-valuenow')).toBe('25')
    // Updates come from the real-time channel, not from polling.
    const store = useJobsStore()
    store.upsert({ ...JOB, progress: { done: 100, total: 200 } })
    await flushPromises()
    expect(document.body.textContent).toContain('Building n_1: 50% (100 of 200)')
    await new Promise((r) => setTimeout(r, 1500))
    expect(calls.filter((c) => c.path === `${PREFIX}/jobs`)).toHaveLength(1)
    expect(calls.some((c) => c.path.endsWith('/progress'))).toBe(false)
    store.upsert({ ...JOB, state: 'done', finishedAt: 2 })
    await flushPromises()
    expect(document.body.textContent).not.toContain('Building n_1')
  })

  it('says a build is running without numbers until MongoDB reports them', async () => {
    await mountIndexes({ [`GET ${PREFIX}/jobs`]: () => [200, { jobs: [JOB] }] })
    await vi.waitFor(() => expect(document.body.textContent).toContain('Building n_1'))
    // UI redesign R2 §3: under way, with no figure to give yet (an indeterminate bar).
    expect(document.querySelector('[role="progressbar"]')!.hasAttribute('aria-valuenow')).toBe(false)
    // Review of the Monitoring redesign (minor): what is known, said to a screen reader.
    expect(document.querySelector('[role="progressbar"]')!.getAttribute('aria-valuetext')).toBe(
      'Building; MongoDB has not said how far yet',
    )
    expect(document.body.textContent).not.toMatch(/Building n_1: \d/)
  })

  it('follows a build that outlived a server restart through MongoDB, until it is gone (final review I4)', async () => {
    let builds = [{ message: 'Index Build: scanning collection', done: 50, total: 200 }]
    const { calls } = await mountIndexes({
      [`GET ${PREFIX}/jobs`]: () => [200, { jobs: [{ ...JOB, state: 'unknown', finishedAt: 2 }] }],
      [`GET ${PREFIX}/progress`]: () => [200, { builds }],
    })
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain(
        'The server restarted; MongoDB may still be building this index',
      ),
    )
    await vi.waitFor(() => expect(document.body.textContent).toContain('Building n_1: 25% (50 of 200)'))
    builds = []
    await vi.waitFor(() => expect(document.body.textContent).not.toContain('Building n_1'), { timeout: 6000 })
    const polls = calls.filter((c) => c.path.endsWith('/progress')).length
    await new Promise((r) => setTimeout(r, 3500))
    expect(calls.filter((c) => c.path.endsWith('/progress')).length).toBe(polls)
  }, 15000)

  it('reports a failed build with its reason', async () => {
    await mountIndexes({
      [`GET ${PREFIX}/jobs`]: () => [
        200,
        { jobs: [{ ...JOB, target: 'e_1', state: 'failed', error: 'Duplicate key', finishedAt: 2 }] },
      ],
    })
    await vi.waitFor(() => expect(document.body.textContent).toContain('Building e_1 failed: Duplicate key'))
  })
})

describe('wildcard projections (final review Minor 8)', () => {
  it('are accepted for a compound wildcard key and refused for a sub-path wildcard', async () => {
    const { calls } = await mountIndexes({
      [`POST ${PREFIX}`]: () => [202, { job: { ...JOB, target: 'x' } }],
    })
    button('Create index').click()
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull())
    await typeInto(byLabel<HTMLTextAreaElement>('Keys'), "{ 'a.$**': 1 }")
    await typeInto(byLabel<HTMLTextAreaElement>('Wildcard projection'), '{ b: 1 }')
    button('Create').click()
    await flushPromises()
    expect(calls.some((c) => c.method === 'POST')).toBe(false)
    await typeInto(byLabel<HTMLTextAreaElement>('Keys'), "{ '$**': 1, b: 1 }")
    await typeInto(byLabel<HTMLTextAreaElement>('Wildcard projection'), '{ a: 1 }')
    button('Create').click()
    await flushPromises()
    expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({
      key: { '$**': 1, b: 1 },
      options: { wildcardProjection: { a: { $numberInt: '1' } } },
    })
  })
})

// UI redesign R2 §3: the keys as rows of field and type, two-way with the text.
describe('the index key builder', () => {
  async function openCreate() {
    await mountIndexes()
    button('Create index').click()
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull())
  }
  const keysText = () => byLabel<HTMLTextAreaElement>('Keys').value

  it('writes the rows into the keys, and reads the keys back into rows', async () => {
    await openCreate()
    await typeInto(byLabel('Field 1'), 'createdAt')
    await choose(byLabel<HTMLSelectElement>('Field 1 type'), '-1')
    button('Add field').click()
    await flushPromises()
    await typeInto(byLabel('Field 2'), 'body')
    await choose(byLabel<HTMLSelectElement>('Field 2 type'), 'text')
    expect(keysText()).toBe("{ createdAt: -1, body: 'text' }")

    await typeInto(byLabel<HTMLTextAreaElement>('Keys'), '{ a: 1, "b.c": -1 }')
    expect(byLabel('Field 1').value).toBe('a')
    expect(byLabel('Field 2').value).toBe('b.c')
    expect(byLabel<HTMLSelectElement>('Field 2 type').value).toBe('-1')
  })

  it('waits while the keys are not a plain key, and says the text is what counts', async () => {
    await openCreate()
    await typeInto(byLabel<HTMLTextAreaElement>('Keys'), '{ a: 2 }')
    expect(document.body.textContent).toContain('These keys are edited as text below.')
    expect(document.querySelector('[aria-label="Field 1"]')).toBeNull()
    await typeInto(byLabel<HTMLTextAreaElement>('Keys'), '{ a: 1 }')
    expect(byLabel('Field 1').value).toBe('a')
  })

  // Review of K+R2 (I1): the rows and the text never drift apart, whatever the order of edits, and the
  // text is never rewritten under the cursor.
  it('keeps the rows and the text together through any order of edits', async () => {
    await openCreate()
    const keys = byLabel<HTMLTextAreaElement>('Keys')
    await typeInto(keys, '{a:1}')
    expect(keysText()).toBe('{a:1}')
    expect(document.querySelectorAll('[role="dialog"] ul select')).toHaveLength(1)
    await typeInto(keys, '{ a: 1, b: -1 }')
    await typeInto(keys, '{ a: 1, b: 1 }')
    expect(byLabel<HTMLSelectElement>('Field 2 type').value).toBe('1')
    await typeInto(byLabel('Field 1'), 'c')
    expect(keysText()).toBe('{ c: 1, b: 1 }')
  })

  it('flags a field named twice, and moves a field up or down', async () => {
    const { calls } = await mountIndexes()
    button('Create index').click()
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull())
    await typeInto(byLabel<HTMLTextAreaElement>('Keys'), '{ a: 1, b: -1 }')
    document.querySelector<HTMLButtonElement>('button[aria-label="Move field 2 up"]')!.click()
    await flushPromises()
    expect(keysText()).toBe('{ b: -1, a: 1 }')
    await typeInto(byLabel('Field 2'), 'b')
    expect(document.body.textContent).toContain('This field is already in the key.')
    // What would be created is what the rows show: nothing, until the field named twice is fixed.
    button('Create').click()
    await flushPromises()
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    expect(calls.some((c) => c.method === 'POST')).toBe(false)
    // It says why, and takes the keyboard to the field named twice (review of R3, minor 1).
    expect(document.body.textContent).toContain('A field is named twice in the key.')
    expect(document.activeElement).toBe(byLabel('Field 2'))
    // Fixed, the text follows and the index is created.
    await typeInto(byLabel('Field 2'), 'c')
    expect(keysText()).toBe('{ b: -1, c: 1 }')
    button('Create').click()
    await flushPromises()
    expect(calls.some((c) => c.method === 'POST')).toBe(true)
  })

  // Review of R3 (I-1): moving a field keeps the keyboard with it and says where it went.
  it('keeps focus on the field it moved and says where it went', async () => {
    await openCreate()
    await typeInto(byLabel<HTMLTextAreaElement>('Keys'), '{ a: 1, b: -1, c: 1 }')
    const up = (n: number) =>
      document.querySelector<HTMLButtonElement>(`button[aria-label="Move field ${n} up"]`)!
    up(3).focus()
    up(3).click()
    await flushPromises()
    expect(keysText()).toBe('{ a: 1, c: 1, b: -1 }')
    // The moved field is now field 2: its own "up" button has the focus.
    expect(document.activeElement).toBe(up(2))
    expect(document.querySelector('[aria-live="polite"]')!.textContent).toContain(
      'Field c moved to position 2',
    )
    up(2).click()
    await flushPromises()
    expect(keysText()).toBe('{ c: 1, a: 1, b: -1 }')
    // First now: its up button is disabled, so focus goes to its down button.
    expect(document.activeElement).toBe(
      document.querySelector<HTMLButtonElement>('button[aria-label="Move field 1 down"]'),
    )
  })

  it('keeps the rarer options folded until one is needed', async () => {
    await openCreate()
    const more = button('More options')
    expect(more.getAttribute('aria-expanded')).toBe('false')
    await typeInto(byLabel('Field 1'), 'a')
    await typeInto(byLabel('Delete documents after (seconds)'), '-5')
    button('Create').click()
    await flushPromises()
    expect(more.getAttribute('aria-expanded')).toBe('true')
    expect(document.body.textContent).toContain('Enter a whole number of seconds (0 or more).')
  })
})

describe('key rows', () => {
  it('turn into shell text and back, leaving out unfinished rows', () => {
    expect(
      rowsToText([
        { field: 'a', kind: '1' },
        { field: '', kind: '-1' },
        { field: 'x-y', kind: '2dsphere' },
      ]),
    ).toBe(`{ a: 1, "x-y": '2dsphere' }`)
    expect(textToRows("{ a: -1, t: 'text' }")).toEqual([
      { field: 'a', kind: '-1' },
      { field: 't', kind: 'text' },
    ])
    expect(textToRows('')).toEqual([])
    expect(textToRows('{ a: 2 }')).toBeNull()
    expect(textToRows('{ a: ')).toBeNull()
  })
})

// Review of R3–R5, minor 7: two key builders on the page (one closing as another opens) each move
// the focus in their own rows, though their rows are numbered alike.
describe('two key builders at once', () => {
  it('keeps the focus in the builder whose field moved', async () => {
    mockApi({})
    const target = { connectionId: 'c1', db: 'shop', coll: 'orders' }
    mountApp(IndexCreateDialog, { props: { target, initialKey: '{ a: 1, b: 1, c: 1 }' } })
    mountApp(IndexCreateDialog, { props: { target, initialKey: '{ x: 1, y: 1, z: 1 }' } })
    await flushPromises()
    const ups = [...document.querySelectorAll<HTMLButtonElement>('button[aria-label="Move field 3 up"]')]
    expect(ups).toHaveLength(2)
    const second = ups[1]!.closest('[role="dialog"]')!
    ups[1]!.focus()
    ups[1]!.click()
    await flushPromises()
    expect(second.contains(document.activeElement)).toBe(true)
  })
})
