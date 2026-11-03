// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AskError, type Accent, type PluginClient, type PluginContext } from '../../kit/src/client'
import { mount } from '../src/view'

const flush = () => new Promise((r) => setTimeout(r, 0))

/** A plugin client answering from `handlers`; `greet` plays the app's greeting. */
/** What a bridge call carries here: a pipeline, or nothing the test reads. */
type Params = { pipeline: Array<Record<string, unknown>> }

function fakeClient(place: PluginContext['place'], handlers: Record<string, (params: Params) => unknown>) {
  const calls: Array<{ method: string; params: Params }> = []
  let ready: (() => void) | null = null
  let aggregating = false
  const contexts: Array<(l: string, t: 'light' | 'dark', a: Accent) => void> = []
  const client: PluginClient = {
    contribution: { kind: 'collectionTab', id: 'search' },
    ask: async <T>(method: string, params?: unknown) => {
      calls.push({ method, params: params as Params })
      if (method === 'context.get')
        return {
          plugin: { id: 'value-search', version: '1' },
          contribution: { kind: 'collectionTab', id: 'search' },
          locale: 'en',
          theme: 'light',
          accent: 'ocean',
          // A copy, as a message carries it: what the page keeps does not change under it.
          place: structuredClone(place),
          settings: {},
        } as T
      // As the app does: one pipeline of a frame at a time, the next refused (review 2026-10-10).
      if (method === 'documents.aggregate') {
        if (aggregating) throw new AskError('busy', 'Its last pipeline is still running')
        aggregating = true
        try {
          return (await handlers[method]!(params as Params)) as T
        } finally {
          aggregating = false
        }
      }
      return (await handlers[method]!(params as Params)) as T
    },
    onReady: (fn) => (ready = fn),
    onContext: (fn) => contexts.push(fn),
    onCells: () => {},
  }
  return { client, calls, greet: () => ready!(), contexts }
}

const PLACE = { connectionId: 'c', connectionName: 'Shop', db: 'shop', coll: 'orders', documentId: null }
const ORDERS = [
  {
    _id: { $oid: '65a1b2c3d4e5f60718293a01' },
    orderNo: 1,
    city: 'Ankara',
    note: 'ankara depot',
    status: 'paid',
  },
  {
    _id: { $oid: '65a1b2c3d4e5f60718293a02' },
    orderNo: 2,
    city: 'Ankara',
    status: '<img src=x onerror=alert(1)>',
  },
]
const app = () => document.getElementById('app')!
const term = () => document.getElementById('term') as HTMLInputElement
const find = () => document.getElementById('find') as HTMLButtonElement
const searchFor = async (value: string) => {
  term().value = value
  find().click()
  await flush()
  await flush()
}
const matches = (calls: Array<{ method: string; params: Params }>) =>
  calls
    .filter((c) => c.method === 'documents.aggregate' && c.params.pipeline[0]!.$match)
    .map((c) => c.params.pipeline[0]!.$match)

beforeEach(() => {
  document.body.replaceChildren(Object.assign(document.createElement('div'), { id: 'app' }))
})

