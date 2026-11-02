import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { PERMISSIONS } from '@mongo-manager/shared'
import type { PluginPermission, PluginRuntimeView } from '@mongo-manager/shared'
import PluginFrame from '../src/plugins/PluginFrame.vue'
import ImportWizard from '../src/transfer/ImportWizard.vue'
import DialogHost from '../src/ds/DsConfirmHost.vue'
import { i18n } from '../src/i18n'
import { forgetAppInput } from '../src/plugins/appInput'
import {
  ANSWER_TTL_MS,
  RETRY_MS,
  cellCache,
  cellText,
  cellTextFor,
  cellTextsFor,
  cellValue,
  matches,
} from '../src/plugins/cells'
import { useToastStore } from '../src/stores/toasts'
import { useDialogStore } from '../src/stores/dialogs'
import { APP_QUESTION_MS } from '../src/plugins/questions'
import { rulesWithoutHidden } from '../src/plugins/hiddenRules'
import { QUESTION_TIMEOUT_MS } from '../../plugins/kit/src/client'
import { useWorkspaceDialogs } from '../src/stores/workspaceDialogs'
import { pluginIcon } from '../src/plugins/icons'
import { decodeValue } from '../src/documents/values'
import { PLUGIN_CELL_MATCHES, PLUGIN_ICONS } from '@mongo-manager/shared'
import { mockApi, mountApp, type Handler } from './support/app'

/** The wizard's upload (an XMLHttpRequest of its own): what it sent, and as which file. */
const uploaded: Array<{ name: string; text: string }> = []
vi.mock('../src/transfer/useUpload', async () => {
  const { ref } = await import('vue')
  return {
    useUpload: () => ({
      progress: ref(0),
      uploading: ref(false),
      abort: () => undefined,
      upload: async (_conn: string, file: Blob, name: string) => {
        uploaded.push({ name, text: await file.text() })
        return { uploadId: 'u1', size: file.size }
      },
    }),
  }
})

/**
 * Plugins wave 3 (design §1): a file saved
 * on the user's click, documents handed to the Import wizard, another collection's indexes and
 * rules, the database's model, what is hidden from the user, binary values' heads.
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
  cellCache.clear()
  forgetAppInput()
})
afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

const runtime = (permissions: PluginPermission[] = ['documents:read']): PluginRuntimeView => ({
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
const BLANK = { base: 'about:', entry: 'blank', expiresAt: 0 }
const connection = (permissions: readonly string[] = PERMISSIONS) => ({
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
})
const COLLECTIONS = [
  { name: 'orders', type: 'collection', options: {}, readOnly: false },
  { name: 'customers', type: 'collection', options: {}, readOnly: false },
  { name: 'big_orders', type: 'view', options: {}, readOnly: true },
]
const send = (data: object, source: Window) =>
  window.dispatchEvent(
    new MessageEvent('message', { data: { ...data, token: TOKEN }, origin: 'null', source }),
  )

function frame(
  opts: { permissions?: PluginPermission[]; coll?: string; db?: string; may?: readonly string[] } = {},
  extra: Record<string, Handler> = {},
) {
  const db = opts.db ?? 'shop'
  const api = mockApi({
    'GET plugins/helper/ticket': () => [200, BLANK],
    'GET connections': () => [200, [connection(opts.may)]],
    [`GET connections/c1/databases/${db}/collections`]: () => [200, COLLECTIONS],
    ...extra,
  })
  mountApp(PluginFrame, {
    props: {
      plugin: runtime(opts.permissions),
      kind: 'collectionTab',
      contribution: 'tab',
      target: { connectionId: 'c1', db, coll: opts.coll ?? 'orders' },
    },
  })
  mountApp(DialogHost)
  return api
}
async function iframe() {
  await flushPromises()
  const el = document.querySelector<HTMLIFrameElement>('[data-plugin-frame] iframe')!
  const sent: Array<{ id: unknown; result?: unknown; error?: { code: string; message: string } }> = []
  vi.spyOn(el.contentWindow!, 'postMessage').mockImplementation((d: unknown) => void sent.push(d as never))
  await flushPromises()
  // The user clicked in the plugin's page: the frame has the focus.
  el.focus()
  return {
    el,
    /** The answer to a request, once it came (a question the user answers comes later). */
    answer: async (id: number) => {
      await flushPromises()
      await flushPromises()
      return sent.find((m) => m.id === id)!
    },
    ask: async (id: number, method: string, params?: unknown) => {
      send({ mm: 1, id, method, params }, el.contentWindow!)
      await flushPromises()
      await flushPromises()
      return sent.find((m) => m.id === id)!
    },
  }
}
/** A BSON Binary of these bytes and subtype, as the app holds one. */
const binary = (bytes: Uint8Array, subType: number) => {
  let raw = ''
  for (const b of bytes) raw += String.fromCharCode(b)
  return decodeValue({ $binary: { base64: btoa(raw), subType: subType.toString(16).padStart(2, '0') } })
}

/** Personal-data rules that hide nothing from the user. */
const NOTHING_HIDDEN: Record<string, Handler> = {
  'GET connections/c1/personal-fields/applied': () => [200, { rules: [], patterns: [] }],
}

/** The user pressed in the app's own page a moment ago: the frame may have taken the focus since. */
function pressInApp(): void {
  document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
}

/** The user clicked elsewhere in the app: the frame lost the focus. */
function clickInApp(): void {
  const other = document.createElement('button')
  document.body.append(other)
  other.focus()
}

