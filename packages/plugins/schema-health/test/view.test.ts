// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Accent, PluginClient, PluginContext } from '../../kit/src/client'
import { AskError } from '../../kit/src/client'
import { mount } from '../src/view'

const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0))
}
const int = (n: number) => ({ $numberInt: String(n) })

type Params = { pipeline: Array<Record<string, unknown>> }
type Handler = (params: Params) => unknown

/** A plugin client answering from `handlers`; `greet` plays the app's greeting. */
function fakeClient(place: PluginContext['place'], handlers: Record<string, Handler>) {
  const calls: Array<{ method: string; params: Params }> = []
  let ready: (() => void) | null = null
  const contexts: Array<(l: string, t: 'light' | 'dark', a: Accent) => void> = []
  const client: PluginClient = {
    contribution: { kind: 'collectionTab', id: 'health' },
    ask: async <T>(method: string, params?: unknown) => {
      calls.push({ method, params: params as Params })
      if (method === 'context.get')
        return {
          plugin: { id: 'schema-health', version: '1' },
          contribution: { kind: 'collectionTab', id: 'health' },
          locale: 'en',
          theme: 'light',
          accent: 'violet',
          place,
          settings: {},
        } as T
      return (await handlers[method]!(params as Params)) as T
    },
    onReady: (fn) => (ready = fn),
    onContext: (fn) => contexts.push(fn),
    onCells: () => {},
  }
  return { client, calls, greet: () => ready!(), contexts }
}

const PLACE = { connectionId: 'c', connectionName: 'Shop', db: 'shop', coll: 'orders', documentId: null }
const ORDERS = [
  { _id: int(1), total: int(10), tags: Array.from({ length: 1500 }, () => 'x') },
  { _id: int(2), total: int(12) },
  { _id: int(3), total: '14' },
]
const SIZES = { count: int(3), avg: int(900), max: int(9_000_000), over1mb: int(1), over8mb: int(1) }
const CLEAN_SIZES = { count: int(3), avg: int(90), max: int(120), over1mb: int(0), over8mb: int(0) }
const INDEXES = [
  { name: '_id_', key: { _id: int(1) }, options: {}, usage: { ops: 5, since: '2026-10-01T00:00:00.000Z' } },
  {
    name: 'city_1',
    key: { city: int(1) },
    options: {},
    usage: { ops: 0, since: '2026-10-01T00:00:00.000Z' },
  },
]
/** Answers the sample, then the sizes (the pipeline that measures). */
const aggregate =
  (docs: unknown[], sizes: unknown = SIZES): Handler =>
  (p) =>
    p.pipeline.length === 1 ? { documents: docs } : { documents: [sizes] }

const app = () => document.getElementById('app')!
const check = () => document.getElementById('check') as HTMLButtonElement
const cards = () => [...document.querySelectorAll<HTMLElement>('[data-finding]')]

beforeEach(() => {
  document.body.replaceChildren(Object.assign(document.createElement('div'), { id: 'app' }))
})