describe('value search, redesigned (plugin tabs redesign §2.1)', () => {
  it('waits for the fields before searching, rather than saying none was found', async () => {
    let giveSample!: (v: unknown) => void
    const { client, greet } = fakeClient(PLACE, {
      'documents.aggregate': (p) =>
        p.pipeline[0]!.$sample ? new Promise((r) => (giveSample = r)) : { documents: ORDERS },
    })
    mount(app(), client)
    greet()
    await flush()
    expect(find().textContent).toBe('Reading the fields…')
    await searchFor('ankara')
    expect(app().textContent).not.toContain('No field was found')
    giveSample({ documents: ORDERS })
    await flush()
    await flush()
    expect(document.getElementById('status')!.textContent).toContain('2 documents')
    expect(find().textContent).toBe('Search')
  })

  it('looks in the whole collection by default, in the Documents filter when chosen', async () => {
    const { client, greet, calls } = fakeClient(
      { ...PLACE, filter: { status: 'paid' } },
      { 'documents.aggregate': () => ({ documents: ORDERS }) },
    )
    mount(app(), client)
    greet()
    await flush()
    await searchFor('ankara')
    expect(JSON.stringify(matches(calls).at(-1))).not.toContain('"status":"paid"')
    const scope = document.getElementById('scope')!
    expect(scope.hidden).toBeFalsy()
    ;[...scope.querySelectorAll('button')].find((b) => b.textContent === 'Documents filter')!.click()
    await flush()
    await flush()
    expect(matches(calls).at(-1)).toMatchObject({ $and: [{ status: 'paid' }, {}] })
  })

  it('hides the scope where Documents has no filter', async () => {
    const { client, greet } = fakeClient(PLACE, { 'documents.aggregate': () => ({ documents: [] }) })
    mount(app(), client)
    greet()
    await flush()
    expect(document.getElementById('scope')!.parentElement!.hidden).toBe(true)
  })

  // User report 2026-10-16: opening a result filters Documents to that document's _id; coming back,
  // the search offered that one-document filter as "Documents filter".
  it('takes a filter naming one document by its _id for no filter (what opening a result leaves)', async () => {
    const { client, greet } = fakeClient(
      { ...PLACE, filter: { _id: { $oid: '65a1b2c3d4e5f60718293a01' } } },
      { 'documents.aggregate': () => ({ documents: [] }) },
    )
    mount(app(), client)
    greet()
    await flush()
    expect(document.getElementById('scope')!.parentElement!.hidden).toBe(true)
  })

  it('keeps an _id filter that is a condition, not one document', async () => {
    const { client, greet } = fakeClient(
      { ...PLACE, filter: { _id: { $gt: { $oid: '65a1b2c3d4e5f60718293a01' } } } },
      { 'documents.aggregate': () => ({ documents: [] }) },
    )
    mount(app(), client)
    greet()
    await flush()
    expect(document.getElementById('scope')!.parentElement!.hidden).toBe(false)
  })

  // User report 2026-10-16: the app keeps the page while Documents shows a result; the search and its
  // results stay, and the filter is read again when the app says it changed.
  it('reads the Documents filter again when the app says the context changed, keeping its results', async () => {
    const place = { ...PLACE, filter: {} as Record<string, unknown> }
    const { client, greet, contexts, calls } = fakeClient(place, {
      'documents.aggregate': () => ({ documents: ORDERS }),
    })
    mount(app(), client)
    greet()
    await flush()
    await searchFor('ankara')
    const scopeRow = () => document.getElementById('scope')!.parentElement!
    expect(scopeRow().hidden).toBe(true)
    place.filter = { status: 'paid' }
    contexts[0]!('en', 'light', 'ocean')
    await flush()
    expect(scopeRow().hidden).toBe(false)
    expect(document.getElementById('filter')!.textContent).toBe('{"status":"paid"}')
    expect(document.getElementById('status')!.textContent).toContain('2 documents')
    // Searched in the filter; then the filter becomes one document (a result opened): the next search
    // looks in the whole collection, and what was found stays, said to be from the earlier filter —
    // nothing is searched again unasked (review of 2026-10-16, I2).
    ;[...document.querySelectorAll<HTMLButtonElement>('#scope button')]
      .find((b) => b.textContent === 'Documents filter')!
      .click()
    await flush()
    await flush()
    expect(document.getElementById('status')!.textContent).toBe(
      '2 documents · 5 fields · within the Documents filter',
    )
    const searches = matches(calls).length
    term().value = 'typed, not searched'
    place.filter = { _id: { $oid: '65a1b2c3d4e5f60718293a01' } }
    contexts[0]!('en', 'light', 'ocean')
    await flush()
    expect(scopeRow().hidden).toBe(true)
    expect(document.querySelector('#scope button[aria-checked="true"]')!.textContent).toBe('Whole collection')
    expect(matches(calls)).toHaveLength(searches)
    expect(document.getElementById('status')!.textContent).toBe(
      '2 documents · 5 fields · within an earlier Documents filter',
    )
    await searchFor('ankara')
    expect(JSON.stringify(matches(calls).at(-1))).not.toContain('"status":"paid"')
  })

  it('asks the app to keep its page while another section shows', async () => {
    const { client, greet, calls } = fakeClient(PLACE, { 'documents.aggregate': () => ({ documents: [] }) })
    mount(app(), client)
    greet()
    await flush()
    expect(calls.some((c) => c.method === 'ui.keepOpen')).toBe(true)
  })

  it('says what is searched by the scope chosen, before the first search', async () => {
    const { client, greet } = fakeClient(
      { ...PLACE, filter: { status: 'paid' } },
      { 'documents.aggregate': () => ({ documents: ORDERS }) },
    )
    mount(app(), client)
    greet()
    await flush()
    await flush()
    ;[...document.querySelectorAll<HTMLButtonElement>('#scope button')]
      .find((b) => b.textContent === 'Documents filter')!
      .click()
    await flush()
    expect(app().textContent).toContain(
      'Type what you are looking for; the documents the Documents filter keeps are searched, in all 5 fields.',
    )
  })

  it('says the whole collection is searched, its fields read from a sample', async () => {
    const { client, greet } = fakeClient(PLACE, { 'documents.aggregate': () => ({ documents: ORDERS }) })
    mount(app(), client)
    greet()
    await flush()
    await flush()
    expect(app().textContent).toContain(
      'Type what you are looking for; every document of the collection is searched, in all 5 fields.',
    )
    expect(app().textContent).toContain('The fields are read from a sample of 200 documents.')
  })

  it('says which document each hit is, and narrows the list by the field that matched', async () => {
    const { client, greet } = fakeClient(PLACE, { 'documents.aggregate': () => ({ documents: ORDERS }) })
    mount(app(), client)
    greet()
    await flush()
    await searchFor('ankara')
    const rows = () => [...document.querySelectorAll('.vs-row')]
    expect(rows()).toHaveLength(2)
    expect(rows()[0]!.textContent).toContain('orderNo')
    expect(rows()[0]!.querySelector('mark')!.textContent).toBe('Ankara')
    const facets = [...document.querySelectorAll('#facets button')]
    expect(facets.map((f) => f.textContent)).toEqual(['All fields', 'city2', 'note1'])
    ;(facets[2] as HTMLButtonElement).click()
    expect(rows()).toHaveLength(1)
    expect(facets[2]!.getAttribute('aria-pressed')).toBe('false')
    expect(document.querySelector('#facets button[aria-pressed="true"]')!.textContent).toBe('note1')
  })

  it('shows a value as text, never as markup', async () => {
    const { client, greet } = fakeClient(PLACE, { 'documents.aggregate': () => ({ documents: ORDERS }) })
    mount(app(), client)
    greet()
    await flush()
    await searchFor('ankara')
    expect(document.querySelector('img')).toBeNull()
    expect(app().textContent).toContain('<img src=x onerror=alert(1)>')
  })

  it('puts the search in Documents, only the chosen field when one is', async () => {
    const used = vi.fn(() => true)
    const { client, greet } = fakeClient(PLACE, {
      'documents.aggregate': () => ({ documents: ORDERS }),
      'ui.useQuery': used,
    })
    mount(app(), client)
    greet()
    await flush()
    await searchFor('ankara')
    ;[...document.querySelectorAll<HTMLButtonElement>('#facets button')]
      .find((b) => b.textContent === 'note1')!
      .click()
    document.getElementById('show')!.click()
    await flush()
    expect(used).toHaveBeenCalledWith({
      filter: { $or: [{ note: { $regularExpression: { pattern: 'ankara', options: 'i' } } }] },
    })
  })

  it('says why nothing was found, and offers the whole collection from the filter', async () => {
    const { client, greet, calls } = fakeClient(
      { ...PLACE, filter: { status: 'new' } },
      { 'documents.aggregate': (p) => ({ documents: p.pipeline[0]!.$sample ? ORDERS : [] }) },
    )
    mount(app(), client)
    greet()
    await flush()
    ;[...document.querySelectorAll<HTMLButtonElement>('#scope button')]
      .find((b) => b.textContent === 'Documents filter')!
      .click()
    await searchFor('izmir')
    expect(app().textContent).toContain('Nothing found')
    const whole = [...document.querySelectorAll<HTMLButtonElement>('.mm-empty button')].find(
      (b) => b.textContent === 'Search the whole collection',
    )!
    whole.click()
    await flush()
    await flush()
    expect(JSON.stringify(matches(calls).at(-1))).not.toContain('"status":"new"')
    expect(document.querySelector('#scope button[aria-checked="true"]')!.textContent).toBe('Whole collection')
  })

  // Re-review of 2026-10-16, minor 2: "nothing found" says so of an earlier filter too.
  it('says nothing was found in an earlier filter once the filter has changed', async () => {
    const place = { ...PLACE, filter: { status: 'new' } as Record<string, unknown> }
    const { client, greet, contexts } = fakeClient(place, {
      'documents.aggregate': (p) => ({ documents: p.pipeline[0]!.$sample ? ORDERS : [] }),
    })
    mount(app(), client)
    greet()
    await flush()
    ;[...document.querySelectorAll<HTMLButtonElement>('#scope button')]
      .find((b) => b.textContent === 'Documents filter')!
      .click()
    await searchFor('izmir')
    expect(app().textContent).toContain('Looked in 5 fields of the documents the Documents filter keeps.')
    place.filter = { status: 'paid' }
    contexts[0]!('en', 'light', 'ocean')
    await flush()
    expect(app().textContent).toContain(
      'Looked in 5 fields of the documents an earlier Documents filter kept.',
    )
  })

  it('says in Turkish what the Documents filter scope searches', async () => {
    const { client, greet, contexts } = fakeClient(
      { ...PLACE, filter: { status: 'paid' } },
      { 'documents.aggregate': () => ({ documents: ORDERS }) },
    )
    mount(app(), client)
    greet()
    await flush()
    await flush()
    ;[...document.querySelectorAll<HTMLButtonElement>('#scope button')]
      .find((b) => b.textContent === 'Documents filter')!
      .click()
    contexts[0]!('tr', 'light', 'ocean')
    await flush()
    expect(app().textContent).toContain(
      'Aradığınızı yazın; Belgeler filtresine uyan belgelerde, 5 alanın hepsinde aranır.',
    )
  })

  it('follows the app’s language and accent', async () => {
    const { client, greet, contexts } = fakeClient(PLACE, {
      'documents.aggregate': () => ({ documents: ORDERS }),
    })
    mount(app(), client)
    greet()
    await flush()
    expect(document.documentElement.dataset.accent).toBe('ocean')
    contexts[0]!('tr', 'dark', 'rose')
    expect(document.documentElement.dataset.accent).toBe('rose')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(document.querySelector('h1')!.textContent).toBe('Değer arama')
  })

  it('says to open a collection where there is none', async () => {
    const { client, greet } = fakeClient(null, {})
    mount(app(), client)
    greet()
    await flush()
    expect(app().textContent).toContain('Open a collection to search it.')
    expect(find().disabled).toBe(true)
  })
})

