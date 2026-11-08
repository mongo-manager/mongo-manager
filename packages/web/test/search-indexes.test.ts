// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import SearchIndexesCard from '../src/indexes/SearchIndexesCard.vue'
import IndexesView from '../src/indexes/IndexesView.vue'
import DialogHost from '../src/ds/DsConfirmHost.vue'
import { i18n } from '../src/i18n'
import { useToastStore } from '../src/stores/toasts'
import { mockApi, mountApp, type Handler } from './support/app'
import { button, byLabel, choose, typeInto } from './support/dom'

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const BASE = 'connections/c1/databases/shop/collections/movies/search-indexes'
const target = { connectionId: 'c1', db: 'shop', coll: 'movies' }
const LIST = {
  supported: true,
  indexes: [
    {
      name: 'default',
      type: 'search',
      status: 'READY',
      queryable: true,
      definition: { mappings: { dynamic: true } },
    },
    {
      name: 'vector_index',
      type: 'vectorSearch',
      status: 'BUILDING',
      queryable: false,
      definition: {
        fields: [
          {
            type: 'vector',
            path: 'plot_embedding',
            numDimensions: { $numberInt: '1536' },
            similarity: 'cosine',
          },
          { type: 'filter', path: 'year' },
        ],
      },
    },
    {
      name: 'broken',
      type: 'search',
      status: 'FAILED',
      queryable: false,
      message: 'mapping for "plot" is not valid',
      definition: { mappings: { dynamic: false } },
    },
  ],
}

async function mounted(handlers: Record<string, Handler> = {}, canManage = true) {
  const api = mockApi({ [`GET ${BASE}`]: () => [200, LIST], ...handlers })
  mountApp(SearchIndexesCard, { props: { target, canManage } })
  mountApp(DialogHost)
  await flushPromises()
  return api
}
const row = (name: string) =>
  [...document.querySelectorAll('tbody tr')].find((r) => r.textContent?.includes(name))!
async function rowAction(name: string, label: string) {
  ;(row(name).querySelector(`button[aria-label="Actions for ${name}"]`) as HTMLButtonElement).click()
  await flushPromises()
  ;[...document.querySelectorAll('[role="menuitem"]')]
    .find((i) => i.textContent?.trim() === label)!
    .dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await flushPromises()
}

