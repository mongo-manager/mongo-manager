// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { LibraryItem } from '@mongo-manager/shared/browser'
import { openLibraryItem } from '../src/library/openItem'
import { useTabsStore } from '../src/stores/tabs'
import { useCollectionViewsStore } from '../src/stores/collectionViews'
import { i18n } from '../src/i18n'

/** Phase 3b §3.2: "Open in Explain" opens the query in its collection tab, on the Explain section. */
beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
})

const common = {
  type: 'history' as const,
  id: 'slow',
  db: 'crm',
  coll: 'users',
  tags: [],
  preview: '',
  at: '2026-09-30T10:00:00.000Z',
  shared: false,
  mine: true,
}
const t = (k: string) => i18n.global.t(k)

describe('openLibraryItem with explain (phase 3b)', () => {
  it('opens a find on the Explain section and asks it to run', async () => {
    const item: LibraryItem = { ...common, kind: 'find', body: { filter: { n: { $numberInt: '1' } } } }
    expect(await openLibraryItem('c1', item, { t, explain: true })).toBe(true)
    const state = useCollectionViewsStore().stateFor(useTabsStore().active!.id)
    expect(state.section).toBe('explain')
    expect(state.explain).toMatchObject({ source: 'documents', request: 1 })
    expect(state.query.filter).toEqual({ n: { $numberInt: '1' } })
  })

  it('opens a pipeline on the Explain section with the aggregation as its source', async () => {
    const item: LibraryItem = { ...common, kind: 'aggregate', body: [{ $match: { n: 1 } }] }
    expect(await openLibraryItem('c1', item, { t, explain: true })).toBe(true)
    const state = useCollectionViewsStore().stateFor(useTabsStore().active!.id)
    expect(state.section).toBe('explain')
    expect(state.explain).toMatchObject({ source: 'aggregation', request: 1 })
  })
})

// W5: "Open in collection view" from a shell result keeps the query's skip and limit.
describe('openLibraryItem with paging (W5)', () => {
  it('starts Documents at the skip, the limit as its page size', async () => {
    const item: LibraryItem = { ...common, kind: 'find', body: { filter: {} } }
    expect(await openLibraryItem('c1', item, { t, paging: { skip: 40, limit: 7 } })).toBe(true)
    const state = useCollectionViewsStore().stateFor(useTabsStore().active!.id)
    expect(state.query).toMatchObject({ skip: 40, limit: 7 })
    expect(state.draft).toMatchObject({ skip: '40', limit: 7 })
    expect(state.page).toBe(0)
  })

  it('keeps the tab’s own page size and no skip when none is given', async () => {
    const item: LibraryItem = { ...common, kind: 'find', body: { filter: {} } }
    await openLibraryItem('c1', item, { t })
    const state = useCollectionViewsStore().stateFor(useTabsStore().active!.id)
    expect(state.query).toMatchObject({ skip: 0, limit: 20 })
    expect(state.draft.skip).toBe('')
  })
})