describe('a file a plugin hands the app to save (§1.1)', () => {
  it('is saved on the user’s click in its page, named safely, and said', async () => {
    frame()
    const { ask } = await iframe()
    const saved: Array<{ name: string; type: string }> = []
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x')
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      saved.push({ name: this.download, type: this.href })
    })
    expect((await ask(1, 'ui.download', { name: '../shop', type: 'markdown', text: '# Shop' })).result).toBe(
      true,
    )
    expect(saved).toEqual([{ name: 'shop.md', type: 'blob:x' }])
    expect(useToastStore().toasts.at(-1)!.message).toContain('Helper (helper)')
    expect(useToastStore().toasts.at(-1)!.message).toContain('shop.md')
    // Never without the user's click in its own page.
    clickInApp()
    expect((await ask(2, 'ui.download', { name: 'x', type: 'text', text: 'x' })).error!.code).toBe(
      'no_activation',
    )
    expect(saved).toHaveLength(1)
  })

  it('refuses what it cannot save safely', async () => {
    frame()
    const { ask } = await iframe()
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    expect((await ask(1, 'ui.download', { name: 'x', type: 'exe', text: 'MZ' })).error!.code).toBe(
      'bad_params',
    )
    expect((await ask(2, 'ui.download', { name: 'x', type: 'png', base64: btoa('nope') })).error!.code).toBe(
      'bad_params',
    )
  })
})

describe('documents a plugin hands to the Import wizard (§1.2)', () => {
  const NDJSON = '{"name":"Ada"}\n{"name":"Grace"}\n'

  it('opens the wizard on its collection with them as its file, on the user’s click', async () => {
    frame()
    const { ask } = await iframe()
    expect((await ask(1, 'ui.importDocuments', { ndjson: NDJSON })).result).toBe(true)
    expect(useWorkspaceDialogs().current).toEqual({
      kind: 'importData',
      connectionId: 'c1',
      db: 'shop',
      coll: 'orders',
      file: { id: TOKEN, name: 'helper-orders.ndjson', text: NDJSON, from: 'Helper (helper)' },
    })
    useWorkspaceDialogs().close()
    clickInApp()
    expect((await ask(2, 'ui.importDocuments', { ndjson: NDJSON })).error!.code).toBe('no_activation')
    expect(useWorkspaceDialogs().current).toBeNull()
  })

  it('refuses lines that are not objects, nothing at all, a view, a system database, or no right to write', async () => {
    frame()
    const page = await iframe()
    for (const ndjson of ['[1,2]\n', '{"a":1}\nnot json\n', '"x"\n', '\n\n', 42])
      expect((await page.ask(Math.random(), 'ui.importDocuments', { ndjson })).error!.code).toBe('bad_params')
    document.body.innerHTML = ''
    frame({ coll: 'big_orders' })
    const view = await iframe()
    expect((await view.ask(1, 'ui.importDocuments', { ndjson: NDJSON })).error!.code).toBe('read_only')
    document.body.innerHTML = ''
    frame({ db: 'admin' })
    const system = await iframe()
    expect((await system.ask(1, 'ui.importDocuments', { ndjson: NDJSON })).error!.code).toBe('not_permitted')
    document.body.innerHTML = ''
    frame({ may: ['documents:read', 'jobs:run'] })
    const reader = await iframe()
    expect((await reader.ask(1, 'ui.importDocuments', { ndjson: NDJSON })).error!.code).toBe('not_permitted')
    expect(useWorkspaceDialogs().current).toBeNull()
  })

  it('starts the wizard with the file it was given, named and uploaded', async () => {
    uploaded.length = 0
    mockApi({
      'POST connections/c1/transfer/uploads/u1/preview': () => [
        200,
        {
          format: 'ndjson',
          gzip: false,
          dialect: { delimiter: ',', header: true, sheet: null, encoding: 'utf-8' },
          sheets: [],
          fields: [],
          records: [{ name: 'Ada' }, { name: 'Grace' }],
          warnings: [],
        },
      ],
    })
    mountApp(ImportWizard, {
      props: {
        connectionId: 'c1',
        db: 'shop',
        coll: 'orders',
        preset: { name: 'helper-orders.ndjson', text: NDJSON, from: 'Helper (helper)' },
      },
    })
    await flushPromises()
    await flushPromises()
    expect(uploaded).toEqual([{ name: 'helper-orders.ndjson', text: NDJSON }])
    expect(document.body.textContent).toContain('Helper (helper)')
  })
})

