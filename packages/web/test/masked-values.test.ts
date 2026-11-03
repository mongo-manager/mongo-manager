import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import DocumentsView from '../src/documents/DocumentsView.vue'
import AggregationView from '../src/aggregation/AggregationView.vue'
import { useCollectionViewsStore } from '../src/stores/collectionViews'
import { newCard } from '../src/aggregation/stages'
import { mockApi, mountApp } from './support/app'
import ValueCell from '../src/documents/ValueCell.vue'
import DocumentCards from '../src/documents/DocumentCards.vue'
import DocumentJsonList from '../src/documents/DocumentJsonList.vue'
import { toRows } from '../src/documents/rows'
import { MASKED_PATH } from '../src/masking/useMaskedPaths'
import { i18n } from '../src/i18n'

/** Phase 3c §7: a hidden value is shown with a lock, told apart from a real "***" string. */
const mountCell = (value: unknown, path: string[], masked: (p: readonly string[]) => boolean) =>
  mount(ValueCell, {
    props: { value, present: true, path },
    global: { plugins: [i18n], provide: { [MASKED_PATH as symbol]: ref(masked) } },
  })

describe('masked values (phase 3c §7)', () => {
  it('shows a lock for *** at a personal path', () => {
    const cell = mountCell('***', ['email'], (p) => p[0] === 'email')
    expect(cell.find('[data-masked]').exists()).toBe(true)
    expect(cell.text()).not.toContain('***')
  })

  it('shows a real *** string at another path as text', () => {
    const cell = mountCell('***', ['note'], (p) => p[0] === 'email')
    expect(cell.find('[data-masked]').exists()).toBe(false)
    expect(cell.text()).toContain('***')
  })

  it('shows a value that is not *** as it is, even at a personal path', () => {
    const cell = mountCell('a@x', ['email'], (p) => p[0] === 'email')
    expect(cell.find('[data-masked]').exists()).toBe(false)
  })
})

describe('hidden values on views and in aggregation results (final review M4)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    i18n.global.locale.value = 'en'
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('marks a view by the paths the server resolved through it', async () => {
    const asked: string[] = []
    mockApi({
      'GET connections/c1/personal-fields/applied': (_b, url) => {
        asked.push(url.search)
        return [200, { rules: [{ db: 'crm', coll: 'users', field: 'email' }], patterns: [['email']] }]
      },
      'POST connections/c1/databases/crm/collections/users_v/find': () => [
        200,
        { documents: [{ document: { email: '***', name: 'Ali' }, hash: 'a'.repeat(64) }], hasMore: false },
      ],
      'POST connections/c1/databases/crm/collections/users_v/count': () => [200, { count: 1, exact: true }],
    })
    useCollectionViewsStore().stateFor('tab-v')
    mountApp(DocumentsView, {
      props: {
        target: { connectionId: 'c1', db: 'crm', coll: 'users_v' },
        tabId: 'tab-v',
        canWrite: false,
        isView: true,
      },
    })
    await flushPromises()
    expect(asked[0]).toContain('db=crm')
    expect(asked[0]).toContain('coll=users_v')
    expect(document.querySelector('[data-masked-banner]')).not.toBeNull()
    expect(document.querySelector('tbody [data-masked]')).not.toBeNull()
  })

  it('shows the hint in the aggregation builder when a preview hides output paths', async () => {
    const card = newCard('$project')
    useCollectionViewsStore().stateFor('tab-a').aggregation.cards = [card]
    mockApi({
      'GET connections/c1/personal-fields/applied': () => [200, { rules: [] }],
      'POST connections/c1/databases/crm/collections/users/aggregate/preview': () => [
        200,
        {
          sample: { documents: [{ document: { c: { phone: '***' } }, hash: 'b'.repeat(64) }], count: 1 },
          stages: [{ documents: [{ document: { c: { phone: '***' } }, hash: 'c'.repeat(64) }], count: 1 }],
          masked: [['c', 'phone']],
        },
      ],
    })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    mountApp(AggregationView, {
      props: { target: { connectionId: 'c1', db: 'crm', coll: 'users' }, tabId: 'tab-a', canWrite: false },
    })
    await vi.advanceTimersByTimeAsync(400)
    await flushPromises()
    expect(document.querySelector('[data-masked-banner]')).not.toBeNull()
  })
})

describe('a hidden _id on a card (reviewer B Minor 12)', () => {
  it('shows the lock in the card header too', () => {
    const rows = toRows([{ document: { _id: '***', name: 'N' }, hash: 'h'.repeat(64) }], 0)
    const cards = mount(DocumentCards, {
      props: { rows, canWrite: false, selectedId: null },
      global: {
        plugins: [i18n, createPinia()],
        provide: { [MASKED_PATH as symbol]: ref((p: readonly string[]) => p[0] === '_id') },
      },
    })
    expect(cards.find('[data-card] [data-masked]').exists()).toBe(true)
  })
})

describe('hidden values in the JSON view (W5)', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('shows a lock and an accessible label on a hidden value, and a real *** as text', () => {
    // No layout here: the lazy code view renders at once without an IntersectionObserver.
    vi.stubGlobal('IntersectionObserver', undefined)
    const rows = toRows(
      [
        {
          document: { _id: 1, email: '***', note: '***', customer: { phone: '***', city: 'x' } },
          hash: 'j'.repeat(64),
        },
      ],
      0,
    )
    const list = mount(DocumentJsonList, {
      props: { rows, canWrite: false },
      global: {
        plugins: [i18n, createPinia()],
        provide: {
          [MASKED_PATH as symbol]: ref(
            (p: readonly string[]) => p[0] === 'email' || (p[0] === 'customer' && p[1] === 'phone'),
          ),
        },
      },
    })
    const marks = list.findAll('[data-masked]')
    expect(marks).toHaveLength(2)
    for (const mark of marks) {
      expect(mark.find('svg').exists()).toBe(true)
      expect(mark.find('.sr-only').text()).toBe('Personal data, hidden from you')
      expect(mark.attributes('title')).toBe('Personal data, hidden from you')
    }
    // A real "***" at a path without a rule stays a plain string.
    expect(list.text()).toContain('note: "***"')
    expect(list.text()).not.toContain('')
  })
})
