import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { PERMISSIONS } from '@mongo-manager/shared'
import type { PluginPermission, PluginRuntimeView } from '@mongo-manager/shared'
import PluginFrame from '../src/plugins/PluginFrame.vue'
import DialogHost from '../src/ds/DsConfirmHost.vue'
import { i18n } from '../src/i18n'
import { forgetAppInput } from '../src/plugins/appInput'
import { useWorkspaceDialogs } from '../src/stores/workspaceDialogs'
import { COMPACTING, STORAGE_READS } from '../src/plugins/storageState'
import { mockApi, mountApp, type Handler } from './support/app'

/**
 * Plugins wave 4 (design): a database's
 * storage, compact's estimate and compact itself (the app's own dialog, the name typed), a shard
 * key's analysis, the collection's search indexes, search stages in a read-only pipeline, and
 * documents handed to the Import wizard for another collection.
 */
const TOKEN = '00000000-0000-4000-8000-0000000000aa'
const activation = { isActive: true }
beforeEach(() => {
  activation.isActive = true
  Object.defineProperty(navigator, 'userActivation', {
    value: activation,
    configurable: true,
    enumerable: true,
  })
  vi.spyOn(crypto, 'randomUUID').mockReturnValue(TOKEN)
  localStorage.clear()
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
  forgetAppInput()
  STORAGE_READS.clear()
  COMPACTING.clear()
})
afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

const runtime = (permissions: PluginPermission[]): PluginRuntimeView => ({
  id: 'helper',
  version: '1.0.0',
  name: { en: 'Helper' },
  entry: 'index.html',
  permissions,
  contributes: {
    collectionTabs: [{ id: 'tab', title: { en: 'Tab' } }],
    documentActions: [],
    sidebarPanels: [],
    cellRenderers: [],
  } as never,
  settings: {},
})
const connection = (permissions: readonly string[] = PERMISSIONS, over: Record<string, unknown> = {}) => ({
  id: 'c1',
  name: 'Prod',
  group: null,
  color: null,
  favorite: false,
  readOnly: false,
  settings: {},
  uri: '',
  createdAt: 0,
  updatedAt: 0,
  lastUsedAt: null,
  access: 'admin',
  permissions: [...permissions],
  export: true,
  ...over,
})
const COLLECTIONS = [
  { name: 'orders', type: 'collection', options: {}, readOnly: false },
  { name: 'customers', type: 'collection', options: {}, readOnly: false },
  { name: 'recent', type: 'view', options: {}, readOnly: true },
  { name: 'ticks', type: 'timeseries', options: {}, readOnly: false },
]
const BASE = 'connections/c1/databases/shop'
function frame(
  permissions: PluginPermission[],
  extra: Record<string, Handler> = {},
  may?: readonly string[],
  over: Record<string, unknown> = {},
) {
  const api = mockApi({
    'GET plugins/helper/ticket': () => [200, { base: 'about:', entry: 'blank', expiresAt: 0 }],
    'GET connections': () => [200, [connection(may, over)]],
    'GET connections/c1/personal-fields/applied': () => [200, { rules: [], patterns: [] }],
    [`GET ${BASE}/collections`]: () => [200, COLLECTIONS],
    ...extra,
  })
  mountApp(PluginFrame, {
    props: {
      plugin: runtime(permissions),
      kind: 'collectionTab',
      contribution: 'tab',
      target: { connectionId: 'c1', db: 'shop', coll: 'orders' },
    },
  })
  mountApp(DialogHost)
  return api
}
const send = (data: object, source: Window) =>
  window.dispatchEvent(
    new MessageEvent('message', { data: { ...data, token: TOKEN }, origin: 'null', source }),
  )
async function iframe() {
  await flushPromises()
  const el = document.querySelector<HTMLIFrameElement>('[data-plugin-frame] iframe')!
  const sent: Array<{ id: unknown; result?: unknown; error?: { code: string; message: string } }> = []
  vi.spyOn(el.contentWindow!, 'postMessage').mockImplementation((d: unknown) => void sent.push(d as never))
  await flushPromises()
  el.focus()
  // A pipeline's answer is read as NDJSON, which yields to the browser (a timer) between chunks.
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await flushPromises()
      await new Promise((r) => setTimeout(r, 5))
    }
  }
  return {
    el,
    ask: async (id: number, method: string, params?: unknown) => {
      send({ mm: 1, id, method, params }, el.contentWindow!)
      await settle()
      return sent.find((m) => m.id === id)
    },
    answer: async (id: number) => {
      await settle()
      return sent.find((m) => m.id === id)
    },
  }
}