describe('reads of the database’s other collections (§1.3)', () => {
  const INDEXES = [{ name: '_id_', key: { _id: 1 }, options: {}, usage: null }]

  it('lists another collection’s indexes only with database:read, and only one the database holds', async () => {
    frame(
      { permissions: ['documents:read', 'collection:read'] },
      {
        'GET connections/c1/databases/shop/collections/orders/indexes': () => [200, INDEXES],
        'GET connections/c1/databases/shop/collections/customers/indexes': () => [200, INDEXES],
      },
    )
    const own = await iframe()
    expect((await own.ask(1, 'indexes.list')).result).toEqual(INDEXES)
    expect((await own.ask(2, 'indexes.list', { coll: 'orders' })).result).toEqual(INDEXES)
    expect((await own.ask(3, 'indexes.list', { coll: 'customers' })).error!.code).toBe('not_permitted')
    document.body.innerHTML = ''
    const api = frame(
      { permissions: ['documents:read', 'collection:read', 'database:read'] },
      {
        'GET connections/c1/databases/shop/collections/customers/indexes': () => [200, INDEXES],
      },
    )
    const db = await iframe()
    expect((await db.ask(1, 'indexes.list', { coll: 'customers' })).result).toEqual(INDEXES)
    for (const coll of ['system.views', '__proto__', '../other', 'missing'])
      expect((await db.ask(Math.random(), 'indexes.list', { coll })).error!.code).toBe('bad_params')
    // A view's indexes are none.
    expect((await db.ask(9, 'indexes.list', { coll: 'big_orders' })).result).toEqual([])
    expect(api.calls.filter((c) => c.path.endsWith('/indexes')).map((c) => c.path)).toEqual([
      'connections/c1/databases/shop/collections/customers/indexes',
    ])
  })

  it('reads validation rules as the app’s Validation does, never a view’s', async () => {
    const rules = {
      validator: { $jsonSchema: { required: ['name'] } },
      validationLevel: 'strict',
      validationAction: 'error',
    }
    frame(
      { permissions: ['documents:read', 'collection:read', 'database:read'] },
      {
        ...NOTHING_HIDDEN,
        'GET connections/c1/databases/shop/collections/orders/validation': () => [
          200,
          { ...rules, version: 'v', kind: 'collection', serverVersion: '8.0.0' },
        ],
        'GET connections/c1/databases/shop/collections/customers/validation': () => [
          200,
          {
            validator: null,
            validationLevel: 'strict',
            validationAction: 'error',
            version: 'v',
            kind: 'collection',
            serverVersion: '8.0.0',
          },
        ],
      },
    )
    const { ask } = await iframe()
    expect((await ask(1, 'validation.get')).result).toEqual(rules)
    expect((await ask(2, 'validation.get', { coll: 'customers' })).result).toMatchObject({ validator: null })
    expect((await ask(3, 'validation.get', { coll: 'big_orders' })).result).toBeNull()
    expect((await ask(4, 'validation.get', { coll: 'nope' })).error!.code).toBe('bad_params')
    document.body.innerHTML = ''
    frame({ permissions: ['documents:read'] })
    const none = await iframe()
    expect((await none.ask(1, 'validation.get')).error!.code).toBe('not_permitted')
  })

  it('reads the database’s model once a minute, with database:read only', async () => {
    const model = {
      db: 'shop',
      sampleSize: 200,
      collections: [],
      references: [],
      skipped: 0,
      at: '2026-10-26T00:00:00Z',
    }
    const api = frame(
      { permissions: ['documents:read', 'database:read'] },
      {
        'GET connections/c1/databases/shop/model': () => [200, model],
      },
    )
    const { ask } = await iframe()
    expect((await ask(1, 'database.model')).result).toEqual(model)
    expect((await ask(2, 'database.model')).result).toEqual(model)
    expect(api.calls.filter((c) => c.path.includes('/model')).length).toBe(1)
    document.body.innerHTML = ''
    frame({ permissions: ['documents:read'] })
    const none = await iframe()
    expect((await none.ask(1, 'database.model')).error!.code).toBe('not_permitted')
  })

  it('counts definition reads apart from document reads: 120 a minute', async () => {
    frame(
      { permissions: ['documents:read', 'collection:read'] },
      {
        'GET connections/c1/databases/shop/collections/orders/indexes': () => [200, []],
        'POST connections/c1/databases/shop/collections/orders/find': () => [
          200,
          { documents: [], hasMore: false },
        ],
      },
    )
    const { ask } = await iframe()
    for (let i = 0; i < 120; i++) expect((await ask(i + 1, 'indexes.list')).result).toEqual([])
    expect((await ask(500, 'indexes.list')).error!.code).toBe('too_many')
    // The document reads' own minute is untouched.
    expect((await ask(501, 'documents.find', { limit: 1 })).result).toEqual({ documents: [], hasMore: false })
  })
})

describe('what is hidden from the user (§1.3a)', () => {
  it('tells a plugin that may read documents the hidden paths of its collection — names only', async () => {
    frame(
      {},
      {
        'GET connections/c1/personal-fields/applied': () => [
          200,
          {
            rules: [{ db: 'shop', coll: 'orders', field: 'email' }],
            patterns: [['email'], ['contact', 'phone']],
          },
        ],
      },
    )
    const { ask } = await iframe()
    const place = ((await ask(1, 'context.get')).result as { place: { hidden: unknown } }).place
    expect(place.hidden).toEqual([['email'], ['contact', 'phone']])
    document.body.innerHTML = ''
    const api = frame({ permissions: [] })
    const blind = await iframe()
    const none = ((await blind.ask(1, 'context.get')).result as { place: { hidden: unknown } }).place
    expect(none.hidden).toEqual([])
    expect(api.calls.some((c) => c.path.includes('personal-fields'))).toBe(false)
  })
})

describe('binary values in cell renderers (§1.4) and the new icons (§1.5)', () => {
  it('matches binary values but not UUIDs', () => {
    expect(PLUGIN_CELL_MATCHES).toContain('binary')
    expect(matches('binary', binary(new Uint8Array([1, 2, 3]), 0))).toBe(true)
    expect(matches('binary', binary(new Uint8Array(16), 4))).toBe(false)
    expect(matches('binary', 'x')).toBe(false)
  })

  it('sends a renderer the head of a binary value only, with its length', () => {
    const bytes = new Uint8Array(5000).map((_, i) => i % 256)
    const head = cellValue('binary', binary(bytes, 0)) as {
      $binaryHead: { base64: string; subType: string; length: number }
    }
    expect(head.$binaryHead.length).toBe(5000)
    expect(head.$binaryHead.subType).toBe('00')
    expect(atob(head.$binaryHead.base64).length).toBe(2048)
    // Any other match is sent as it is.
    const id = decodeValue({ $oid: '6ac625df13a09509ca0da14f' })
    expect(cellValue('objectId', id)).toEqual({ $oid: '6ac625df13a09509ca0da14f' })
  })

  it('draws each new icon', () => {
    for (const name of [
      'book',
      'wand',
      'shapes',
      'scroll',
      'code',
      'calendar',
      'hourglass',
      'shield',
      'fingerprint',
      'ruler',
    ] as const) {
      expect(PLUGIN_ICONS).toContain(name)
      expect(pluginIcon(name)).not.toBe(pluginIcon('puzzle'))
    }
  })
})

