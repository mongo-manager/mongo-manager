// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { AskError } from '../../kit/src/client'
import { answerOf, apiLog, fakeClient, flush } from '../../kit/test/fakeClient'
import { formatNumber, pick, pluralOf, shown } from '../../kit/src/ui'
import { mount, TEXT } from '../src/view'
import type { SearchIndexList } from '../src/search'

/** Plugins wave 4 (spec §5): the search tab — full text and vectors on the collection's indexes. */
const PLACE = {
  connectionId: 'c',
  connectionName: 'Shop',
  db: 'films',
  coll: 'movies',
  documentId: null,
  hidden: [],
}
const LIST: SearchIndexList = {
  supported: true,
  indexes: [
    {
      name: 'default',
      type: 'search',
      status: 'READY',
      queryable: true,
      dynamic: false,
      fields: [
        { path: 'title', type: 'string' },
        { path: 'plot', type: 'string' },
      ],
    },
    {
      name: 'vec',
      type: 'vectorSearch',
      status: 'READY',
      queryable: true,
      dynamic: false,
      fields: [{ path: 'embedding', type: 'vector', numDimensions: 3, similarity: 'cosine' }],
    },
    { name: 'building', type: 'search', status: 'BUILDING', queryable: false, dynamic: true, fields: [] },
  ],
}
const FOUND = [
  {
    _id: { $oid: '65a1b2c3d4e5f60718293a01' },
    title: 'The Ring',
    _score: { $numberDouble: '2.5' },
    _highlights: [
      {
        path: 'title',
        texts: [
          { value: 'The ', type: 'text' },
          { value: '<b>Ring', type: 'hit' },
        ],
      },
    ],
  },
]
const SAMPLES = [
  {
    _id: { $oid: '65a1b2c3d4e5f60718293a01' },
    title: 'One',
    embedding: [{ $numberDouble: '0.1' }, 0.2, 0.3],
  },
  { _id: { $oid: '65a1b2c3d4e5f60718293a02' }, title: 'Two', embedding: [0.4, 0.5, 0.6] },
]

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>'
})
const app = () => document.getElementById('app')!
const text = () => app().textContent ?? ''
const $ = <T extends HTMLElement>(sel: string) => app().querySelector<T>(sel)!
const set = (id: string, value: string, event = 'input') => {
  const el = $<HTMLInputElement>(`#${id}`)
  el.value = value
  el.dispatchEvent(new Event(event))
}
const click = async (id: string) => {
  $<HTMLButtonElement>(`#${id}`).click()
  await flush()
}
const aggregations = (calls: Array<{ method: string; params: Record<string, unknown> }>) =>
  calls.filter((c) => c.method === 'documents.aggregate').map((c) => c.params)

async function opened(handlers: Record<string, (p: Record<string, unknown>) => unknown> = {}) {
  const fake = fakeClient(
    { place: PLACE },
    {
      'searchIndexes.list': () => structuredClone(LIST),
      'documents.aggregate': () => ({ documents: FOUND, truncated: false }),
      'documents.find': () => ({ documents: SAMPLES }),
      'ui.useAggregation': () => true,
      ...handlers,
    },
  )
  mount(app(), fake.client)
  fake.greet()
  await flush()
  return fake
}

describe('the indexes', () => {
  it('are listed with their state, one not queryable marked and not run', async () => {
    await opened()
    const options = [...app().querySelectorAll<HTMLOptionElement>('#index option')]
    expect(options.map((o) => o.value)).toEqual(['default', 'vec', 'building'])
    expect(options[2]!.textContent).toContain('BUILDING')
    set('index', 'building', 'change')
    await flush()
    expect($<HTMLButtonElement>('#run').disabled).toBe(true)
    expect(text()).toContain('not queryable yet')
  })

  it('says when search is not there, or the collection has no search index', async () => {
    await opened({ 'searchIndexes.list': () => ({ supported: false, reason: 'not_enabled', indexes: [] }) })
    expect(text()).toContain('mongot')
    document.body.innerHTML = '<div id="app"></div>'
    await opened({ 'searchIndexes.list': () => ({ supported: true, indexes: [] }) })
    expect(text()).toContain('No search index')
  })
})