const pressCancel = () =>
  [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((b) => b.textContent?.trim() === 'Cancel')!
    .click()
async function typeAndConfirm(name: string) {
  const input = document.querySelector<HTMLInputElement>('[data-test="require-text"] input')!
  input.value = name
  input.dispatchEvent(new Event('input'))
  await flushPromises()
  document.querySelector<HTMLButtonElement>('[data-test="confirm"]')!.click()
  await flushPromises()
}

describe('a database’s storage', () => {
  it('is read for the plugin’s database with database:read only', async () => {
    const report = { collections: [], more: false }
    const asked: string[] = []
    frame(['documents:read', 'database:read'], {
      [`GET ${BASE}/storage`]: (_b, url) => {
        asked.push(url.pathname)
        return [200, report]
      },
    })
    const { ask } = await iframe()
    expect((await ask(1, 'storage.stats'))!.result).toEqual(report)
    expect(asked).toHaveLength(1)
    document.body.innerHTML = ''
    frame(['documents:read', 'collection:read'])
    const none = await iframe()
    expect((await none.ask(1, 'storage.stats'))!.error!.code).toBe('not_permitted')
  })

  // Final review Minor 8: up to 500 $collStats a read — kept half a minute, read again after compact.
  it('is read once in half a minute, and again after a compact', async () => {
    let reads = 0
    frame(['database:read', 'collection:read'], {
      [`GET ${BASE}/storage`]: () => [200, { collections: [], more: (reads++, false) }],
      [`POST ${BASE}/collections/orders/compact-estimate`]: () => [
        200,
        { available: false, reason: 'version' },
      ],
      [`POST ${BASE}/collections/orders/compact`]: () => [200, { bytesFreed: 1 }],
    })
    const { el, ask, answer } = await iframe()
    await ask(1, 'storage.stats')
    await ask(2, 'storage.stats')
    expect(reads).toBe(1)
    void ask(3, 'ui.compact')
    await flushPromises()
    await typeAndConfirm('orders')
    await answer(3)
    el.focus()
    await ask(4, 'storage.stats')
    expect(reads).toBe(2)
  })
})

describe('compact', () => {
  it('estimates for its collection, another only with database:read', async () => {
    const estimate = { available: true, estimatedBytes: 4096 }
    frame(['collection:read'], {
      [`POST ${BASE}/collections/orders/compact-estimate`]: () => [200, estimate],
    })
    const { ask } = await iframe()
    expect((await ask(1, 'storage.compactEstimate'))!.result).toEqual(estimate)
    expect((await ask(2, 'storage.compactEstimate', { coll: 'customers' }))!.error!.code).toBe(
      'not_permitted',
    )
    document.body.innerHTML = ''
    frame(['collection:read', 'database:read'], {
      [`POST ${BASE}/collections/customers/compact-estimate`]: () => [200, estimate],
    })
    const both = await iframe()
    expect((await both.ask(1, 'storage.compactEstimate', { coll: 'customers' }))!.result).toEqual(estimate)
    expect((await both.ask(2, 'storage.compactEstimate', { coll: 'nope' }))!.error!.code).toBe('bad_params')
  })

  it('runs only after the user typed the collection’s name in the app’s dialog, on their click', async () => {
    const bodies: unknown[] = []
    frame(['collection:read'], {
      [`POST ${BASE}/collections/orders/compact`]: (body) => {
        bodies.push(body)
        return [200, { bytesFreed: 8192 }]
      },
    })
    const { ask, answer } = await iframe()
    void ask(1, 'ui.compact')
    await flushPromises()
    const input = document.querySelector<HTMLInputElement>('[data-test="require-text"] input')!
    expect(document.body.textContent).toContain('Helper')
    const confirm = document.querySelector<HTMLButtonElement>('[data-test="confirm"]')!
    expect(confirm.disabled).toBe(true)
    input.value = 'orders'
    input.dispatchEvent(new Event('input'))
    await flushPromises()
    confirm.click()
    expect((await answer(1))!.result).toEqual({ bytesFreed: 8192 })
    expect(bodies).toEqual([{ confirm: 'orders' }])
  })

  it('is refused without the user’s click, and without the right to administer databases', async () => {
    frame(['collection:read'], {}, ['connections:read', 'databases:read', 'documents:read'])
    const { ask } = await iframe()
    expect((await ask(1, 'ui.compact'))!.error!.code).toBe('not_permitted')
    document.body.innerHTML = ''
    frame(['collection:read'])
    const page = await iframe()
    activation.isActive = false
    const other = document.createElement('button')
    document.body.append(other)
    other.focus()
    expect((await page.ask(1, 'ui.compact'))!.error!.code).toBe('no_activation')
  })

  it('says the user said no', async () => {
    frame(['collection:read'])
    const { ask, answer } = await iframe()
    void ask(1, 'ui.compact')
    await flushPromises()
    ;[...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent?.trim() === 'Cancel')!
      .click()
    expect((await answer(1))!.error!.code).toBe('declined')
  })

  // Final review Minor 4: the dialog says what compact would give back, and that a replica set's
  // primary alone is compacted.
  it('names the estimate and a replica set’s members in its dialog', async () => {
    frame(['collection:read'], {
      [`POST ${BASE}/collections/orders/compact-estimate`]: () => [
        200,
        { available: true, estimatedBytes: 4096 },
      ],
    })
    const { ask } = await iframe()
    void ask(1, 'ui.compact')
    await flushPromises()
    await flushPromises()
    const dialog = document.querySelector('[role="dialog"], [role="alertdialog"]')!
    expect(dialog.textContent).toContain('4 KB')
    expect(dialog.textContent).toContain('each member')
  })

  // Final review Minor 5: refused before the dialog where it would only fail.
  it('is refused before any dialog for a time series, a read-only connection or where rules reach', async () => {
    const noDialog = () => expect(document.querySelector('[data-test="require-text"]')).toBeNull()
    frame(['collection:read', 'database:read'])
    const ts = await iframe()
    expect((await ts.ask(1, 'ui.compact', { coll: 'ticks' }))!.error!.code).toBe('bad_params')
    noDialog()
    document.body.innerHTML = ''
    frame(['collection:read'], {}, undefined, { readOnly: true })
    const ro = await iframe()
    expect((await ro.ask(1, 'ui.compact'))!.error!.code).toBe('read_only')
    noDialog()
    document.body.innerHTML = ''
    frame(['collection:read'], {
      'GET connections/c1/personal-fields/applied': () => [
        200,
        { rules: [{ db: 'shop', coll: 'orders', field: 'email' }], patterns: [['email']] },
      ],
    })
    const ruled = await iframe()
    expect((await ruled.ask(1, 'ui.compact'))!.error!.code).toBe('not_permitted')
    noDialog()
    document.body.innerHTML = ''
    frame(['collection:read'])
    const other = await iframe()
    expect((await other.ask(1, 'ui.compact', { coll: 'customers' }))!.error!.code).toBe('not_permitted')
    noDialog()
  })

  // Final review Minor 21: one question at a time, none after two no's.
  it('is busy while its dialog waits, and blocked after the user said no twice', async () => {
    frame(['collection:read'])
    const { el, ask, answer } = await iframe()
    void ask(1, 'ui.compact')
    await flushPromises()
    el.focus()
    expect((await ask(2, 'ui.compact'))!.error!.code).toBe('busy')
    pressCancel()
    expect((await answer(1))!.error!.code).toBe('declined')
    el.focus()
    void ask(3, 'ui.compact')
    await flushPromises()
    pressCancel()
    expect((await answer(3))!.error!.code).toBe('declined')
    el.focus()
    expect((await ask(4, 'ui.compact'))!.error!.code).toBe('blocked')
  })

  // Final review I5: a compact may run for long — one of a collection at a time.
  it('runs one compact of a collection at a time', async () => {
    let finish: () => void = () => {}
    frame(['collection:read'], {
      [`POST ${BASE}/collections/orders/compact`]: () =>
        new Promise((resolve) => (finish = () => resolve([200, { bytesFreed: 5 }]))),
    })
    const { el, ask, answer } = await iframe()
    void ask(1, 'ui.compact')
    await flushPromises()
    await typeAndConfirm('orders')
    el.focus()
    expect((await ask(2, 'ui.compact'))!.error!.code).toBe('busy')
    finish()
    expect((await answer(1))!.result).toEqual({ bytesFreed: 5 })
  })
})

describe('a shard key’s analysis', () => {
  it('asks for a valid key, with documents:read', async () => {
    const result = { available: false, reason: 'standalone' }
    const bodies: unknown[] = []
    frame(['documents:read'], {
      [`POST ${BASE}/collections/orders/shard-key-analysis`]: (body) => {
        bodies.push(body)
        return [200, result]
      },
    })
    const { ask } = await iframe()
    expect((await ask(1, 'shardKey.analyze', { key: { city: 1 } }))!.result).toEqual(result)
    expect(bodies).toEqual([{ key: { city: 1 } }])
    for (const key of [{}, { $x: 1 }, { a: -1 }, 'city'])
      expect((await ask(Math.random(), 'shardKey.analyze', { key }))!.error!.code).toBe('bad_params')
  })
})

describe('search', () => {
  it('lists the collection’s search indexes with collection:read: their fields, never a hidden one', async () => {
    const list = {
      supported: true,
      indexes: [
        {
          name: 'default',
          type: 'search',
          status: 'READY',
          queryable: true,
          message: 'about ssn',
          definition: {
            mappings: {
              dynamic: false,
              fields: {
                name: { type: 'string' },
                ssn: { type: 'string' },
                contact: {
                  type: 'document',
                  fields: { phone: { type: 'string' }, city: [{ type: 'string' }, { type: 'autocomplete' }] },
                },
                // A hidden object: nothing of it is told, not even its fields' names and types.
                profile: { type: 'document', fields: { age: { type: 'number' } } },
              },
            },
          },
        },
        {
          name: 'vec',
          type: 'vectorSearch',
          status: 'BUILDING',
          queryable: false,
          definition: {
            fields: [
              { type: 'vector', path: 'embedding', numDimensions: 3, similarity: 'cosine' },
              { type: 'filter', path: 'ssn' },
              { type: 'filter', path: 'year' },
            ],
          },
        },
      ],
    }
    frame(['collection:read'], {
      [`GET ${BASE}/collections/orders/search-indexes`]: () => [200, list],
      'GET connections/c1/personal-fields/applied': () => [
        200,
        {
          rules: [{ db: 'shop', coll: 'orders', field: 'ssn' }],
          patterns: [['ssn'], ['contact', 'phone'], ['profile']],
        },
      ],
    })
    const { ask } = await iframe()
    expect((await ask(1, 'searchIndexes.list'))!.result).toEqual({
      supported: true,
      indexes: [
        {
          name: 'default',
          type: 'search',
          status: 'READY',
          queryable: true,
          dynamic: false,
          fields: [
            { path: 'name', type: 'string' },
            { path: 'contact.city', type: 'string' },
          ],
        },
        {
          name: 'vec',
          type: 'vectorSearch',
          status: 'BUILDING',
          queryable: false,
          dynamic: false,
          fields: [
            { path: 'embedding', type: 'vector', numDimensions: 3, similarity: 'cosine' },
            { path: 'year', type: 'filter' },
          ],
        },
      ],
    })
  })

  it('says when search indexes are not there, and fails when what is hidden cannot be told', async () => {
    frame(['collection:read'], {
      [`GET ${BASE}/collections/orders/search-indexes`]: () => [
        200,
        { supported: false, reason: 'not_enabled', indexes: [] },
      ],
      'GET connections/c1/personal-fields/applied': () => [500, { code: 'FAILED', message: 'x' }],
    })
    const { ask } = await iframe()
    expect((await ask(1, 'searchIndexes.list'))!.result).toEqual({
      supported: false,
      reason: 'not_enabled',
      indexes: [],
    })
    document.body.innerHTML = ''
    frame(['collection:read'], {
      [`GET ${BASE}/collections/orders/search-indexes`]: () => [200, { supported: true, indexes: [] }],
      'GET connections/c1/personal-fields/applied': () => [500, { code: 'FAILED', message: 'x' }],
    })
    const failing = await iframe()
    expect((await failing.ask(1, 'searchIndexes.list'))!.error!.code).toBe('failed')
  })

  it('runs $search or $vectorSearch as a read-only pipeline’s first stage, never later', async () => {
    const runs: unknown[] = []
    frame(['documents:read'], {
      [`POST ${BASE}/collections/orders/aggregate/run`]: (body) => {
        runs.push(body)
        return new Response(JSON.stringify({ end: { count: 0, truncated: false, bytes: 0 } }), {
          status: 200,
        })
      },
    })
    const { ask } = await iframe()
    const search = [{ $search: { text: { query: 'x', path: 'name' } } }, { $limit: 5 }]
    const vector = [
      { $vectorSearch: { index: 'v', path: 'e', queryVector: [0.1], numCandidates: 10, limit: 5 } },
    ]
    expect((await ask(1, 'documents.aggregate', { pipeline: search }))!.error).toBeUndefined()
    expect((await ask(2, 'documents.aggregate', { pipeline: vector }))!.error).toBeUndefined()
    expect(
      (await ask(3, 'documents.aggregate', { pipeline: [{ $match: {} }, { $search: { text: {} } }] }))!.error!
        .code,
    ).toBe('bad_params')
    expect(runs).toHaveLength(2)
    // Final review Minor 21: never nested, and its body holds nothing forbidden.
    expect(
      (await ask(4, 'documents.aggregate', { pipeline: [{ $facet: { a: [{ $search: { text: {} } }] } }] }))!
        .error!.code,
    ).toBe('bad_params')
    expect(
      (await ask(5, 'documents.aggregate', {
        pipeline: [{ $search: { index: 'd', compound: { filter: [{ $lookup: { from: 'users' } }] } } }],
      }))!.error!.code,
    ).toBe('bad_params')
    expect(runs).toHaveLength(2)
  })
})

describe('documents handed to the Import wizard for another collection', () => {
  const NDJSON = '{"name":"Ada"}\n'
  it('opens the wizard on a new collection of the same database, with database:read', async () => {
    frame(['documents:read', 'database:read'])
    const { ask } = await iframe()
    expect((await ask(1, 'ui.importDocuments', { ndjson: NDJSON, coll: 'orders_anon' }))!.result).toBe(true)
    expect(useWorkspaceDialogs().current).toMatchObject({
      kind: 'importData',
      db: 'shop',
      coll: 'orders_anon',
    })
    useWorkspaceDialogs().close()
    expect((await ask(2, 'ui.importDocuments', { ndjson: NDJSON, coll: 'system.js' }))!.error!.code).toBe(
      'bad_params',
    )
    // Final review I4: a new collection only — never one there is (read fresh), nor a name that
    // hides or turns its characters, nor encryption's metadata.
    for (const [n, coll] of [
      'recent',
      'customers',
      'ord\u202eers',
      'enxcol_.orders.esc',
      'a\u200bb',
    ].entries())
      expect((await ask(10 + n, 'ui.importDocuments', { ndjson: NDJSON, coll }))!.error!.code, coll).toBe(
        'bad_params',
      )
    COLLECTIONS.push({ name: 'orders_anon', type: 'collection', options: {}, readOnly: false })
    try {
      expect(
        (await ask(20, 'ui.importDocuments', { ndjson: NDJSON, coll: 'orders_anon' }))!.error!.code,
      ).toBe('bad_params')
    } finally {
      COLLECTIONS.pop()
    }
    document.body.innerHTML = ''
    frame(['documents:read'])
    const own = await iframe()
    expect(
      (await own.ask(1, 'ui.importDocuments', { ndjson: NDJSON, coll: 'orders_anon' }))!.error!.code,
    ).toBe('not_permitted')
  })
})