/** Wave 3 review: what the opus review of the branch found on the platform, each pinned. */
describe('the bridge after the wave 3 review', () => {
  const NDJSON = '{"name":"Ada"}\n'
  const saving = () => {
    const saved: string[] = []
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x')
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      saved.push(this.download)
    })
    return saved
  }

  it('asks the user before saving a file when the focus may have come from a press in the app', async () => {
    frame()
    const { ask, answer } = await iframe()
    const saved = saving()
    const toasts = useToastStore()
    pressInApp()
    const asked = ask(1, 'ui.download', { name: 'shop', type: 'markdown', text: '# Shop' })
    await flushPromises()
    expect(saved).toEqual([])
    const question = toasts.toasts.at(-1)!
    expect(question.message).toContain('Helper (helper)')
    expect(question.message).toContain('shop.md')
    // Another while it waits: one question at a time.
    expect((await ask(2, 'ui.download', { name: 'x', type: 'text', text: 'x' })).error!.code).toBe('busy')
    toasts.runAction(question.id, 0)
    await asked
    expect((await answer(1)).result).toBe(true)
    expect(saved).toEqual(['shop.md'])
    // Declined: nothing saved.
    pressInApp()
    const declined = ask(3, 'ui.download', { name: 'other', type: 'text', text: 'x' })
    await flushPromises()
    toasts.dismiss(toasts.toasts.at(-1)!.id)
    await declined
    expect((await answer(3)).error!.code).toBe('declined')
    expect(saved).toEqual(['shop.md'])
  })

  it('asks before opening the Import wizard after a press in the app, and never over an open dialog', async () => {
    frame()
    const { ask, answer } = await iframe()
    const toasts = useToastStore()
    const dialogs = useWorkspaceDialogs()
    pressInApp()
    const asked = ask(1, 'ui.importDocuments', { ndjson: NDJSON })
    await flushPromises()
    await flushPromises()
    expect(dialogs.current).toBeNull()
    const question = toasts.toasts.at(-1)!
    expect(question.message).toContain('1')
    expect(question.message).toContain('orders')
    toasts.runAction(question.id, 0)
    await asked
    expect((await answer(1)).result).toBe(true)
    expect(dialogs.current).toMatchObject({ kind: 'importData', coll: 'orders' })
    // A dialog is open: a second hand-off never replaces it.
    expect((await ask(2, 'ui.importDocuments', { ndjson: NDJSON })).error!.code).toBe('busy')
    dialogs.open({ kind: 'createDatabase', connectionId: 'c1' })
    expect((await ask(3, 'ui.importDocuments', { ndjson: NDJSON })).error!.code).toBe('busy')
    expect(dialogs.current).toEqual({ kind: 'createDatabase', connectionId: 'c1' })
  })

  it('never opens the wizard for a frame put out of sight while the collection’s kind was told', async () => {
    let tell: () => void = () => undefined
    mockApi({
      'GET plugins/helper/ticket': () => [200, BLANK],
      'GET connections': () => [200, [connection()]],
      'GET connections/c1/databases/shop/collections': () =>
        new Promise((resolve) => (tell = () => resolve([200, COLLECTIONS]))),
    })
    const { wrapper } = mountApp(PluginFrame, {
      props: {
        plugin: runtime(),
        kind: 'collectionTab',
        contribution: 'tab',
        target: { connectionId: 'c1', db: 'shop', coll: 'orders' },
      },
    })
    const { ask, answer } = await iframe()
    const asked = ask(1, 'ui.importDocuments', { ndjson: NDJSON })
    await flushPromises()
    await wrapper.setProps({ inactive: true })
    tell()
    await asked
    expect((await answer(1)).error!.code).toBe('not_visible')
    expect(useWorkspaceDialogs().current).toBeNull()
  })

  it('refuses documents past 1,000,000 characters', async () => {
    frame()
    const { ask } = await iframe()
    const big = `{"a":"${'x'.repeat(1_000_000)}"}`
    expect((await ask(1, 'ui.importDocuments', { ndjson: big })).error!.code).toMatch(/bad_params|too_large/)
    expect(useWorkspaceDialogs().current).toBeNull()
  })

  it('counts a file, documents and a query in one budget of 10 a minute', async () => {
    frame()
    const { ask } = await iframe()
    saving()
    for (let i = 0; i < 4; i++)
      expect((await ask(i + 1, 'ui.download', { name: 'x', type: 'text', text: 'x' })).result).toBe(true)
    for (let i = 0; i < 6; i++)
      expect((await ask(i + 10, 'ui.useQuery', { filter: { a: 1 } })).result).toBe(true)
    expect((await ask(20, 'ui.download', { name: 'x', type: 'text', text: 'x' })).error!.code).toBe(
      'too_many',
    )
    expect((await ask(21, 'ui.importDocuments', { ndjson: NDJSON })).error!.code).toBe('too_many')
  })

  it('never saves a file or opens the wizard from a frame out of sight', async () => {
    mockApi({
      'GET plugins/helper/ticket': () => [200, BLANK],
      'GET connections': () => [200, [connection()]],
      'GET connections/c1/databases/shop/collections': () => [200, COLLECTIONS],
    })
    mountApp(PluginFrame, {
      props: {
        plugin: runtime(),
        kind: 'collectionTab',
        contribution: 'tab',
        target: { connectionId: 'c1', db: 'shop', coll: 'orders' },
        inactive: true,
      },
    })
    const { ask } = await iframe()
    expect((await ask(1, 'ui.download', { name: 'x', type: 'text', text: 'x' })).error!.code).toBe(
      'not_visible',
    )
    expect((await ask(2, 'ui.importDocuments', { ndjson: NDJSON })).error!.code).toBe('not_visible')
  })

  it('starts one model at a time, and reads it again after a minute or after a failure', async () => {
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const model = { db: 'shop', sampleSize: 200, collections: [], references: [], skipped: 0, at: 'x' }
    let fail = true
    const api = frame(
      { permissions: ['documents:read', 'database:read'] },
      {
        'GET connections/c1/databases/shop/model': () =>
          fail ? [500, { code: 'FAILED', message: 'x' }] : [200, model],
      },
    )
    const { ask } = await iframe()
    const reads = () => api.calls.filter((c) => c.path.endsWith('/model')).length
    expect((await ask(1, 'database.model')).error).toBeDefined()
    fail = false
    // A failed read is not kept; eight at once start one.
    const answers = await Promise.all(Array.from({ length: 8 }, (_, i) => ask(i + 10, 'database.model')))
    expect(answers.every((a) => (a.result as { db: string }).db === 'shop')).toBe(true)
    expect(reads()).toBe(2)
    now += 59_000
    await ask(30, 'database.model')
    expect(reads()).toBe(2)
    now += 2_000
    await ask(31, 'database.model')
    expect(reads()).toBe(3)
  })

  it('charges a definition read for a collection name it refuses', async () => {
    frame(
      { permissions: ['documents:read', 'collection:read', 'database:read'] },
      { 'GET connections/c1/databases/shop/collections/orders/indexes': () => [200, []] },
    )
    const { ask } = await iframe()
    for (let i = 0; i < 120; i++)
      expect((await ask(i + 1, 'indexes.list', { coll: 'missing' })).error!.code).toBe('bad_params')
    expect((await ask(500, 'indexes.list')).error!.code).toBe('too_many')
  })

  it('tells a plugin what is hidden as unknown when it cannot be read, and refuses rules then', async () => {
    frame(
      { permissions: ['documents:read', 'collection:read'] },
      {
        'GET connections/c1/personal-fields/applied': () => [500, { code: 'FAILED', message: 'x' }],
        'GET connections/c1/databases/shop/collections/orders/validation': () => [
          200,
          {
            validator: { $jsonSchema: { properties: { email: { bsonType: 'string' } } } },
            validationLevel: 'strict',
            validationAction: 'error',
            version: 'v',
            kind: 'collection',
            serverVersion: '8.0.0',
          },
        ],
      },
    )
    const { ask } = await iframe()
    const place = ((await ask(1, 'context.get')).result as { place: { hidden: unknown } }).place
    expect(place.hidden).toBeNull()
    expect((await ask(2, 'validation.get')).error!.code).toBe('failed')
  })

  it('never tells what a rule says of a hidden field — only its name', async () => {
    frame(
      { permissions: ['documents:read', 'collection:read'] },
      {
        'GET connections/c1/personal-fields/applied': () => [
          200,
          { rules: [], patterns: [['email'], ['contact', 'phone'], ['cards', '**']] },
        ],
        'GET connections/c1/databases/shop/collections/orders/validation': () => [
          200,
          {
            validator: {
              $jsonSchema: {
                required: ['email', 'name'],
                properties: {
                  email: { bsonType: 'string', pattern: '^[a-z]+@corp' },
                  name: { bsonType: 'string', maxLength: 80 },
                  contact: {
                    bsonType: 'object',
                    properties: { phone: { bsonType: 'long', minimum: 5 }, city: { bsonType: 'string' } },
                  },
                  cards: { bsonType: 'array', items: { properties: { no: { bsonType: 'string' } } } },
                },
              },
              $and: [{ email: { $type: 'string' } }, { age: { $gte: 18 } }],
              'contact.phone': { $exists: true },
              $expr: { $eq: [{ $type: '$email' }, 'string'] },
            },
            validationLevel: 'strict',
            validationAction: 'error',
            version: 'v',
            kind: 'collection',
            serverVersion: '8.0.0',
          },
        ],
      },
    )
    const { ask } = await iframe()
    const rules = (await ask(1, 'validation.get')).result as { validator: Record<string, unknown> }
    const schema = rules.validator.$jsonSchema as {
      required: string[]
      properties: Record<string, Record<string, unknown>>
    }
    expect(schema.required).toEqual(['email', 'name'])
    expect(schema.properties.email).toEqual({})
    expect(schema.properties.name).toEqual({ bsonType: 'string', maxLength: 80 })
    expect((schema.properties.contact!.properties as Record<string, unknown>).phone).toEqual({})
    expect((schema.properties.contact!.properties as Record<string, unknown>).city).toEqual({
      bsonType: 'string',
    })
    expect(schema.properties.cards).toEqual({})
    expect(rules.validator.$and).toEqual([{ age: { $gte: 18 } }])
    expect(rules.validator['contact.phone']).toBeUndefined()
    expect(rules.validator.$expr).toBeUndefined()
    expect(JSON.stringify(rules)).not.toMatch(/corp|long|minimum/)
  })

  it('sends a renderer the first 2,048 bytes of a value, and all of a short one', () => {
    const bytes = new Uint8Array(5000).map((_, i) => (i * 7) % 256)
    const head = cellValue('binary', binary(bytes, 0)) as { $binaryHead: { base64: string } }
    const sent = atob(head.$binaryHead.base64)
    expect([...sent].map((c) => c.charCodeAt(0))).toEqual([...bytes.slice(0, 2048)])
    const short = cellValue('binary', binary(new Uint8Array([1, 2, 3]), 0)) as {
      $binaryHead: { base64: string; length: number }
    }
    expect(short.$binaryHead).toMatchObject({ base64: btoa('\u0001\u0002\u0003'), length: 3 })
    // A value whose buffer is larger than what it holds: only what it holds.
    const roomy = binary(new Uint8Array([9, 9]), 0) as { buffer: Uint8Array; position: number }
    const grown = { buffer: new Uint8Array([9, 9, 7, 7]), sub_type: 0, position: 2 }
    expect((cellValue('binary', grown) as { $binaryHead: { length: number } }).$binaryHead.length).toBe(2)
    expect(roomy.buffer.length).toBeGreaterThanOrEqual(2)
  })

  // Final review of the research plugins (C1): a tooltip has room for more than the 80 characters
  // beside a value — three readings of a legacy UUID (143 characters) — never for a page of text.
  it('shows a tooltip’s answer up to 200 characters, one beside the value up to 80', async () => {
    const long = `Legacy UUID · Java ${'a'.repeat(36)} · C# ${'b'.repeat(36)} · Python ${'c'.repeat(36)}`
    const bridge = {
      ask: vi.fn(async (_m: string, params: unknown) =>
        (params as { values: unknown[] }).values.map(() => ({ text: `${long}${'x'.repeat(100)}` })),
      ),
      dispose: () => undefined,
      hello: () => undefined,
      notify: () => undefined,
    }
    const plugin: PluginRuntimeView = {
      ...runtime(),
      contributes: {
        collectionTabs: [],
        documentActions: [],
        sidebarPanels: [],
        cellRenderers: [
          { id: 'beside', match: 'date', display: 'inline' },
          { id: 'tip', match: 'date', display: 'tooltip' },
        ],
      } as never,
    }
    const renderers = new Map([['helper', bridge as never]])
    const date = decodeValue({ $date: '2026-10-27T10:00:00Z' })
    cellTextsFor([plugin], renderers, date)
    await flushPromises()
    await flushPromises()
    const texts = cellTextsFor([plugin], renderers, date)
    expect(texts.find((c) => c.display === 'inline')!.text).toHaveLength(80)
    const tip = texts.find((c) => c.display === 'tooltip')!.text
    expect(tip).toHaveLength(200)
    expect(tip.startsWith(long)).toBe(true)
  })

  it('asks a renderer again when its settings change, and about an answer over a minute old', async () => {
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    let said = 'first'
    const bridge = {
      ask: vi.fn(async (_m: string, params: unknown) =>
        (params as { values: unknown[] }).values.map(() => ({ text: said })),
      ),
      dispose: () => undefined,
      hello: () => undefined,
      notify: () => undefined,
    }
    const clock = (settings: Record<string, string | boolean>): PluginRuntimeView => ({
      ...runtime(),
      settings,
      contributes: {
        collectionTabs: [],
        documentActions: [],
        sidebarPanels: [],
        cellRenderers: [{ id: 'tip', match: 'date' }],
      } as never,
    })
    const renderers = new Map([['helper', bridge as never]])
    const date = decodeValue({ $date: '2026-10-26T10:00:00Z' })
    const textOf = async (plugin: PluginRuntimeView) => {
      cellTextFor([plugin], renderers, date)
      await flushPromises()
      await flushPromises()
      return cellTextFor([plugin], renderers, date)?.text
    }
    expect(await textOf(clock({ timeZone: 'UTC' }))).toBe('first')
    said = 'second'
    expect(await textOf(clock({ timeZone: 'UTC' }))).toBe('first')
    expect(bridge.ask).toHaveBeenCalledTimes(1)
    // Other settings: asked again.
    expect(await textOf(clock({ timeZone: 'Asia/Tokyo' }))).toBe('second')
    expect(bridge.ask).toHaveBeenCalledTimes(2)
    // An answer over a minute old shows while it is asked again, then is replaced.
    said = 'third'
    now += ANSWER_TTL_MS
    expect(cellTextFor([clock({ timeZone: 'UTC' })], renderers, date)?.text).toBe('first')
    await flushPromises()
    await flushPromises()
    expect(cellTextFor([clock({ timeZone: 'UTC' })], renderers, date)?.text).toBe('third')
  })

  it('keeps a binary value’s answer under a short key, never its bytes', async () => {
    const bridge = {
      ask: vi.fn(async (_m: string, params: unknown) =>
        (params as { values: unknown[] }).values.map(() => ({ text: 'PNG image' })),
      ),
      dispose: () => undefined,
      hello: () => undefined,
      notify: () => undefined,
    }
    const plugin: PluginRuntimeView = {
      ...runtime(),
      contributes: {
        collectionTabs: [],
        documentActions: [],
        sidebarPanels: [],
        cellRenderers: [{ id: 'bin', match: 'binary' }],
      } as never,
    }
    const value = binary(
      new Uint8Array(5000).map((_, i) => i % 256),
      0,
    )
    cellTextFor([plugin], new Map([['helper', bridge as never]]), value)
    await flushPromises()
    await flushPromises()
    expect(cellTextFor([plugin], new Map([['helper', bridge as never]]), value)?.text).toBe('PNG image')
    expect(Math.max(...[...cellCache.keys()].map((k) => k.length))).toBeLessThan(200)
  })
})