describe('value search, reviewed (2026-10-10)', () => {
  it('never asks a second pipeline while one runs: searching twice gives one answer, no "busy"', async () => {
    const answers: Array<() => void> = []
    const { client, greet } = fakeClient(PLACE, {
      'documents.aggregate': (p) =>
        p.pipeline[0]!.$sample
          ? { documents: ORDERS }
          : new Promise((r) => answers.push(() => r({ documents: ORDERS }))),
    })
    mount(app(), client)
    greet()
    await flush()
    await flush()
    term().value = 'ankara'
    // Enter twice in the search box while the first search is with the server (the button is
    // disabled while it runs; the box is not).
    const enter = () => term().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    enter()
    await flush()
    enter()
    await flush()
    while (answers.length) {
      answers.shift()!()
      await flush()
      await flush()
    }
    expect(app().textContent).not.toContain('An earlier request is still waiting')
    expect(document.getElementById('status')!.textContent).toContain('2 documents')
  })

  it('marks the letters that matched in Turkish text, whose lower case is longer', async () => {
    const { client, greet } = fakeClient(PLACE, {
      'documents.aggregate': () => ({ documents: [{ _id: 1, city: 'İSTANBUL' }] }),
    })
    mount(app(), client)
    greet()
    await flush()
    await searchFor('stan')
    expect(document.querySelector('.vs-row mark')!.textContent).toBe('STAN')
  })

  it('keeps a search running, or its failure, across a language change', async () => {
    let answer!: (v: unknown) => void
    let fail = false
    const { client, greet, contexts } = fakeClient(PLACE, {
      'documents.aggregate': (p) => {
        if (p.pipeline[0]!.$sample) return { documents: ORDERS }
        if (fail) throw new AskError('timeout', 'No answer')
        return new Promise((r) => (answer = r))
      },
    })
    mount(app(), client)
    greet()
    await flush()
    await searchFor('ankara')
    contexts[0]!('tr', 'light', 'emerald')
    expect(document.querySelector('.mm-skeleton')).not.toBeNull()
    answer({ documents: ORDERS })
    await flush()
    await flush()
    expect(document.getElementById('status')!.textContent).toContain('2 belge')
    fail = true
    await searchFor('izmir')
    const failed = app().textContent!
    expect(failed).toContain('Arama yapılamadı')
    contexts[0]!('en', 'light', 'emerald')
    expect(app().textContent).toContain('The search could not run')
    expect(app().textContent).not.toContain('Search every field at once')
  })

  it('says "+" only when more than the hundred shown matched', async () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ _id: i, city: 'Ankara' }))
    let count = 100
    const { client, greet, calls } = fakeClient(PLACE, {
      'documents.aggregate': (p) => ({ documents: p.pipeline[0]!.$sample ? ORDERS : many(count) }),
    })
    mount(app(), client)
    greet()
    await flush()
    await searchFor('ankara')
    expect(document.getElementById('status')!.textContent).toContain('100 documents')
    expect(document.getElementById('status')!.textContent).not.toContain('100+')
    expect(matches(calls).length).toBe(1)
    const last = calls.filter((c) => c.method === 'documents.aggregate').at(-1)!.params
    expect(last.pipeline[1]).toEqual({ $limit: { $numberInt: '101' } })
    count = 101
    await searchFor('ankara')
    expect(document.getElementById('status')!.textContent).toContain('100+ documents')
    expect(document.querySelectorAll('.vs-row')).toHaveLength(100)
  })
})