describe('a full-text search', () => {
  it('runs $search first, and shows each result’s score and highlights as text', async () => {
    const { calls } = await opened()
    set('query', 'ring')
    set('path', 'title', 'change')
    set('fuzzy', '1', 'change')
    await click('run')
    expect(aggregations(calls)).toEqual([
      {
        pipeline: [
          {
            $search: {
              index: 'default',
              text: { query: 'ring', path: 'title', fuzzy: { maxEdits: 1 } },
              highlight: { path: 'title' },
            },
          },
          { $limit: 20 },
          { $set: { _score: { $meta: 'searchScore' }, _highlights: { $meta: 'searchHighlights' } } },
        ],
        limit: 20,
        fit: true,
      },
    ])
    const result = $('[data-result]')
    expect(result.textContent).toContain('2.5')
    expect(result.querySelector('mark')!.textContent).toBe('<b>Ring')
    expect(result.querySelector('b')).toBeNull()
    expect(result.textContent).toContain('The Ring')
  })

  // User report 2026-11-07: API logs of ~60 KB a document — 20 results are over what one answer may
  // be. The results that fit are shown, and it says the rest were left out.
  it('shows the results that fit in one answer when they are large, and says so', async () => {
    const logs = Array.from({ length: 20 }, (_, i) => ({ ...apiLog(i), _score: { $numberDouble: '1.5' } }))
    const { calls } = await opened({ 'documents.aggregate': (p) => answerOf(logs, p, 'aggregate') })
    set('query', 'orders')
    await click('run')
    expect(aggregations(calls)[0]).toMatchObject({ limit: 20, fit: true })
    const shownResults = app().querySelectorAll('[data-result]').length
    expect(shownResults).toBeGreaterThan(10)
    expect(shownResults).toBeLessThan(20)
    expect(text()).toContain('only those that fit in one answer')
    expect(text()).not.toMatch(/too large to send/i)
  })

  it('searches every field of the index without highlights when asked so', async () => {
    const { calls } = await opened()
    set('query', 'x')
    $<HTMLInputElement>('#highlight').click()
    await click('run')
    const search = (aggregations(calls)[0]!.pipeline as Array<Record<string, unknown>>)[0]!.$search
    expect(search).toEqual({ index: 'default', text: { query: 'x', path: ['plot', 'title'] } })
  })

  it('asks for something to search for, and says why MongoDB refused', async () => {
    const { calls } = await opened({
      'documents.aggregate': () => {
        throw new AskError('failed', 'PlanExecutor error: index not found')
      },
    })
    await click('run')
    expect($('#form-error').textContent).toContain('what to search for')
    expect(aggregations(calls)).toHaveLength(0)
    set('query', 'x')
    await click('run')
    expect($('#status').textContent).toContain('index not found')
  })
})

describe('a vector search', () => {
  const vectorMode = async () => {
    set('index', 'vec', 'change')
    await flush()
  }

  it('runs a pasted vector, its dimensions checked first', async () => {
    const { calls } = await opened()
    await vectorMode()
    set('vector', '[0.1, 0.2]')
    await click('run')
    expect($('#form-error').textContent).toContain('3 dimensions')
    expect(aggregations(calls)).toHaveLength(0)
    set('vector', '0.1, 0.2, 0.3')
    set('filter', '{ "year": { "$gte": 2000 } }')
    await click('run')
    expect(aggregations(calls)[0]).toEqual({
      pipeline: [
        {
          $vectorSearch: {
            index: 'vec',
            path: 'embedding',
            queryVector: [0.1, 0.2, 0.3],
            numCandidates: 200,
            limit: 20,
            filter: { year: { $gte: 2000 } },
          },
        },
        { $set: { _score: { $meta: 'vectorSearchScore' } } },
      ],
      limit: 20,
      fit: true,
    })
  })

  it('finds documents similar to one of the collection’s', async () => {
    const { calls } = await opened()
    await vectorMode()
    $<HTMLButtonElement>('[data-value="document"]').click()
    await flush()
    expect(calls.filter((c) => c.method === 'documents.find')).toHaveLength(1)
    set('from-doc', '1', 'change')
    await click('run')
    const stage = (aggregations(calls)[0]!.pipeline as Array<Record<string, { queryVector: unknown }>>)[0]!
    expect(stage.$vectorSearch!.queryVector).toEqual([0.4, 0.5, 0.6])
  })

  it('offers documents of large ones to search like, as many as fit', async () => {
    const logs = Array.from({ length: 20 }, (_, i) => ({ ...apiLog(i), embedding: [0.1, 0.2, 0.3] }))
    const { calls } = await opened({ 'documents.find': (p) => answerOf(logs, p) })
    await vectorMode()
    $<HTMLButtonElement>('[data-value="document"]').click()
    await flush()
    expect(calls.find((c) => c.method === 'documents.find')!.params).toMatchObject({ fit: true })
    expect(text()).not.toMatch(/too large to send/i)
    expect(app().querySelectorAll('#from-doc option').length).toBeGreaterThan(10)
  })

  it('refuses a filter that is not a JSON object', async () => {
    const { calls } = await opened()
    await vectorMode()
    set('vector', '0.1 0.2 0.3')
    set('filter', '{ nope')
    await click('run')
    expect($('#form-error').textContent).toContain('JSON object')
    expect(aggregations(calls)).toHaveLength(0)
  })
})