/** Wave 3 second review: what the review of the fixes found on the platform. */
describe('the bridge after the second wave 3 review', () => {
  const NDJSON = '{"name":"Ada"}\n'

  it('ends its question before the page gives up, even while it is pointed at', async () => {
    frame()
    const { ask, answer } = await iframe()
    const saved: string[] = []
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x')
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      saved.push(this.download)
    })
    const toasts = useToastStore()
    pressInApp()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      const asked = ask(1, 'ui.download', { name: 'shop', type: 'markdown', text: '# Shop' })
      await flushPromises()
      const question = toasts.toasts.at(-1)!
      // Held by the pointer: its own timer stops, the question's end does not.
      toasts.hold(question.id, 'hover')
      vi.advanceTimersByTime(APP_QUESTION_MS)
      await asked
      expect((await answer(1)).error!.code).toBe('unanswered')
      expect(toasts.toasts.some((x) => x.id === question.id)).toBe(false)
      expect(saved).toEqual([])
      expect(APP_QUESTION_MS).toBeLessThan(QUESTION_TIMEOUT_MS)
    } finally {
      vi.useRealTimers()
    }
  })

  it('ends a change’s confirmation the same way', async () => {
    const store = useDialogStore()
    const deadline = new AbortController()
    const decided = store.confirm({ title: 't', message: 'm', signal: deadline.signal })
    expect(store.current).not.toBeNull()
    deadline.abort()
    await expect(decided).resolves.toBe(false)
    expect(store.current).toBeNull()
    // Already over: never shown.
    await expect(store.confirm({ title: 't', message: 'm', signal: AbortSignal.abort() })).resolves.toBe(
      false,
    )
    expect(store.current).toBeNull()
  })

  it('decides to ask when the request comes, not after a slow read of the collection’s kind', async () => {
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    let tell: () => void = () => undefined
    mockApi({
      'GET plugins/helper/ticket': () => [200, BLANK],
      'GET connections': () => [200, [connection()]],
      'GET connections/c1/databases/shop/collections': () =>
        new Promise((resolve) => (tell = () => resolve([200, COLLECTIONS]))),
    })
    mountApp(PluginFrame, {
      props: {
        plugin: runtime(),
        kind: 'collectionTab',
        contribution: 'tab',
        target: { connectionId: 'c1', db: 'shop', coll: 'orders' },
      },
    })
    const { ask } = await iframe()
    pressInApp()
    const asked = ask(1, 'ui.importDocuments', { ndjson: NDJSON })
    await flushPromises()
    now += 6_000
    tell()
    await asked
    await flushPromises()
    expect(useWorkspaceDialogs().current).toBeNull()
    expect(useToastStore().toasts.at(-1)!.message).toMatch(/with 1 document\. Open it\?$/)
  })

  it('leaves out what any rule says of a hidden field: by pattern, by a parent, by a variable', () => {
    const hidden = [['profile', 'ssn']]
    const out = rulesWithoutHidden(
      {
        $jsonSchema: {
          properties: {
            profile: {
              bsonType: 'object',
              enum: [{ ssn: 'x' }],
              patternProperties: { '^s': { bsonType: 'string', pattern: '^[0-9]+$' } },
              additionalProperties: { bsonType: 'string', minLength: 9 },
              dependencies: { ssn: { properties: { kind: { enum: ['national'] } } } },
              properties: { name: { bsonType: 'string' } },
            },
            age: { bsonType: 'int', minimum: 18 },
          },
        },
        profile: { $eq: { ssn: 'x' } },
        $expr: { $gt: [{ $strLenCP: '$$ROOT.profile.ssn' }, 5] },
        $and: [{ $expr: { $eq: [{ $getField: { field: 'ssn', input: '$profile' } }, 'x'] } }],
      },
      hidden,
    ) as Record<string, unknown>
    const profile = (out.$jsonSchema as { properties: Record<string, Record<string, unknown>> }).properties
      .profile!
    expect(profile.enum).toBeUndefined()
    expect(profile.patternProperties).toBeUndefined()
    expect(profile.additionalProperties).toBeUndefined()
    expect(profile.dependencies).toBeUndefined()
    expect(profile.properties).toEqual({ name: { bsonType: 'string' } })
    expect((out.$jsonSchema as { properties: Record<string, unknown> }).properties.age).toEqual({
      bsonType: 'int',
      minimum: 18,
    })
    expect(out.profile).toBeUndefined()
    expect(out.$expr).toBeUndefined()
    expect(out.$and).toBeUndefined()
    // Nothing hidden: kept whole.
    const whole = { $expr: { $eq: ['$$ROOT.a', 1] } }
    expect(rulesWithoutHidden(whole, [])).toBe(whole)
  })

  it('keeps a shown answer when asking again about it fails', async () => {
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    let fail = false
    const bridge = {
      ask: vi.fn(async (_m: string, params: unknown) => {
        if (fail) throw new Error('timeout')
        return (params as { values: unknown[] }).values.map(() => ({ text: 'kept' }))
      }),
      dispose: () => undefined,
      hello: () => undefined,
      notify: () => undefined,
    }
    const plugin: PluginRuntimeView = {
      ...runtime(),
      contributes: {
        collectionTabs: [],
        documentActions: [],
        sidebarPanels: [],
        cellRenderers: [{ id: 'tip', match: 'date' }],
      } as never,
    }
    const renderers = new Map([['helper', bridge as never]])
    const date = decodeValue({ $date: '2026-10-26T10:00:00Z' })
    cellTextFor([plugin], renderers, date)
    await flushPromises()
    await flushPromises()
    expect(cellTextFor([plugin], renderers, date)?.text).toBe('kept')
    fail = true
    now += ANSWER_TTL_MS
    cellTextFor([plugin], renderers, date)
    await flushPromises()
    await flushPromises()
    expect(bridge.ask).toHaveBeenCalledTimes(2)
    expect(cellTextFor([plugin], renderers, date)?.text).toBe('kept')
  })

  it('keeps a model read that runs past a minute, and times the minute from its answer', async () => {
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const model = { db: 'shop', sampleSize: 200, collections: [], references: [], skipped: 0, at: 'x' }
    let tell: () => void = () => undefined
    const api = frame(
      { permissions: ['documents:read', 'database:read'] },
      {
        'GET connections/c1/databases/shop/model': () =>
          new Promise((resolve) => (tell = () => resolve([200, model]))),
      },
    )
    const { ask, answer } = await iframe()
    const reads = () => api.calls.filter((c) => c.path.endsWith('/model')).length
    const first = ask(1, 'database.model')
    await flushPromises()
    now += 61_000
    const second = ask(2, 'database.model')
    await flushPromises()
    expect(reads()).toBe(1)
    tell()
    await Promise.all([first, second])
    expect(((await answer(2)).result as { db: string }).db).toBe('shop')
    now += 59_000
    await ask(3, 'database.model')
    expect(reads()).toBe(1)
  })
})