/** W2.6 (2026-10-16): Atlas Search and Vector Search indexes in the Indexes tab. */
describe('search indexes card', () => {
  it('lists each index with its kind, status and what it covers', async () => {
    await mounted()
    expect(row('default').textContent).toContain('Search')
    expect(row('default').textContent).toContain('Ready')
    expect(row('vector_index').textContent).toContain('Vector search')
    expect(row('vector_index').textContent).toContain('Building')
    expect(row('vector_index').textContent).toContain('plot_embedding')
    expect(row('vector_index').textContent).toContain('1536')
    expect(row('broken').textContent).toContain('Failed')
    expect(row('broken').textContent).toContain('mapping for "plot" is not valid')
  })

  it('says what a server without search needs, and offers nothing to create', async () => {
    mockApi({ [`GET ${BASE}`]: () => [200, { supported: false, reason: 'not_enabled', indexes: [] }] })
    mountApp(SearchIndexesCard, { props: { target, canManage: true } })
    await flushPromises()
    const text = document.body.textContent!
    expect(text).toContain('MongoDB Atlas')
    expect(text).toContain('no search process (mongot) is set up')
    // User report 2026-11-05: "MongoDB 8.0 or later" read as missing on a server running 8.0.17,
    // and mongot no longer supports 8.0: no version that would go stale.
    expect(text).not.toMatch(/\d\.\d/)
    expect(() => button('Create search index')).toThrow()
  })

  it('creates a vector index from the guided form, as Atlas expects it', async () => {
    const { calls } = await mounted({ [`POST ${BASE}`]: () => [201, { name: 'vector_index' }] })
    button('Create search index').click()
    await flushPromises()
    await vi.waitFor(() => byLabel('Name'))
    ;[...document.querySelectorAll<HTMLElement>('[role="radio"]')]
      .find((r) => r.textContent?.trim() === 'Vector search')!
      .click()
    await flushPromises()
    await typeInto(byLabel('Name'), 'vec')
    await typeInto(byLabel('Vector field path'), 'emb')
    await typeInto(byLabel('Dimensions'), '3')
    await choose(byLabel<HTMLSelectElement>('Similarity'), 'dotProduct')
    button('Add a filter field').click()
    await flushPromises()
    await typeInto(byLabel('Filter field 1'), 'genre')
    button('Create').click()
    await flushPromises()
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({
      name: 'vec',
      type: 'vectorSearch',
      definition: {
        fields: [
          { type: 'vector', path: 'emb', numDimensions: { $numberInt: '3' }, similarity: 'dotProduct' },
          { type: 'filter', path: 'genre' },
        ],
      },
    })
    expect(useToastStore().toasts.at(-1)?.message).toContain('vec')
  })

  it('refuses a vector form that is not complete, without a request', async () => {
    const { calls } = await mounted()
    button('Create search index').click()
    await vi.waitFor(() => byLabel('Name'))
    ;[...document.querySelectorAll<HTMLElement>('[role="radio"]')]
      .find((r) => r.textContent?.trim() === 'Vector search')!
      .click()
    await flushPromises()
    await typeInto(byLabel('Dimensions'), '0')
    button('Create').click()
    await flushPromises()
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0)
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('Each field needs a path.')
  })

  // W2 review (minor 9): the form's own words, in the user's language, and the server's too.
  it('says what is missing in Turkish, and a refusal of the server in Turkish as well', async () => {
    i18n.global.locale.value = 'tr'
    const { calls } = await mounted({
      [`POST ${BASE}`]: () => [
        400,
        { code: 'VALIDATION_ERROR', message: 'similarity is …', details: { reason: 'vector_similarity' } },
      ],
    })
    button('Arama indeksi oluştur').click()
    await vi.waitFor(() => byLabel('Ad'))
    ;[...document.querySelectorAll<HTMLElement>('[role="radio"]')]
      .find((r) => r.textContent?.trim() === 'Vektör arama')!
      .click()
    await flushPromises()
    await typeInto(byLabel('Vektör alanının yolu'), 'emb')
    await typeInto(byLabel('Boyut sayısı'), '0')
    button('Oluştur').click()
    await flushPromises()
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0)
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain(
      '1 ile 8192 arasında bir tam sayı',
    )
    await typeInto(byLabel('Boyut sayısı'), '3')
    button('Oluştur').click()
    await flushPromises()
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('Benzerlik')
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain(
      'öklid, kosinüs ya da nokta çarpımı',
    )
  })

  it('creates a search index from its JSON definition, and refuses text that is no document', async () => {
    const { calls } = await mounted({ [`POST ${BASE}`]: () => [201, { name: 'default' }] })
    button('Create search index').click()
    await vi.waitFor(() => byLabel('Name'))
    await typeInto(byLabel('Name'), 'text')
    await typeInto(byLabel<HTMLTextAreaElement>('Definition'), '[1, 2]')
    button('Create').click()
    await flushPromises()
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0)
    await typeInto(
      byLabel<HTMLTextAreaElement>('Definition'),
      "{ mappings: { dynamic: false, fields: { title: { type: 'string' } } } }",
    )
    button('Create').click()
    await flushPromises()
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({
      name: 'text',
      type: 'search',
      definition: { mappings: { dynamic: false, fields: { title: { type: 'string' } } } },
    })
  })

  it('edits a definition and drops an index after a confirmation naming it', async () => {
    const { calls } = await mounted({
      [`PATCH ${BASE}/default`]: () => [200, { name: 'default' }],
      [`DELETE ${BASE}/broken`]: () => [204],
    })
    await rowAction('default', 'Edit definition')
    await vi.waitFor(() => byLabel<HTMLTextAreaElement>('Definition'))
    expect(byLabel<HTMLTextAreaElement>('Definition').value).toContain('dynamic: true')
    await typeInto(byLabel<HTMLTextAreaElement>('Definition'), '{ mappings: { dynamic: false } }')
    button('Save').click()
    await flushPromises()
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({
      definition: { mappings: { dynamic: false } },
    })
    await rowAction('broken', 'Drop index')
    expect(
      document.querySelector('[data-test="confirm"]')!.closest('[role="dialog"], [role="alertdialog"]')!
        .textContent,
    ).toContain('broken')
    ;(document.querySelector('[data-test="confirm"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(calls.some((c) => c.method === 'DELETE' && c.path === `${BASE}/broken`)).toBe(true)
  })

  it('shows the list to someone who may not change indexes, with no actions', async () => {
    await mounted({}, false)
    expect(row('default')).toBeTruthy()
    expect(() => button('Create search index')).toThrow()
    expect(row('default').querySelector('button[aria-label="Actions for default"]')).toBeNull()
  })

  it('is part of the Indexes tab, below the collection’s own indexes', async () => {
    mockApi({
      'GET connections/c1/databases/shop/collections/movies/indexes': () => [200, []],
      [`GET ${BASE}`]: () => [200, LIST],
    })
    mountApp(IndexesView, { props: { target, canManage: true } })
    await vi.waitFor(() => {
      if (!document.body.textContent!.includes('vector_index')) throw new Error('not yet')
    })
    const titles = [...document.querySelectorAll('h2, h3')].map((h) => h.textContent?.trim())
    expect(titles.indexOf('Search indexes')).toBeGreaterThan(titles.indexOf('Indexes'))
  })

  it('looks again while an index is building, and stops once none is', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let n = 0
    const { calls } = await mounted({
      [`GET ${BASE}`]: () => {
        n++
        return [200, n === 1 ? LIST : { supported: true, indexes: [LIST.indexes[0]] }]
      },
    })
    await vi.advanceTimersByTimeAsync(5_500)
    await flushPromises()
    await vi.advanceTimersByTimeAsync(11_000)
    await flushPromises()
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(2)
  })
})
