import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, watch } from 'vue'
import { useCollectionPresence, type Presence } from '../src/connections/presence'
import { mockApi, mountApp } from './support/app'

beforeEach(() => setActivePinia(createPinia()))
afterEach(() => vi.unstubAllGlobals())

const LIST = 'GET connections/c1/databases/shop/collections'
/** Every presence the place went through, in order. */
async function watchPresence(coll: string): Promise<Presence[]> {
  const seen: Presence[] = []
  mountApp(
    defineComponent({
      setup() {
        const { presence } = useCollectionPresence('c1', 'shop', coll)
        watch(presence, (p) => seen.push(p), { immediate: true })
        return () => h('div')
      },
    }),
  )
  for (let i = 0; i < 4; i++) await flushPromises()
  return seen
}

describe('whether a collection is there (user review 2026-10-09)', () => {
  it('reads the list again before saying a collection is missing, so one made a moment ago is never', async () => {
    let reads = 0
    mockApi({
      'GET connections': () => [200, [{ id: 'c1', name: 'Prod' }]],
      [LIST]: () => [200, ++reads === 1 ? [] : [{ name: 'fresh', type: 'collection' }]],
    })
    const seen = await watchPresence('fresh')
    expect(seen).not.toContain('noCollection')
    expect(seen.at(-1)).toBe('present')
    expect(reads).toBe(2)
  })

  it('says missing after the list read again still has no such collection', async () => {
    mockApi({ 'GET connections': () => [200, [{ id: 'c1', name: 'Prod' }]], [LIST]: () => [200, []] })
    expect((await watchPresence('gone')).at(-1)).toBe('noCollection')
  })

  it('says nothing missing when the list read again cannot be read', async () => {
    let reads = 0
    mockApi({
      'GET connections': () => [200, [{ id: 'c1', name: 'Prod' }]],
      [LIST]: () => (++reads === 1 ? [200, []] : [500, { code: 'INTERNAL', message: 'x' }]),
    })
    const seen = await watchPresence('gone')
    expect(seen).not.toContain('noCollection')
    expect(seen.at(-1)).toBe('unknown')
  })

  it('says the connection is gone when it is not among the user’s', async () => {
    mockApi({ 'GET connections': () => [200, []] })
    expect((await watchPresence('orders')).at(-1)).toBe('noConnection')
  })
})
