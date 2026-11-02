import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { Component } from 'vue'
import ExplainView from '../src/explain/ExplainView.vue'
import ValidationView from '../src/validation/ValidationView.vue'
import IndexesView from '../src/indexes/IndexesView.vue'
import SchemaView from '../src/schema/SchemaView.vue'
import WatchView from '../src/watch/WatchView.vue'
import { useCollectionViewsStore } from '../src/stores/collectionViews'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'

/**
 * W5 (spec 3c §7, "the hint banner appears on every data screen for a restricted user"): Explain,
 * Validation, Indexes, Schema and Watch say so too, not only Documents and Aggregations.
 */
const target = { connectionId: 'c1', db: 'crm', coll: 'users' }
const screens: Array<[string, Component, Record<string, unknown>]> = [
  ['Explain', ExplainView, { target, tabId: 't1', canManageIndexes: false }],
  ['Validation', ValidationView, { target, canWrite: false, tabId: 't1' }],
  ['Indexes', IndexesView, { target, canManage: false }],
  ['Schema', SchemaView, { target, tabId: 't1' }],
  [
    'Watch',
    WatchView,
    { target: { connectionId: 'c1', scope: 'collection', db: 'crm', coll: 'users' }, canExport: false },
  ],
  [
    'Watch (database)',
    WatchView,
    { target: { connectionId: 'c1', scope: 'database', db: 'crm' }, canExport: false },
  ],
]

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
  useCollectionViewsStore().stateFor('t1')
  // The watch feed opens a socket; none is needed to see the banner.
  vi.stubGlobal(
    'WebSocket',
    class {
      readyState = 0
      addEventListener() {}
      removeEventListener() {}
      send() {}
      close() {}
    },
  )
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('the masking banner on every data screen (W5)', () => {
  it.each(screens)('%s shows it to a user from whom values are hidden', async (name, view, props) => {
    mockApi({
      'GET connections/c1/personal-fields/applied': (_b, url) =>
        // As the server: an empty name is not a name (a watch over a database names no collection).
        [...url.searchParams.values()].some((v) => v === '')
          ? [400, { code: 'VALIDATION_ERROR', message: 'empty name' }]
          : [
              200,
              {
                rules: [{ db: 'crm', coll: 'users', field: 'email' }],
                ...(url.searchParams.get('coll') ? { patterns: [['email']] } : {}),
              },
            ],
    })
    mountApp(view, { props })
    await flushPromises()
    const banner = document.querySelector('[data-masked-banner]')
    expect(banner).not.toBeNull()
    expect(banner!.textContent).toContain(
      name === 'Watch (database)'
        ? 'Some values in these changes are personal data'
        : 'Some values in this collection are personal data',
    )
  })

  it.each(screens)('%s does not show it to a user who sees every value', async (_name, view, props) => {
    mockApi({ 'GET connections/c1/personal-fields/applied': () => [200, { rules: [] }] })
    mountApp(view, { props })
    await flushPromises()
    expect(document.querySelector('[data-masked-banner]')).toBeNull()
  })
})
