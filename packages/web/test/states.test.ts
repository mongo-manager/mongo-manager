import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import DocumentsView from '../src/documents/DocumentsView.vue'
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
async function view(handlers: Record<string, Handler>, canWrite = true) {
  const api = mockApi({ [`POST ${PREFIX}/count`]: () => [200, { count: 0, exact: true }], ...handlers })
  mountApp(DocumentsView, {
    props: {
      target: { connectionId: 'c1', db: 'shop', coll: 'orders' },
      tabId: 't',
      canWrite,
      isView: false,
    },
  })
  await flushPromises()
  return api
}
const empty: Handler = () => [200, { documents: [], hasMore: false }]

describe('what the Documents screen says (UI redesign R1 checkpoint 3)', () => {
  it('says an empty collection is empty, and offers to add or import documents', async () => {
    await view({ [`POST ${PREFIX}/find`]: empty })
    expect(document.body.textContent).toContain('This collection has no documents yet')
    expect(document.querySelector('[data-empty-state] button')).not.toBeNull()
    expect(button('Import a file')).toBeTruthy()
  })

  it('offers no writes in an empty collection to a reader', async () => {
    await view({ [`POST ${PREFIX}/find`]: empty }, false)
    expect(document.body.textContent).toContain('This collection has no documents yet')
    expect(document.querySelector('[data-empty-state] button')).toBeNull()
  })

  it('says when nothing matches the query, and clears the filter in one click', async () => {
    useCollectionViewsStore().stateFor('t').draft.filter = '{ status: "lost" }'
    useCollectionViewsStore().stateFor('t').query = { filter: { status: 'lost' }, skip: 0, limit: 20 }
    await view({ [`POST ${PREFIX}/find`]: empty })
    expect(document.body.textContent).toContain('No documents match this query.')
    button('Clear the filter').click()
    await flushPromises()
    const state = useCollectionViewsStore().stateFor('t')
    expect(state.draft.filter).toBe('')
    expect(state.query.filter).toEqual({})
  })

  it('clears the filter only, keeping the sort (reviewer B Minor 7)', async () => {
    const state = useCollectionViewsStore().stateFor('t')
    state.draft.filter = '{ status: "lost" }'
    state.draft.sort = '{ total: -1 }'
    state.query = { filter: { status: 'lost' }, sort: { total: -1 }, skip: 0, limit: 20 }
    await view({ [`POST ${PREFIX}/find`]: empty })
    button('Clear the filter').click()
    await flushPromises()
    expect(state.draft.filter).toBe('')
    expect(state.draft.sort).toBe('{ total: -1 }')
    expect(state.query).toMatchObject({ filter: {}, sort: { total: -1 } })
  })

  it('says an empty collection is empty when only a sort is set', async () => {
    const state = useCollectionViewsStore().stateFor('t')
    state.draft.sort = '{ total: -1 }'
    state.query = { filter: {}, sort: { total: -1 }, skip: 0, limit: 20 }
    await view({ [`POST ${PREFIX}/find`]: empty })
    expect(document.body.textContent).toContain('This collection has no documents yet')
  })

  it('says what went wrong, and tries again on request', async () => {
    let n = 0
    const { calls } = await view({
      [`POST ${PREFIX}/find`]: () =>
        ++n === 1 ? [500, { code: 'INTERNAL', message: 'boom' }] : [200, { documents: [], hasMore: false }],
    })
    expect(document.querySelector('[role="alert"]')).not.toBeNull()
    button('Try again').click()
    await vi.waitFor(() =>
      expect(calls.filter((c) => c.path.endsWith('/find')).length).toBeGreaterThanOrEqual(2),
    )
  })
})