// Final review Minor 15.
describe('the review’s cases', () => {
  it('keeps the focus where the user is across a redraw', async () => {
    await opened()
    set('query', 'ring')
    const run = $<HTMLButtonElement>('#run')
    run.focus()
    run.click()
    await flush()
    expect(document.activeElement?.id).toBe('run')
    const index = $<HTMLSelectElement>('#index')
    index.focus()
    set('index', 'vec', 'change')
    await flush()
    expect(document.activeElement?.id).toBe('index')
  })

  it('says an index maps no text field, without asking MongoDB', async () => {
    const { calls } = await opened({
      'searchIndexes.list': () => ({
        supported: true,
        indexes: [
          {
            name: 'n',
            type: 'search',
            status: 'READY',
            queryable: true,
            dynamic: false,
            fields: [{ path: 'year', type: 'number' }],
          },
        ],
      }),
    })
    set('query', 'x')
    await click('run')
    expect($('#form-error').textContent).toContain('no text field')
    expect(aggregations(calls)).toHaveLength(0)
  })

  it('says up front a search is refused where personal data rules reach the user', async () => {
    const fake = fakeClient(
      { place: { ...PLACE, hidden: [['email']] } },
      { 'searchIndexes.list': () => structuredClone(LIST) },
    )
    mount(app(), fake.client)
    fake.greet()
    await flush()
    expect(text()).toMatch(/personal data rules/i)
  })

  it('finds documents like one holding a BSON vector', async () => {
    const f32 = new Uint8Array(new Float32Array([0.5, 1, -2]).buffer)
    const base64 = btoa(String.fromCharCode(0x27, 0, ...f32))
    const { calls } = await opened({
      'documents.find': () => ({
        documents: [
          { _id: { $oid: '65a1b2c3d4e5f60718293a01' }, embedding: { $binary: { base64, subType: '09' } } },
        ],
      }),
    })
    set('index', 'vec', 'change')
    await flush()
    $<HTMLButtonElement>('[data-value="document"]').click()
    await flush()
    await click('run')
    const stage = (aggregations(calls)[0]!.pipeline as Array<Record<string, { queryVector: unknown }>>)[0]!
    expect(stage.$vectorSearch!.queryVector).toEqual([0.5, 1, -2])
  })
})

describe('the pipeline', () => {
  it('is handed to Aggregations on a click', async () => {
    const { calls } = await opened()
    set('query', 'ring')
    await click('use')
    const handed = calls.find((c) => c.method === 'ui.useAggregation')!.params.stages as Array<
      Record<string, unknown>
    >
    expect(Object.keys(handed[0]!)).toEqual(['$search'])
  })
})

describe('the language', () => {
  it('follows the app', async () => {
    const { contexts } = await opened()
    contexts.forEach((fn) => fn('tr', 'light', 'emerald'))
    await flush()
    expect(text()).toContain('Arama')
    expect($('#run').textContent).toContain('Ara')
  })
})