describe('schema health, redesigned (plugin tabs redesign §2.7)', () => {
  it('checks on opening, with skeletons while it reads', async () => {
    let giveSample!: (v: unknown) => void
    const { client, greet } = fakeClient(PLACE, {
      'documents.aggregate': (p) =>
        p.pipeline.length === 1 ? new Promise((r) => (giveSample = r)) : { documents: [SIZES] },
      'indexes.list': () => INDEXES,
    })
    mount(app(), client)
    greet()
    await flush()
    expect(document.querySelector('.mm-skeleton')).not.toBeNull()
    expect(check().disabled).toBe(true)
    giveSample({ documents: ORDERS })
    await flush()
    expect(document.querySelector('.mm-skeleton')).toBeNull()
    expect(cards().length).toBeGreaterThan(0)
    expect(check().disabled).toBe(false)
    expect(check().textContent).toBe('Check')
  })

  it('groups the findings by severity, the most serious first, and counts them', async () => {
    const { client, greet } = fakeClient(PLACE, {
      'documents.aggregate': aggregate(ORDERS),
      'indexes.list': () => INDEXES,
    })
    mount(app(), client)
    greet()
    await flush()
    const groups = [...document.querySelectorAll<HTMLElement>('[data-severity-group]')]
    expect(groups.map((g) => g.dataset.severityGroup)).toEqual(['high', 'warning', 'info'])
    expect(groups[0]!.querySelector('[data-finding="largeDocuments"]')).not.toBeNull()
    expect(groups[1]!.querySelector('[data-finding="largeArray"]')!.textContent).toContain('tags')
    expect(
      [...groups[2]!.querySelectorAll('[data-finding]')].map((c) => (c as HTMLElement).dataset.finding),
    ).toEqual(['mixedTypes', 'unusedIndex'])
    const badges = [...document.querySelectorAll('#summary .mm-badge')].map((b) => b.textContent)
    expect(badges).toEqual(['1 high risk', '1 warning', '2 info'])
    expect(document.getElementById('status')!.textContent).toBe(
      '3 documents sampled · 3 measured for size · 2 indexes',
    )
  })

  it('says what was found, why it matters and what to do, the field in mono', async () => {
    const { client, greet } = fakeClient(PLACE, {
      'documents.aggregate': aggregate(ORDERS),
      'indexes.list': () => INDEXES,
    })
    mount(app(), client)
    greet()
    await flush()
    const mixed = document.querySelector('[data-finding="mixedTypes"]')!
    expect(mixed.querySelector('.mm-mono')!.textContent).toBe('total')
    expect(mixed.textContent).toContain('number in 2 sampled documents, string in 1')
    expect(mixed.textContent).toContain('Why it matters')
    expect(mixed.textContent).toContain('What to do')
    expect(document.querySelector('[data-finding="unusedIndex"] .mm-mono')!.textContent).toBe('city_1')
  })

  it('shows the documents a finding is about in Documents, only where it can select them', async () => {
    const used = vi.fn(() => true)
    const { client, greet } = fakeClient(PLACE, {
      'documents.aggregate': aggregate(ORDERS),
      'indexes.list': () => INDEXES,
      'ui.useQuery': used,
    })
    mount(app(), client)
    greet()
    await flush()
    const show = (kind: string) =>
      document.querySelector<HTMLButtonElement>(`[data-finding="${kind}"] [data-show]`)
    expect(show('unusedIndex')).toBeNull()
    show('mixedTypes')!.click()
    await flush()
    expect(used).toHaveBeenCalledWith({ filter: { total: { $type: 'string' } } })
    show('largeArray')!.click()
    await flush()
    expect(used).toHaveBeenLastCalledWith({ filter: { 'tags.1000': { $exists: true } } })
  })

  it('says so when nothing was found', async () => {
    const { client, greet } = fakeClient(PLACE, {
      'documents.aggregate': aggregate([{ a: int(1) }, { a: int(2) }, { a: int(3) }], CLEAN_SIZES),
      'indexes.list': () => INDEXES.slice(0, 1),
    })
    mount(app(), client)
    greet()
    await flush()
    expect(cards()).toHaveLength(0)
    expect(app().textContent).toContain('No problems found in 3 sampled documents')
    expect(document.querySelector('#summary .mm-badge-success')).not.toBeNull()
  })

  // User request 2026-10-10: on a view, which has no indexes of its own, none are read or counted.
  it('reads and counts no indexes on a view', async () => {
    const { client, greet, calls } = fakeClient(
      { ...PLACE, view: true },
      {
        'documents.aggregate': aggregate([{ a: int(1) }, { a: int(2) }, { a: int(3) }], CLEAN_SIZES),
        'indexes.list': () => [],
      },
    )
    mount(app(), client)
    greet()
    await flush()
    expect(calls.filter((c) => c.method === 'indexes.list')).toHaveLength(0)
    expect(app().textContent).not.toMatch(/ 0 indexes/)
    expect(app().textContent).toContain('No problems found in 3 sampled documents')
    // Review M2: nothing it says claims indexes were checked.
    expect(app().textContent).not.toMatch(/index/i)
  })

  it('shows a field name as text, never as markup', async () => {
    const evil = '<img src=x onerror=alert(1)>'
    const { client, greet } = fakeClient(PLACE, {
      'documents.aggregate': aggregate([{ [evil]: int(1) }, { [evil]: 'x' }], CLEAN_SIZES),
      'indexes.list': () => [],
    })
    mount(app(), client)
    greet()
    await flush()
    expect(document.querySelector('img')).toBeNull()
    expect(document.querySelector('[data-finding="mixedTypes"]')!.textContent).toContain(evil)
  })

  it('keeps what it found when the sizes or the indexes cannot be read, and says why', async () => {
    const { client, greet } = fakeClient(PLACE, {
      'documents.aggregate': (p) => {
        if (p.pipeline.length === 1) return { documents: ORDERS }
        throw new Error('$bsonSize unknown')
      },
      'indexes.list': () => {
        throw new AskError('not_permitted', 'no')
      },
    })
    mount(app(), client)
    greet()
    await flush()
    expect(document.querySelector('[data-finding="mixedTypes"]')).not.toBeNull()
    const notes = [...document.querySelectorAll('.mm-callout-warning')].map((n) => n.textContent)
    expect(notes.join(' ')).toContain('The sizes could not be measured')
    expect(notes.join(' ')).toContain('The plugin is not allowed to do this.')
    expect(document.getElementById('status')!.textContent).toBe('3 documents sampled')
  })

  it('says why the check could not run, and runs again on Check', async () => {
    let fail = true
    const { client, greet, calls } = fakeClient(PLACE, {
      'documents.aggregate': (p) => {
        if (fail) throw new AskError('timeout', 'No answer')
        return aggregate(ORDERS)(p)
      },
      'indexes.list': () => INDEXES,
    })
    mount(app(), client)
    greet()
    await flush()
    expect(document.querySelector('.mm-empty-danger')!.textContent).toContain(
      'The app did not answer in time.',
    )
    fail = false
    check().click()
    await flush()
    expect(cards().length).toBeGreaterThan(0)
    expect(calls.filter((c) => c.method === 'indexes.list')).toHaveLength(1)
  })

  it('shows only the latest check when an earlier one answers late', async () => {
    const answers: Array<(v: unknown) => void> = []
    const { client, greet, calls } = fakeClient(PLACE, {
      'documents.aggregate': (p) =>
        p.pipeline.length === 1 ? new Promise((r) => answers.push(r)) : { documents: [CLEAN_SIZES] },
      'indexes.list': () => [],
    })
    mount(app(), client)
    greet()
    await flush()
    // The first check is still out; a second one starts (as a click after a failure would).
    ;(check() as HTMLButtonElement).disabled = false
    check().click()
    await flush()
    answers[1]!({ documents: [{ a: int(1) }] })
    await flush()
    answers[0]!({ documents: ORDERS })
    await flush()
    expect(cards()).toHaveLength(0)
    expect(app().textContent).toContain('No problems found in 1 sampled document')
    // The earlier check stopped there: it did not go on to measure sizes nobody would see.
    expect(
      calls.filter((c) => c.method === 'documents.aggregate' && c.params.pipeline.length > 1),
    ).toHaveLength(1)
  })

  it('folds the thresholds it checks against', async () => {
    const { client, greet } = fakeClient(PLACE, {
      'documents.aggregate': aggregate(ORDERS),
      'indexes.list': () => INDEXES,
    })
    mount(app(), client)
    greet()
    await flush()
    const details = document.querySelector('details')!
    expect(details.open).toBe(false)
    expect(details.querySelector('summary')!.textContent).toBe('What is checked')
    expect(details.textContent).toContain('Arrays of more than 1,000 elements')
  })

  it('follows the app’s language and accent', async () => {
    const { client, greet, contexts } = fakeClient(PLACE, {
      'documents.aggregate': aggregate(ORDERS),
      'indexes.list': () => INDEXES,
    })
    mount(app(), client)
    greet()
    await flush()
    expect(document.documentElement.dataset.accent).toBe('violet')
    expect(document.querySelector('.mm-head-desc')!.textContent).toContain('orders')
    contexts[0]!('tr', 'dark', 'rose')
    expect(document.documentElement.dataset.accent).toBe('rose')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(document.querySelector('h1')!.textContent).toBe('Şema sağlığı')
    expect(check().textContent).toBe('Denetle')
    const badges = [...document.querySelectorAll('#summary .mm-badge')].map((b) => b.textContent)
    expect(badges).toEqual(['1 yüksek risk', '1 uyarı', '2 bilgi'])
    expect(document.querySelector('[data-finding="mixedTypes"]')!.textContent).toContain('Neden önemli')
  })

  it('says in the new language why the sizes or the indexes could not be read', async () => {
    const { client, greet, contexts } = fakeClient(PLACE, {
      'documents.aggregate': (p) => {
        if (p.pipeline.length === 1) return { documents: ORDERS }
        throw new AskError('timeout', 'No answer')
      },
      'indexes.list': () => {
        throw new AskError('not_permitted', 'no')
      },
    })
    mount(app(), client)
    greet()
    await flush()
    const notes = () =>
      [...document.querySelectorAll('.mm-callout-warning')].map((n) => n.textContent).join(' ')
    expect(notes()).toContain('The app did not answer in time.')
    contexts[0]!('tr', 'light', 'violet')
    expect(notes()).toContain('Boyutlar ölçülemedi')
    expect(notes()).toContain('Boyutları MongoDB 4.4 ve sonrası ölçebilir. Uygulama zamanında yanıt vermedi.')
    expect(notes()).toContain('İndeksler okunamadı')
    expect(notes()).toContain('Eklentinin bunu yapmasına izin verilmiyor.')
    expect(notes()).not.toMatch(/did not answer|not allowed/)
  })

  it('says what it is reading in the new language when the language changes mid-check', async () => {
    let giveSample!: (v: unknown) => void
    const { client, greet, contexts } = fakeClient(PLACE, {
      'documents.aggregate': (p) =>
        p.pipeline.length === 1 ? new Promise((r) => (giveSample = r)) : { documents: [SIZES] },
      'indexes.list': () => INDEXES,
    })
    mount(app(), client)
    greet()
    await flush()
    const status = () => document.getElementById('status')!.textContent
    expect(status()).toBe('Sampling documents…')
    contexts[0]!('tr', 'light', 'violet')
    expect(status()).toBe('Belgelerden örnek alınıyor…')
    expect(document.querySelector('.mm-skeleton')).not.toBeNull()
    expect(check().disabled).toBe(true)
    giveSample({ documents: ORDERS })
    await flush()
    expect(status()).toBe('3 belge örneklendi · 3 belgenin boyutu ölçüldü · 2 indeks')
    expect(check().disabled).toBe(false)
  })

  it('keeps a failed Show in Documents on screen through a language change, in the new language', async () => {
    const { client, greet, contexts } = fakeClient(PLACE, {
      'documents.aggregate': aggregate(ORDERS),
      'indexes.list': () => INDEXES,
      'ui.useQuery': () => {
        throw new AskError('not_visible', 'hidden')
      },
    })
    mount(app(), client)
    greet()
    await flush()
    document.querySelector<HTMLButtonElement>('[data-finding="mixedTypes"] [data-show]')!.click()
    await flush()
    const danger = () => document.querySelector('.mm-callout-danger')?.textContent ?? ''
    expect(danger()).toContain('Could not open Documents: This cannot be done from here.')
    contexts[0]!('tr', 'light', 'violet')
    expect(danger()).toContain('Belgeler açılamadı: Bu, buradan yapılamaz.')
    // A new check starts afresh.
    check().click()
    await flush()
    expect(danger()).toBe('')
  })

  it('does not say there is no collection when the language changes before the app answers', async () => {
    const { client, contexts } = fakeClient(PLACE, {})
    mount(app(), client)
    contexts[0]!('tr', 'light', 'violet')
    expect(app().textContent).not.toContain('Denetlemek için bir koleksiyon açın.')
  })

  it('says to open a collection where there is none, and reads nothing', async () => {
    const { client, greet, calls } = fakeClient(null, {})
    mount(app(), client)
    greet()
    await flush()
    expect(app().textContent).toContain('Open a collection to check it.')
    expect(check().disabled).toBe(true)
    expect(calls.map((c) => c.method)).toEqual(['context.get'])
  })
})
