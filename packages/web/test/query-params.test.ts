// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { LibraryItem } from '@mongo-manager/shared/browser'
import QueryComposer from '../src/documents/QueryComposer.vue'
import { buildQuery, emptyDraft, type QueryDraft } from '../src/documents/queryBuild'
import { openLibraryItem } from '../src/library/openItem'
import { useTabsStore } from '../src/stores/tabs'
import { useCollectionViewsStore } from '../src/stores/collectionViews'
import { useToastStore } from '../src/stores/toasts'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'
import { button } from './support/dom'

/** Query parameters (spec 2026-10-28-query-parameters-design.md) in the query bar and favourites. */
beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const draftOf = (over: Partial<QueryDraft>): QueryDraft => ({ ...emptyDraft(), ...over })
const M = (name: string) => ({ $$param: name })

describe('a query built with parameters', () => {
  it('fills the values in, keeping the template and the names for saving', () => {
    const built = buildQuery(
      draftOf({
        filter: '{ status: {{status}}, n: { $gte: {{min}} } }',
        sort: '{ n: 1 }',
        params: { status: 'open', min: '3', stale: 'x' },
      }),
    )
    expect(built).toMatchObject({
      ok: true,
      query: {
        filter: { status: 'open', n: { $gte: { $numberInt: '3' } } },
        sort: { n: { $numberInt: '1' } },
      },
      params: ['status', 'min'],
      template: { filter: { status: M('status'), n: { $gte: M('min') } }, sort: { n: { $numberInt: '1' } } },
    })
  })

  it('reads parameters in the projection, the sort, the collation and a hint key document too', () => {
    const built = buildQuery(
      draftOf({
        projection: '{ a: {{p}} }',
        collation: '{ locale: {{loc}} }',
        hint: '{ a: {{h}} }',
        params: { p: '1', loc: 'tr', h: '1' },
      }),
    )
    expect(built.ok && built.params).toEqual(['p', 'loc', 'h'])
    expect(built.ok && built.query.collation).toEqual({ locale: 'tr' })
  })

  it('says which parameters have no value, and builds nothing', () => {
    const built = buildQuery(draftOf({ filter: '{ a: {{a}}, b: {{b}} }', params: { a: ' ' } }))
    expect(built).toMatchObject({ ok: false, field: 'params', errors: { a: 'required', b: 'required' } })
  })

  it('has no template and no names without parameters', () => {
    const built = buildQuery(draftOf({ filter: '{ a: "{{a}}" }' }))
    expect(built).toMatchObject({ ok: true, params: [], query: { filter: { a: '{{a}}' } } })
    expect(built.ok && built.template).toBeUndefined()
  })
})

