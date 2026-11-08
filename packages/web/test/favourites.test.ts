// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import QueryComposer from '../src/documents/QueryComposer.vue'
import SavedPipelinesMenu from '../src/aggregation/SavedPipelinesMenu.vue'
import { emptyDraft } from '../src/documents/queryBuild'
import { parseTags } from '../src/library/tags'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'
import { button } from './support/dom'

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const BASE = 'connections/c1/databases/shop/collections/orders'
const target = { connectionId: 'c1', db: 'shop', coll: 'orders' }
const favourite = (over: object = {}) => ({
  id: '6f8c2d7e-8a8b-4c1d-9e0f-1a2b3c4d5e6f',
  name: 'Big orders',
  tags: ['sales'],
  query: { filter: { total: { $numberInt: '5' } } },
  shared: true,
  mine: false,
  owner: 'ada',
  updatedAt: '2026-09-27T10:00:00.000Z',
  ...over,
})

const field = (label: string) => {
  const el = [...document.querySelectorAll('label')].find((l) => l.textContent?.trim() === label)!
  return document.getElementById(el.htmlFor) as HTMLInputElement | HTMLTextAreaElement
}
const type = async (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  el.value = value
  el.dispatchEvent(new Event('input'))
  await flushPromises()
}

describe('parseTags (phase 2c)', () => {
  it('splits on commas and spaces, trims, lower-cases and drops duplicates', () => {
    expect(parseTags('Hot, q3 hot')).toEqual({ tags: ['hot', 'q3'] })
    expect(parseTags('  ')).toEqual({ tags: [] })
  })
})

describe('favourites from the query bar (phase 2c spec §3)', () => {
  function mountBar(draft = { ...emptyDraft(), filter: '{ total: 5 }' }) {
    const model = { value: draft }
    return mountApp(QueryComposer, {
      props: {
        completions: [],
        target,
        modelValue: model.value,
        'onUpdate:modelValue': (v: typeof draft) => (model.value = v),
      },
    })
  }

  it('saves the query as a favourite with a name and tags', async () => {
    const { calls } = mockApi({
      [`POST ${BASE}/favourites`]: (body) => [201, { ...favourite(), ...(body as object), mine: true }],
    })
    mountBar()
    await flushPromises()
    document.querySelector<HTMLButtonElement>('button[aria-label="Save as favourite"]')!.click()
    await flushPromises()
    await type(field('Name'), 'Five')
    await type(field('Tags'), 'Hot, q3 hot')
    button('Save').click()
    await flushPromises()
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({
      name: 'Five',
      tags: ['hot', 'q3'],
      query: { filter: { total: { $numberInt: '5' } } },
      shared: false,
    })
  })

  it('is disabled while the query does not parse', async () => {
    mockApi({})
    mountBar({ ...emptyDraft(), filter: '{ total: ' })
    await flushPromises()
    expect(
      document.querySelector<HTMLButtonElement>('button[aria-label="Save as favourite"]')!.disabled,
    ).toBe(true)
  })

  it('lists the collection favourites above the recent queries, and a pick runs it', async () => {
    mockApi({
      [`GET ${BASE}/favourites`]: () => [200, { favourites: [favourite()] }],
      [`GET ${BASE}/recent-queries`]: () => [200, { queries: [{ query: { filter: { a: 1 } }, usedAt: 1 }] }],
      [`POST ${BASE}/find`]: () => [200, { documents: [], hasMore: false }],
    })
    const mounted = mountBar()
    await flushPromises()
    button('Recent queries').click()
    await flushPromises()
    const favs = document.querySelector('[data-favourites]')!
    expect(favs.textContent).toContain('Big orders')
    expect(favs.textContent).toContain('sales')
    expect(favs.textContent).toContain('Shared')
    favs.querySelector<HTMLButtonElement>('button')!.click()
    await flushPromises()
    const applied = mounted.wrapper.emitted('apply') as Array<[{ filter: unknown }]>
    expect(applied.at(-1)![0].filter).toEqual({ total: { $numberInt: '5' } })
  })
})

describe('tags on saved pipelines (phase 2c spec §3)', () => {
  it('shows the tags of each pipeline and filters by one', async () => {
    const pipeline = (id: string, name: string, tags: string[]) => ({
      id,
      name,
      tags,
      stages: [],
      shared: false,
      mine: true,
      owner: null,
      updatedAt: '2026-09-27T10:00:00.000Z',
    })
    mockApi({
      [`GET ${BASE}/pipelines`]: () => [
        200,
        {
          pipelines: [
            pipeline('11111111-1111-4111-8111-111111111111', 'Report', ['etl', 'sales']),
            pipeline('22222222-2222-4222-8222-222222222222', 'Cleanup', ['ops']),
          ],
        },
      ],
    })
    mountApp(SavedPipelinesMenu, { props: { target } })
    button('Pipelines').click()
    await flushPromises()
    const names = () =>
      [...document.querySelectorAll('[data-pipeline]')].map(
        (el) => el.querySelector('span span')!.textContent,
      )
    expect(names()).toEqual(['Report', 'Cleanup'])
    expect(document.querySelector('[data-pipeline]')!.textContent).toContain('etl')
    document.querySelector<HTMLButtonElement>('button[data-tag="ops"]')!.click()
    await flushPromises()
    expect(names()).toEqual(['Cleanup'])
  })
})
