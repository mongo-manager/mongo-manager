import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import DocumentsView from '../src/documents/DocumentsView.vue'
import DialogHost from '../src/ds/DsConfirmHost.vue'
import { useCollectionViewsStore } from '../src/stores/collectionViews'
import { i18n } from '../src/i18n'
import { mockApi, mountApp, type Handler } from './support/app'
import { button } from './support/dom'

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const PREFIX = 'connections/c1/databases/shop/collections/orders'

async function view(recent: unknown[], extra: Record<string, Handler> = {}) {
  let list = recent
  const api = mockApi({
    [`POST ${PREFIX}/find`]: () => [200, { documents: [], hasMore: false }],
    [`POST ${PREFIX}/count`]: () => [200, { count: 0, exact: true }],
    [`GET ${PREFIX}/recent-queries`]: () => [200, { queries: list }],
    [`DELETE ${PREFIX}/recent-queries`]: () => {
      list = []
      return [204, undefined]
    },
    ...extra,
  })
  useCollectionViewsStore().stateFor('t')
  mountApp(DocumentsView, {
    props: {
      target: { connectionId: 'c1', db: 'shop', coll: 'orders' },
      tabId: 't',
      canWrite: true,
      isView: false,
    },
  })
  mountApp(DialogHost)
  await flushPromises()
  return api
}

const entries = () => [...document.querySelectorAll<HTMLButtonElement>('[data-test="recent-query"]')]

describe('recent queries (phase 1g-1)', () => {
  it('lists them on request and runs the one picked, filling the query bar', async () => {
    const { calls } = await view([
      {
        query: { filter: { qty: { $lt: { $numberInt: '30' } } }, sort: { qty: { $numberInt: '-1' } } },
        usedAt: 2,
      },
      { query: { filter: { name: 'Ada' } }, usedAt: 1 },
    ])
    button('Recent queries').click()
    await flushPromises()
    expect(entries().map((e) => e.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      '{ qty: { $lt: 30 } } sort: { qty: -1 }',
      '{ name: "Ada" }',
    ])
    entries()[0]!.click()
    await flushPromises()
    expect(useCollectionViewsStore().stateFor('t').draft).toMatchObject({
      filter: '{ qty: { $lt: 30 } }',
      sort: '{ qty: -1 }',
    })
    expect(calls.filter((c) => c.path.endsWith('/find')).at(-1)!.body).toMatchObject({
      filter: { qty: { $lt: { $numberInt: '30' } } },
      sort: { qty: { $numberInt: '-1' } },
    })
    expect(entries()).toHaveLength(0) // the list closed
  })

  it('shows an empty state, and clears the history after confirmation', async () => {
    const { calls } = await view([{ query: { filter: { a: { $numberInt: '1' } } }, usedAt: 1 }])
    button('Recent queries').click()
    await flushPromises()
    button('Clear history').click()
    await flushPromises()
    ;(document.querySelector('[data-test="confirm"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(calls.some((c) => c.method === 'DELETE' && c.path.endsWith('/recent-queries'))).toBe(true)
    expect(document.body.textContent).toContain('No recent queries yet.')
  })

  it('closes with Escape and gives focus back to its button', async () => {
    await view([{ query: { filter: { a: { $numberInt: '1' } } }, usedAt: 1 }])
    const trigger = button('Recent queries')
    trigger.click()
    await flushPromises()
    entries()[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(entries()).toHaveLength(0)
    expect(document.activeElement).toBe(trigger)
  })
})