/** Wave 3 third review: what the review of the second round found on the platform. */
describe('the bridge after the third wave 3 review', () => {
  it('tells an unanswered question apart from a no, and never blocks a plugin for it', async () => {
    frame()
    const { ask, answer } = await iframe()
    const toasts = useToastStore()
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x')
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    pressInApp()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      const asked = ask(1, 'ui.download', { name: 'shop', type: 'markdown', text: '# Shop' })
      await flushPromises()
      toasts.hold(toasts.toasts.at(-1)!.id, 'hover')
      vi.advanceTimersByTime(APP_QUESTION_MS)
      await asked
      expect((await answer(1)).error!.code).toBe('unanswered')
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves out an operator beside $elemMatch, and one inside it, on a field holding a hidden one', () => {
    const out = rulesWithoutHidden(
      {
        profile: { $elemMatch: { name: { $type: 'string' } }, $in: [{ ssn: 'x' }] },
        contacts: { $elemMatch: { $eq: { phone: '5' } } },
        tags: { $elemMatch: { $eq: 'a' } },
      },
      [
        ['profile', 'ssn'],
        ['contacts', 'phone'],
      ],
    )
    expect(out).toEqual({
      profile: { $elemMatch: { name: { $type: 'string' } } },
      tags: { $elemMatch: { $eq: 'a' } },
    })
  })

  // Research plugins' review (I2): a rule wholly about a hidden field is left out, never left as {}
  // — which in $nor refuses every document, and in $or lets every one through.
  it('leaves out a clause wholly about a hidden field, and an $or one of whose clauses is', () => {
    const hidden = [['email']]
    expect(rulesWithoutHidden({ $nor: [{ email: 'x@y' }, { status: 'banned' }] }, hidden)).toEqual({
      $nor: [{ status: 'banned' }],
    })
    expect(rulesWithoutHidden({ $nor: [{ email: 'x@y' }] }, hidden)).toEqual({})
    expect(
      rulesWithoutHidden({ $and: [{ email: { $exists: true } }, { age: { $gte: 18 } }] }, hidden),
    ).toEqual({
      $and: [{ age: { $gte: 18 } }],
    })
    // Whether a document meets an $or with a hidden branch cannot be told: it is not checked.
    expect(
      rulesWithoutHidden({ $or: [{ email: { $exists: true } }, { phone: { $exists: true } }], a: 1 }, hidden),
    ).toEqual({
      a: 1,
    })
    // A clause the validator itself wrote as {} stays as written.
    expect(rulesWithoutHidden({ $and: [{}, { a: 1 }] }, hidden)).toEqual({ $and: [{}, { a: 1 }] })
  })

  it('leaves additional properties out with the pattern properties they go with', () => {
    const schema = {
      $jsonSchema: {
        properties: { email: { bsonType: 'string' }, name: {} },
        patternProperties: { '^x_': { bsonType: 'int' } },
        additionalProperties: false,
      },
    }
    const out = rulesWithoutHidden(schema, [['email']]) as { $jsonSchema: Record<string, unknown> }
    expect(out.$jsonSchema.patternProperties).toBeUndefined()
    expect(out.$jsonSchema.additionalProperties).toBeUndefined()
    expect(out.$jsonSchema.properties).toEqual({ email: {}, name: {} })
  })

  it('keeps an expression reading only the system’s variables', () => {
    const now = { $expr: { $lte: ['$createdAt', '$$NOW'] } }
    expect(rulesWithoutHidden(now, [['email']])).toEqual(now)
    expect(rulesWithoutHidden({ $expr: { $eq: ['$$ROOT.email', 'x'] } }, [['email']])).toEqual({})
    expect(rulesWithoutHidden({ $expr: { $let: { vars: { v: 1 }, in: '$$v' } } }, [['email']])).toEqual({})
  })

  it('reads the model again when a read hangs past a minute', async () => {
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const api = frame(
      { permissions: ['documents:read', 'database:read'] },
      { 'GET connections/c1/databases/shop/model': () => new Promise(() => undefined) },
    )
    const { ask } = await iframe()
    const reads = () => api.calls.filter((c) => c.path.endsWith('/model')).length
    void ask(1, 'database.model')
    await flushPromises()
    now += 30_000
    void ask(2, 'database.model')
    await flushPromises()
    expect(reads()).toBe(1)
    now += 31_000
    void ask(3, 'database.model')
    await flushPromises()
    // Still running at 61 seconds: shared (the server's own limit is 60).
    expect(reads()).toBe(1)
    now += 30_000
    void ask(4, 'database.model')
    await flushPromises()
    expect(reads()).toBe(2)
  })

  it('asks before the wizard when the app was pressed while the collection’s kind was read', async () => {
    let tell: () => void = () => undefined
    mockApi({
      'GET plugins/helper/ticket': () => [200, BLANK],
      'GET connections': () => [200, [connection()]],
      'GET connections/c1/databases/shop/collections': () =>
        new Promise((resolve) => (tell = () => resolve([200, COLLECTIONS]))),
    })
    mountApp(PluginFrame, {
      props: {
        plugin: runtime(),
        kind: 'collectionTab',
        contribution: 'tab',
        target: { connectionId: 'c1', db: 'shop', coll: 'orders' },
      },
    })
    const { ask } = await iframe()
    const asked = ask(1, 'ui.importDocuments', { ndjson: '{"a":1}\n' })
    await flushPromises()
    pressInApp()
    tell()
    await asked
    await flushPromises()
    expect(useWorkspaceDialogs().current).toBeNull()
    expect(useToastStore().toasts.at(-1)!.message).toContain('Import wizard')
  })

  it('lets a stale answer stay a few minutes at most, and clears one the renderer asked to be asked again', async () => {
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    let mode: 'answer' | 'fail' | 'retry' = 'answer'
    const bridge = {
      ask: vi.fn(async (_m: string, params: unknown) => {
        if (mode === 'fail') throw new Error('timeout')
        return (params as { values: unknown[] }).values.map(() =>
          mode === 'retry' ? { retry: true } : { text: 'kept' },
        )
      }),
      dispose: () => undefined,
      hello: () => undefined,
      notify: () => undefined,
    }
    const plugin: PluginRuntimeView = {
      ...runtime(),
      contributes: {
        collectionTabs: [],
        documentActions: [],
        sidebarPanels: [],
        cellRenderers: [{ id: 'tip', match: 'date' }],
      } as never,
    }
    const renderers = new Map([['helper', bridge as never]])
    const date = decodeValue({ $date: '2026-10-26T10:00:00Z' })
    const look = async () => {
      cellTextFor([plugin], renderers, date)
      await flushPromises()
      await flushPromises()
      return cellTextFor([plugin], renderers, date)?.text ?? null
    }
    expect(await look()).toBe('kept')
    mode = 'fail'
    for (let i = 0; i < 4; i++) {
      now += ANSWER_TTL_MS
      expect(await look()).toBe('kept')
    }
    // Past five minutes without a good answer: gone.
    now += ANSWER_TTL_MS + 1
    await look()
    expect(cellTextFor([plugin], renderers, date)).toBeNull()
    // A renderer asking to be asked again: cleared at once.
    mode = 'answer'
    now += RETRY_MS + 1
    expect(await look()).toBe('kept')
    mode = 'retry'
    now += ANSWER_TTL_MS
    await look()
    expect(cellTextFor([plugin], renderers, date)).toBeNull()
  })
})

describe('a cell renderer’s text, cut', () => {
  it('is cut by characters, never inside one: an emoji stays whole', () => {
    const emoji = String.fromCodePoint(0x1f600)
    const text = cellText({ text: emoji.repeat(300) }, 'p')!.text
    expect([...text]).toHaveLength(200)
    expect([...text].every((c) => c === emoji)).toBe(true)
  })
})