describe('the languages', () => {
  const shape = (v: unknown): unknown =>
    typeof v === 'function'
      ? 'fn'
      : Array.isArray(v)
        ? v.map(shape)
        : v && typeof v === 'object'
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x)]))
          : 'str'

  it('every language has exactly the keys of English', () => {
    for (const lang of Object.keys(TEXT)) {
      expect(shape((TEXT as Record<string, unknown>)[lang]), lang).toEqual(shape(TEXT.en))
    }
    expect(Object.keys(TEXT).sort()).toEqual(['de', 'en', 'es', 'fr', 'ja', 'ko', 'pt', 'ru', 'tr', 'zh'])
  })

  // A label only that language produces (not shared with the others).
  it.each([
    ['zh', 'zh-CN', '搜索内容', '搜索'],
    ['ja', 'ja', '検索語', '検索'],
    ['es', 'es', 'Todos los campos', 'Buscar'],
    ['pt', 'pt-BR', 'Buscar por', 'Buscar'],
    ['ko', 'ko', '검색어', '검색'],
    ['de', 'de', 'Suchbegriff', 'Suchen'],
    ['fr', 'fr', 'Rechercher', 'Rechercher'],
    ['ru', 'ru', 'Что искать', 'Искать'],
  ])('shows %s', async (lang, tag, label, run) => {
    const { contexts } = await opened()
    contexts.forEach((fn) => fn(lang, 'light', 'emerald'))
    await flush()
    expect(text()).toContain(label)
    expect($('#run').textContent).toContain(run)
    expect(text()).not.toContain('Search for')
    expect(document.documentElement.lang).toBe(tag)
  })

  it('keeps the two Han-script languages apart', async () => {
    const { contexts } = await opened()
    contexts.forEach((fn) => fn('zh', 'light', 'emerald'))
    await flush()
    expect(text()).not.toContain('検索')
    contexts.forEach((fn) => fn('ja', 'light', 'emerald'))
    await flush()
    expect(text()).not.toContain('搜索')
  })

  it('falls back to English for an unknown locale, in words, page language and numbers', async () => {
    const { contexts } = await opened()
    set('query', 'ring')
    await click('run')
    contexts.forEach((fn) => fn('xx', 'light', 'emerald'))
    await flush()
    expect($('#run').textContent).toContain('Search')
    expect(document.documentElement.lang).toBe('en')
    expect(text()).toContain(`Score ${new Intl.NumberFormat('en', { maximumFractionDigits: 3 }).format(2.5)}`)
  })

  it('reads English from a table that lacks the locale, with English numbers', () => {
    const partial = { en: TEXT.en, tr: TEXT.tr }
    expect(shown(partial, 'de')).toBe('en')
    expect(pick<typeof TEXT.en>(partial, 'de')).toBe(TEXT.en)
    expect(shown(partial, 'tr')).toBe('tr')
    expect(formatNumber(12345, shown(partial, 'de'), 0)).toBe('12,345')
    expect(formatNumber(12345, 'de', 0)).toBe(
      new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 }).format(12345),
    )
  })

  it('writes every count right for each plural category', () => {
    const cases = [0, 1, 2, 5, 11, 21, 22]
    for (const lang of Object.keys(TEXT) as Array<keyof typeof TEXT>) {
      const t = TEXT[lang]
      const seen = new Map<string, string>()
      for (const n of cases) {
        const found = t.found(n)
        expect(found, `${lang} ${n}`).toContain(formatNumber(n, lang, 0))
        const category = pluralOf(n, lang)
        const word = found.replace(formatNumber(n, lang, 0), '')
        // The same category always reads the same word, a different category may differ.
        expect(seen.get(category) ?? word, `${lang} ${n}`).toBe(word)
        seen.set(category, word)
      }
    }
    expect(TEXT.en.found(1)).toBe('1 result')
    expect(TEXT.en.found(0)).toBe('0 results')
    expect(TEXT.en.more(1)).toBe('1 more field')
    expect(TEXT.es.more(1)).toBe('1 campo más')
    expect(TEXT.es.dimensions(1)).toContain('1 dimensión')
    expect(TEXT.pt.found(1)).toBe('1 resultado')
    expect(TEXT.pt.more(2)).toBe('mais 2 campos')
    expect(TEXT.fr.found(0)).toBe('0 résultat')
    expect(TEXT.fr.found(2)).toBe('2 résultats')
    expect(TEXT.fr.more(1)).toBe('1 champ de plus')
    expect(TEXT.de.found(1)).toBe('1 Ergebnis')
    expect(TEXT.de.more(1)).toBe('1 weiteres Feld')
    const ru = (n: number) => TEXT.ru.found(n)
    expect(ru(1)).toBe('1 результат')
    expect(ru(21)).toBe('21 результат')
    expect(ru(2)).toBe('2 результата')
    expect(ru(22)).toBe('22 результата')
    expect(ru(5)).toBe('5 результатов')
    expect(ru(11)).toBe('11 результатов')
    expect(ru(0)).toBe('0 результатов')
    expect(TEXT.ru.more(3)).toBe('еще 3 поля')
    expect(TEXT.ru.more(11)).toBe('еще 11 полей')
    expect(TEXT.ru.dimensions(1)).toContain('1 измерение')
    expect(TEXT.ru.dimensions(1536)).toContain('1 536'.replace(' ', formatNumber(1000, 'ru', 0).charAt(1)))
  })
})