describe('the parameters row of the query bar', () => {
  function mountBar(draft: QueryDraft) {
    const model = { value: draft }
    const onApply = vi.fn()
    const wrapper = mountApp(QueryComposer, {
      props: {
        completions: [],
        target: { connectionId: 'c1', db: 'shop', coll: 'orders' },
        modelValue: model.value,
        'onUpdate:modelValue': (v: QueryDraft) => (model.value = v),
        onApply,
      },
    })
    return { wrapper, model, onApply }
  }
  const paramField = (name: string) =>
    document.querySelector<HTMLInputElement>(`[data-query-param="${name}"] input`)

  it('offers one field per parameter, in order, and runs the query filled in', async () => {
    const { model, onApply } = mountBar(draftOf({ filter: '{ s: {{status}}, n: {{n}} }' }))
    await flushPromises()
    const row = document.querySelector('[data-query-params]')!
    expect(row.getAttribute('aria-label')).toBe('Parameters')
    expect(
      [...row.querySelectorAll('[data-query-param]')].map((e) => e.getAttribute('data-query-param')),
    ).toEqual(['status', 'n'])
    for (const [name, value] of [
      ['status', 'paid'],
      ['n', '2'],
    ] as const) {
      const input = paramField(name)!
      input.value = value
      input.dispatchEvent(new Event('input'))
    }
    await flushPromises()
    expect(model.value.params).toEqual({ status: 'paid', n: '2' })
    button('Find').click()
    await flushPromises()
    expect(onApply).toHaveBeenCalledWith(
      expect.objectContaining({ filter: { s: 'paid', n: { $numberInt: '2' } } }),
    )
  })

  it('says a parameter needs a value, and runs nothing', async () => {
    const { onApply } = mountBar(draftOf({ filter: '{ s: {{status}} }' }))
    await flushPromises()
    button('Find').click()
    await flushPromises()
    expect(onApply).not.toHaveBeenCalled()
    expect(document.querySelector('[data-query-param="status"]')!.textContent).toContain(
      'Give {{status}} a value',
    )
    // Nothing else is said wrong: the options stay closed.
    expect([...document.querySelectorAll('label')].map((l) => l.textContent?.trim())).not.toContain('Project')
  })

  it('shows no row without parameters', async () => {
    mountBar(draftOf({ filter: '{ s: 1 }' }))
    await flushPromises()
    expect(document.querySelector('[data-query-params]')).toBeNull()
  })

  it('saves a favourite as the template, the values given as the defaults', async () => {
    const { calls } = mockApi({
      'POST connections/c1/databases/shop/collections/orders/favourites': (body) => [
        201,
        {
          id: '6f8c2d7e-8a8b-4c1d-9e0f-1a2b3c4d5e6f',
          tags: [],
          shared: false,
          mine: true,
          owner: null,
          updatedAt: '',
          ...(body as object),
        },
      ],
    })
    mountBar(draftOf({ filter: '{ s: {{status}}, n: {{n}} }', params: { status: 'paid', old: 'x' } }))
    await flushPromises()
    document.querySelector<HTMLButtonElement>('button[aria-label="Save as favourite"]')!.click()
    await flushPromises()
    const name = [...document.querySelectorAll('label')].find((l) => l.textContent?.trim() === 'Name')!
    const input = document.getElementById(name.htmlFor) as HTMLInputElement
    input.value = 'By status'
    input.dispatchEvent(new Event('input'))
    await flushPromises()
    button('Save').click()
    await flushPromises()
    const sent = calls.find((c) => c.method === 'POST')!.body as { name: string; query: unknown }
    expect(sent.name).toBe('By status')
    // Only the query's own parameters, and only those with a value, are its defaults.
    expect(sent.query).toEqual({ filter: { s: M('status'), n: M('n') }, params: { status: 'paid' } })
  })

  it('saves no default for an emptied field', async () => {
    const { calls } = mockApi({
      'POST connections/c1/databases/shop/collections/orders/favourites': (body) => [
        201,
        {
          id: '6f8c2d7e-8a8b-4c1d-9e0f-1a2b3c4d5e6f',
          tags: [],
          shared: false,
          mine: true,
          owner: null,
          updatedAt: '',
          ...(body as object),
        },
      ],
    })
    mountBar(draftOf({ filter: '{ s: {{status}} }', params: { status: '  ' } }))
    await flushPromises()
    document.querySelector<HTMLButtonElement>('button[aria-label="Save as favourite"]')!.click()
    await flushPromises()
    const name = [...document.querySelectorAll('label')].find((l) => l.textContent?.trim() === 'Name')!
    const input = document.getElementById(name.htmlFor) as HTMLInputElement
    input.value = 'Empty'
    input.dispatchEvent(new Event('input'))
    await flushPromises()
    button('Save').click()
    await flushPromises()
    expect((calls.find((c) => c.method === 'POST')!.body as { query: unknown }).query).toEqual({
      filter: { s: M('status') },
    })
  })
})

describe('a favourite with parameters, opened', () => {
  const item = (body: unknown): LibraryItem => ({
    type: 'favourite',
    id: 'f1',
    db: 'crm',
    coll: 'users',
    name: 'By status',
    tags: [],
    kind: 'find',
    preview: '',
    body,
    at: '2026-10-28T10:00:00.000Z',
    shared: false,
    mine: true,
  })
  const t = (k: string, v?: Record<string, unknown> | number) => i18n.global.t(k, (v ?? {}) as never)

  it('puts the template in the bar, the defaults in the fields, and runs it filled in', async () => {
    const body = { filter: { s: M('status'), n: { $gte: M('n') } }, params: { status: 'paid', n: '2' } }
    expect(await openLibraryItem('c1', item(body), { t })).toBe(true)
    const state = useCollectionViewsStore().stateFor(useTabsStore().active!.id)
    expect(state.draft.filter).toBe('{ s: {{status}}, n: { $gte: {{n}} } }')
    expect(state.draft.params).toEqual({ status: 'paid', n: '2' })
    expect(state.query.filter).toEqual({ s: 'paid', n: { $gte: { $numberInt: '2' } } })
  })

  it('opens one with a parameter that has no default without running it, and says so', async () => {
    const body = { filter: { s: M('status'), n: M('n') }, params: { status: 'paid' } }
    expect(await openLibraryItem('c1', item(body), { t })).toBe(true)
    const state = useCollectionViewsStore().stateFor(useTabsStore().active!.id)
    expect(state.draft.filter).toBe('{ s: {{status}}, n: {{n}} }')
    expect(state.query.filter).toEqual({})
    expect(useToastStore().toasts.at(-1)?.message).toBe(
      'Give the parameters of “By status” a value, then Find.',
    )
  })
})

describe('a query with parameters a plugin hands over', () => {
  it('waits in the bar for its values, running nothing', async () => {
    const { useQueryIn } = await import('../src/plugins/useIn')
    useQueryIn({ connectionId: 'c1', db: 'crm', coll: 'users' }, { filter: { at: { $gte: M('from') } } })
    const state = useCollectionViewsStore().stateFor(useTabsStore().active!.id)
    expect(state.draft.filter).toBe('{ at: { $gte: {{from}} } }')
    expect(state.query.filter).toEqual({})
    // One without parameters runs as before.
    useQueryIn({ connectionId: 'c1', db: 'crm', coll: 'users' }, { filter: { n: { $numberInt: '1' } } })
    expect(state.query.filter).toEqual({ n: { $numberInt: '1' } })
  })
})
