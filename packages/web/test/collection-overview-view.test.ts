import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '../src/i18n'
import CollectionOverview from '../src/workspace/tabs/CollectionOverview.vue'
import { mockApi, mountApp } from './support/app'

/**
 * Review of the personal-data scrub (2026-10-24): once values are hidden from you, the collection
 * list kept for its names loses a view's pipeline (it can quote values) until it is read again. The
 * view's card said its definition was `[]`.
 */
beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  document.body.innerHTML = ''
})

describe("a view's overview", () => {
  const mount = async (view: { viewOn?: string; pipeline?: unknown[] }) => {
    mockApi({
      'GET connections': () => [200, []],
      'POST connections/c1/databases/shop/collections/recent/count': () => [200, { count: 3, exact: true }],
    })
    mountApp(CollectionOverview, { props: { connectionId: 'c1', db: 'shop', coll: 'recent', view } })
    await flushPromises()
  }

  it('shows its definition', async () => {
    await mount({ viewOn: 'orders', pipeline: [{ $match: { status: 'A' } }] })
    expect(document.body.textContent).toContain('$match')
  })

  it('says its definition is not read yet, rather than show none', async () => {
    await mount({ viewOn: 'orders' })
    expect(document.querySelector('[data-view-definition-unread]')).not.toBeNull()
    expect(document.body.textContent).not.toContain('[]')
  })

  // Last review (minor 1): a user who may list some collections only is given names, no options:
  // reading the database again never shows the definition, so that is not what it says.
  it('says its definition is not given, where the list holds no options', async () => {
    await mount({})
    expect(document.querySelector('[data-view-definition-unavailable]')).not.toBeNull()
    expect(document.querySelector('[data-view-definition-unread]')).toBeNull()
    expect(document.body.textContent).not.toContain('[]')
    // Nit 3: its title names no source it was not given.
    expect(document.body.textContent).toContain('A view')
    expect(document.body.textContent).not.toContain('A view on')
  })
})

describe('a collection’s sizes hidden for personal data (2026-10-26)', () => {
  const mount = async (canSeeRules: boolean) => {
    mockApi({
      'GET connections': () => [200, []],
      'GET connections/c1/databases/shop/collections/orders/stats': () => [
        200,
        {
          count: 4,
          size: null,
          storageSize: null,
          avgObjSize: null,
          totalIndexSize: null,
          nindexes: 1,
          capped: false,
          indexSizes: {},
          sizesHidden: true,
        },
      ],
    })
    const seen: string[] = []
    mountApp(CollectionOverview, {
      props: {
        connectionId: 'c1',
        db: 'shop',
        coll: 'orders',
        canSeeRules,
        onSeeRules: () => seen.push('rules'),
      },
    })
    await flushPromises()
    return seen
  }

  it('says why, and offers the rules to one who manages them', async () => {
    const seen = await mount(true)
    const note = document.querySelector<HTMLElement>('[data-sizes-hidden]')!
    expect(note.textContent).toContain('Sizes are hidden')
    note.querySelector<HTMLButtonElement>('button')!.click()
    expect(seen).toEqual(['rules'])
  })

  it('offers no way to the rules to one who does not', async () => {
    await mount(false)
    expect(document.querySelector('[data-sizes-hidden]')).not.toBeNull()
    expect(document.querySelector('[data-sizes-hidden] button')).toBeNull()
  })
})
