// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import type { Accent, PluginClient, PluginContext } from '../../kit/src/client'
import { AskError } from '../../kit/src/client'
import { LANGUAGES, formatNumber, pick, shown, type Language } from '../../kit/src/ui'
import { mount, SAMPLE, TEXTS } from '../src/view'

const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0))
}
type Params = { pipeline?: Array<Record<string, unknown>>; limit?: number; id?: unknown }
type Handler = (params: Params) => unknown

/** As the app: one pipeline of a frame at a time, a second refused while one runs ("busy"). */
function fakeClient(place: PluginContext['place'], handlers: Record<string, Handler>) {
  const calls: Array<{ method: string; params: Params }> = []
  let ready: (() => void) | null = null
  let aggregating = false
  const contexts: Array<(l: string, t: 'light' | 'dark', a: Accent) => void> = []
  const client: PluginClient = {
    contribution: { kind: 'collectionTab', id: 'size' },
    ask: async <T>(method: string, params?: unknown) => {
      calls.push({ method, params: params as Params })
      if (method === 'context.get')
        return {
          plugin: { id: 'document-size', version: '1' },
          contribution: { kind: 'collectionTab', id: 'size' },
          locale: 'en',
          theme: 'light',
          accent: 'violet',
          place,
          settings: {},
        } as T
      if (method === 'ui.keepOpen') return true as T
      if (method !== 'documents.aggregate') return (await handlers[method]!(params as Params)) as T
      if (aggregating) throw new AskError('busy', 'Its last pipeline is still running')
      aggregating = true
      try {
        return (await handlers[method]!(params as Params)) as T
      } finally {
        aggregating = false
      }
    },
    onReady: (fn) => (ready = fn),
    onContext: (fn) => contexts.push(fn),
    onCells: () => {},
  }
  return { client, calls, greet: () => ready!(), contexts }
}

const int = (n: number) => ({ $numberInt: String(n) })
const PLACE = {
  connectionId: 'c',
  connectionName: 'Shop',
  db: 'shop',
  coll: 'orders',
  documentId: null,
  hidden: [],
}
/** 1,000 orders: 5 KB each on average, the largest 9 MB, most of it in their items. */
const ROOT = {
  stats: [{ _id: null, n: int(1000), total: int(5_120_000), max: int(9 * 1024 * 1024), names: int(50_000) }],
  spread: [
    { _id: int(0), n: int(100) },
    { _id: int(1024), n: int(500) },
    { _id: int(4096), n: int(399) },
    { _id: int(4194304), n: int(1) },
  ],
  largest: [
    { _id: { $oid: '65a1b2c3d4e5f60718293a4b' }, size: int(9 * 1024 * 1024) },
    { _id: int(7), size: int(40_000) },
  ],
  fields: [
    {
      _id: 'items',
      total: int(4_000_000),
      docs: int(1000),
      max: int(9_000_000),
      types: ['array'],
      elements: { $numberDouble: '12.5' },
    },
    { _id: 'address', total: int(600_000), docs: int(990), max: int(900), types: ['object'], elements: null },
    {
      _id: 'customerReferenceIdentifier',
      total: int(400_000),
      docs: int(1000),
      max: int(400),
      types: ['string'],
      elements: null,
    },
    { _id: 'odd.key', total: int(100), docs: int(1), max: int(100), types: ['object'], elements: null },
  ],
}
const ADDRESS = {
  stats: [{ _id: null, n: int(990), total: int(600_000), max: int(900), names: int(5_000) }],
  spread: [{ _id: int(0), n: int(990) }],
  largest: [{ _id: int(3), size: int(900) }],
  fields: [
    { _id: 'street', total: int(300_000), docs: int(990), max: int(400), types: ['string'], elements: null },
  ],
}
const answering = (byLevel: (pipeline: Array<Record<string, unknown>>) => unknown) => ({
  'documents.aggregate': (p: Params) => ({ documents: [byLevel(p.pipeline!)] }),
  'ui.openDocument': () => true,
})
const levelOf = (pipeline: Array<Record<string, unknown>>) => {
  const match = pipeline.find((s) => '$match' in s) as
    { $match: { $expr: { $eq: [{ $type: string }] } } } | undefined
  return match ? match.$match.$expr.$eq[0].$type.slice(1) : ''
}
const app = () => document.getElementById('app')!
const row = (field: string) => document.querySelector<HTMLTableRowElement>(`[data-field="${field}"]`)!
const notes = () => document.getElementById('notes')!.textContent!
const aggregates = (calls: Array<{ method: string; params: Params }>) =>
  calls.filter((c) => c.method === 'documents.aggregate')
const scopeButton = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('#scope button')].find((b) => b.textContent === label)!

beforeEach(() => {
  document.body.replaceChildren(Object.assign(document.createElement('div'), { id: 'app' }))
})

async function mounted(handlers: Record<string, Handler>, place: PluginContext['place'] = PLACE) {
  const f = fakeClient(place, handlers)
  mount(app(), f.client)
  f.greet()
  await flush()
  return f
}

describe('the Document size tab', () => {
  it('measures a random sample on opening: the spread, where the bytes go, the largest', async () => {
    const { calls } = await mounted(answering(() => ROOT))
    const read = aggregates(calls)[0]!.params
    expect(read.pipeline![0]).toEqual({ $sample: { size: SAMPLE } })
    expect(read.limit).toBe(1)
    expect(calls.some((c) => c.method === 'ui.keepOpen')).toBe(true)
    expect(document.getElementById('status')!.textContent).toBe(
      '1,000 documents · 5 KB on average · 9 MB the largest · 4.9 MB in all',
    )
    const spread = [...document.querySelectorAll('#spread li')].map((li) => li.textContent)
    expect(spread[0]).toBe('< 1 KB100 documents')
    expect(spread[7]).toBe('4–16 MB1 document')
    expect(row('items').textContent).toContain('≈ 12.5 elements')
    expect(row('items').textContent).toContain('78.1%')
    expect(row('address').textContent).toContain('99%')
    expect(row('customerReferenceIdentifier').textContent).toContain('29 B each')
    expect(document.getElementById('largest')!.textContent).toContain('65a1b2c3d4e5f60718293a4b')
    expect(document.getElementById('largest')!.textContent).toContain('56.3%')
    const open = document.querySelector<HTMLButtonElement>('#largest [data-open="0"]')!
    expect(open.getAttribute('aria-label')).toContain('Open the document')
    expect(open.getAttribute('aria-label')).toContain('65a1b2c3d4e5f60718293a4b')
    expect(notes()).toContain('A random sample of 1,000 documents: the largest of all may not be in it.')
  })

  it('says all documents were measured when the collection is smaller than the sample', async () => {
    await mounted(
      answering(() => ({ ...ROOT, stats: [{ n: int(1), total: int(500), max: int(500), names: int(10) }] })),
    )
    expect(notes()).toContain('All 1 document is measured.')
    expect(notes()).not.toContain('random sample')
  })

  it('warns near the 16 MB limit, and when field names take much of the bytes', async () => {
    await mounted(answering(() => ROOT))
    expect(notes()).toContain('The largest document is 9 MB: 56.3% of MongoDB’s 16 MB limit')
    expect(document.querySelector('#notes .mm-callout-warning')).not.toBeNull()
    const names = {
      ...ROOT,
      stats: [{ _id: null, n: int(10), total: int(1000), max: int(200), names: int(260) }],
    }
    document.body.replaceChildren(Object.assign(document.createElement('div'), { id: 'app' }))
    await mounted(answering(() => names))
    expect(notes()).toContain('Field names take 26% of these bytes')
    expect(notes()).not.toContain('16 MB limit')
  })

  it('goes into an object field and back — the numbers kept, the focus on where it is', async () => {
    const { calls } = await mounted(answering((p) => (levelOf(p) === 'address' ? ADDRESS : ROOT)))
    // An array, or a key no path can name, is not gone into.
    expect(row('items').querySelector('button')).toBeNull()
    expect(row('odd.key').querySelector('button')).toBeNull()
    const into = row('address').querySelector('button')!
    expect(into.getAttribute('aria-label')).toBe('Measure the fields of address')
    into.click()
    await flush()
    expect(levelOf(aggregates(calls).at(-1)!.params.pipeline!)).toBe('address')
    expect(document.getElementById('level')!.textContent).toBe('Documents›address')
    expect(document.activeElement).toBe(document.querySelector('#level [aria-current]'))
    expect(document.getElementById('status')!.textContent).toBe(
      'address in 990 documents · 606 B on average · 900 B the largest',
    )
    expect(notes()).toContain('In a random sample of 1,000 documents, 990 hold address as an object.')
    expect(document.getElementById('largest-title')!.textContent).toBe('Largest address')
    // No share of 16 MB for an object's size.
    expect(document.querySelectorAll('#largest th')).toHaveLength(3)
    ;[...document.querySelectorAll<HTMLButtonElement>('#level button')]
      .find((b) => b.textContent === 'Documents')!
      .click()
    await flush()
    expect(document.getElementById('level')!.textContent).toBe('')
    expect(row('items')).not.toBeNull()
    // Back where it was: the same numbers, not measured again.
    expect(aggregates(calls)).toHaveLength(2)
    document.getElementById('again')!.click()
    await flush()
    expect(aggregates(calls)).toHaveLength(3)
  })

  it('measures what is asked last, waiting for the run before, never refused as busy', async () => {
    let release: () => void = () => {}
    const { calls } = await mounted({
      'documents.aggregate': (p) =>
        p.pipeline!.some((s) => '$sample' in s)
          ? new Promise((resolve) => (release = () => resolve({ documents: [ROOT] })))
          : { documents: [ADDRESS] },
    })
    // The sample still running: All is asked.
    scopeButton('All').click()
    await flush()
    release()
    await flush()
    expect(app().textContent).not.toContain('could not be measured')
    expect(row('street')).not.toBeNull()
    expect(aggregates(calls)).toHaveLength(2)
  })

  it('is busy only while a measure runs: going back to a level kept is no wait', async () => {
    let release: () => void = () => {}
    await mounted({
      'documents.aggregate': (p) =>
        levelOf(p.pipeline!) === 'address'
          ? new Promise((resolve) => (release = () => resolve({ documents: [ADDRESS] })))
          : { documents: [ROOT] },
    })
    row('address').querySelector('button')!.click()
    await flush()
    expect(document.getElementById('again')!.getAttribute('aria-busy')).toBe('true')
    ;[...document.querySelectorAll<HTMLButtonElement>('#level button')]
      .find((b) => b.textContent === 'Documents')!
      .click()
    await flush()
    expect(document.getElementById('again')!.getAttribute('aria-busy')).toBe('false')
    expect((document.getElementById('again') as HTMLButtonElement).disabled).toBe(false)
    release()
    await flush()
    expect(row('items')).not.toBeNull()
  })

  it('says a sample drawn after measuring is of the documents holding the object, and keeps the focus on an empty level', async () => {
    await mounted({
      'documents.aggregate': (p) => {
        const nested = levelOf(p.pipeline!) === 'address'
        const late = '$match' in p.pipeline![0]!
        if (nested && !late)
          throw new AskError(
            'mongo_error',
            'MongoDB refused the operation (292 QueryExceededMemoryLimitNoDiskUseAllowed)',
          )
        return { documents: [nested ? ADDRESS : ROOT] }
      },
    })
    row('address').querySelector('button')!.click()
    await flush()
    expect(notes()).toContain('990 of the documents that hold address as an object, at random.')
    document.body.replaceChildren(Object.assign(document.createElement('div'), { id: 'app' }))
    await mounted(answering((p) => (levelOf(p) === 'address' ? { stats: [] } : ROOT)))
    row('address').querySelector('button')!.click()
    await flush()
    expect(document.activeElement).toBe(document.querySelector('#level [aria-current]'))
  })

  it('sends no run replaced while it waited for the one before', async () => {
    let release: () => void = () => {}
    let first = true
    const { calls } = await mounted({
      'documents.aggregate': () => {
        if (!first) return { documents: [ROOT] }
        first = false
        return new Promise((resolve) => (release = () => resolve({ documents: [ROOT] })))
      },
    })
    // While the first runs: All, then the sample again — All is replaced before it is sent.
    scopeButton('All').click()
    scopeButton(`${(1000).toLocaleString('en-US')} at random`).click()
    await flush()
    release()
    await flush()
    expect(aggregates(calls)).toHaveLength(2)
    expect(aggregates(calls).every((c) => c.params.pipeline!.some((s) => '$sample' in s))).toBe(true)
  })

  it('measures all documents on asking, and says when that or a sample took too long', async () => {
    const { calls } = await mounted(answering(() => ROOT))
    scopeButton('All').click()
    await flush()
    expect(
      aggregates(calls)
        .at(-1)!
        .params.pipeline!.some((s) => '$sample' in s),
    ).toBe(false)
    expect(notes()).toContain('All 1,000 documents are measured.')
    document.body.replaceChildren(Object.assign(document.createElement('div'), { id: 'app' }))
    await mounted({
      'documents.aggregate': (p) => {
        if (!p.pipeline!.some((s) => '$sample' in s))
          throw new AskError('mongo_error', 'MongoDB refused the operation (50 MaxTimeMSExpired)')
        return { documents: [ROOT] }
      },
    })
    scopeButton('All').click()
    await flush()
    expect(app().textContent).toContain(
      'Measuring all documents took too long: measure a random sample instead.',
    )
    expect(document.getElementById('status')!.textContent).toBe('The documents could not be measured')
    document.body.replaceChildren(Object.assign(document.createElement('div'), { id: 'app' }))
    await mounted({
      'documents.aggregate': () => {
        throw new AskError('timeout', 'The app did not answer in time')
      },
    })
    expect(app().textContent).toContain('Measuring took too long: try again when the server is less busy.')
  })

  it('draws the sample after measuring when large documents are past MongoDB’s memory', async () => {
    const tried: boolean[] = []
    await mounted({
      'documents.aggregate': (p) => {
        const late = '$project' in p.pipeline![0]!
        tried.push(late)
        if (!late)
          throw new AskError(
            'mongo_error',
            'MongoDB refused the operation (292 QueryExceededMemoryLimitNoDiskUseAllowed)',
          )
        return { documents: [ROOT] }
      },
    })
    expect(tried).toEqual([false, true])
    expect(row('items')).not.toBeNull()
  })

  it('opens a largest document, puts the focus back on its button when it could not, and offers none without an _id', async () => {
    const f = await mounted(answering(() => ROOT))
    document.querySelector<HTMLButtonElement>('#largest [data-open="0"]')!.click()
    await flush()
    expect(f.calls.find((c) => c.method === 'ui.openDocument')!.params).toEqual({
      id: { $oid: '65a1b2c3d4e5f60718293a4b' },
    })
    document.body.replaceChildren(Object.assign(document.createElement('div'), { id: 'app' }))
    await mounted({
      ...answering(() => ({ ...ROOT, largest: [{ _id: int(1), size: int(10) }, { size: int(5) }] })),
      'ui.openDocument': () => {
        throw new AskError('failed', 'Not found')
      },
    })
    expect(document.querySelectorAll('#largest [data-open]')).toHaveLength(1)
    document.querySelector<HTMLButtonElement>('#largest [data-open="0"]')!.click()
    await flush()
    expect(notes()).toContain('Could not open the document: Not found')
    expect(document.activeElement).toBe(document.querySelector('#largest [data-open="0"]'))
  })

  it('asks nothing where personal data is hidden from the user, and says why', async () => {
    const { calls } = await mounted(
      answering(() => ROOT),
      { ...PLACE, hidden: [['email']] },
    )
    expect(aggregates(calls)).toEqual([])
    expect(app().textContent).toContain('The sizes of these documents are not measured for you')
    expect(app().textContent).toContain('would tell how long the hidden values are')
    expect((document.getElementById('again') as HTMLButtonElement).disabled).toBe(true)
    expect(scopeButton('All').disabled).toBe(true)
    // Not told in time: measured, and a refusal says it may be why.
    document.body.replaceChildren(Object.assign(document.createElement('div'), { id: 'app' }))
    await mounted(
      {
        'documents.aggregate': () => {
          throw new AskError('mongo_error', 'MongoDB refused the operation (31393 Location31393)')
        },
      },
      { ...PLACE, hidden: null },
    )
    expect(app().textContent).toContain('could not be told in time; where it is, the server measures nothing')
  })

  it('says when there is nothing, no collection, or the documents could not be measured', async () => {
    await mounted(answering(() => ({ stats: [], spread: [], largest: [], fields: [] })))
    expect(app().textContent).toContain('This collection has no documents')
    document.body.replaceChildren(Object.assign(document.createElement('div'), { id: 'app' }))
    await mounted(answering((p) => (levelOf(p) === 'address' ? { stats: [] } : ROOT)))
    row('address').querySelector('button')!.click()
    await flush()
    expect(app().textContent).toContain('No document of the sample holds address as an object')
    document.body.replaceChildren(Object.assign(document.createElement('div'), { id: 'app' }))
    await mounted(
      answering(() => ROOT),
      null,
    )
    expect(app().textContent).toContain('Open a collection to measure its documents.')
    document.body.replaceChildren(Object.assign(document.createElement('div'), { id: 'app' }))
    const failing = await mounted({
      'documents.aggregate': () => {
        throw new AskError('failed', 'MongoDB denied this operation')
      },
    })
    expect(app().textContent).toContain('The documents could not be measured')
    expect(app().textContent).toContain('MongoDB denied this operation')
    ;[...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent === 'Try again')!
      .click()
    await flush()
    expect(aggregates(failing.calls)).toHaveLength(2)
  })

  it('says it in Turkish', async () => {
    const f = await mounted(answering(() => ROOT))
    for (const fn of f.contexts) fn('tr', 'light', 'violet')
    expect(document.getElementById('status')!.textContent).toBe(
      `${new Intl.NumberFormat('tr').format(1000)} belge · ortalama 5 KB · en büyüğü 9 MB · toplam ${new Intl.NumberFormat('tr', { maximumFractionDigits: 1 }).format(4.9)} MB`,
    )
    expect(app().textContent).toContain('Baytlar nereye gidiyor')
    expect(app().textContent).toContain('Bulunma oranı')
    expect(row('items').textContent).toContain(
      `≈ ${new Intl.NumberFormat('tr', { maximumFractionDigits: 1 }).format(12.5)} öğe`,
    )
  })

  it.each([
    ['zh', '字节去了哪里', '出现于', 'zh-CN'],
    ['ja', 'バイトの内訳', '含まれる割合', 'ja'],
    ['es', 'Adónde van los bytes', 'Presente en', 'es'],
    ['pt', 'Para onde vão os bytes', 'Presente em', 'pt-BR'],
    ['ko', '바이트 사용 내역', '포함 비율', 'ko'],
    ['de', 'Wohin die Bytes gehen', 'Enthalten in', 'de'],
    ['fr', 'Où vont les octets', 'Présent dans', 'fr'],
    ['ru', 'Куда уходят байты', 'Встречается в', 'ru'],
  ])('says it in %s', async (lang, heading, column, tag) => {
    const f = await mounted(answering(() => ROOT))
    for (const fn of f.contexts) fn(lang, 'light', 'violet')
    expect(app().textContent).toContain(heading)
    expect(app().textContent).toContain(column)
    expect(document.documentElement.lang).toBe(tag)
    expect(document.querySelector('h1, .mm-title')?.textContent ?? '').toContain(TEXTS[lang as 'zh']!.title)
  })

  it('falls back to English for a language it does not know', async () => {
    const f = await mounted(answering(() => ROOT))
    for (const fn of f.contexts) fn('xx', 'light', 'violet')
    expect(app().textContent).toContain('Where the bytes go')
    expect(document.documentElement.lang).toBe('en')
    // The numbers read as English too, not as the unknown locale.
    expect(document.getElementById('status')!.textContent).toContain('1,000 documents')
    expect(row('items').textContent).toContain('≈ 12.5 elements')
  })

  it('formats the numbers of a language in that language', async () => {
    const f = await mounted(answering(() => ROOT))
    for (const fn of f.contexts) fn('de', 'light', 'violet')
    expect(row('items').textContent).toContain(
      `≈ ${new Intl.NumberFormat('de', { maximumFractionDigits: 1 }).format(12.5)} Elemente`,
    )
    expect(document.getElementById('status')!.textContent).toContain(
      `${new Intl.NumberFormat('de').format(1000)} Dokumente`,
    )
    for (const fn of f.contexts) fn('ru', 'light', 'violet')
    expect(document.getElementById('status')!.textContent).toContain('документов')
  })
})

/** Every key of a block, deep for objects; a function is a leaf. */
const keysOf = (v: unknown, path = ''): string[] =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
    ? Object.entries(v).flatMap(([k, x]) => keysOf(x, `${path}.${k}`))
    : Array.isArray(v)
      ? [`${path}[${v.length}]`]
      : [`${path}:${typeof v}`]

describe('the languages of the page', () => {
  it('has a block for each of the ten languages, with the keys of English', () => {
    const en = keysOf(TEXTS.en)
    expect(LANGUAGES).toHaveLength(10)
    for (const lang of LANGUAGES) {
      expect(TEXTS[lang], lang).toBeDefined()
      expect(keysOf(TEXTS[lang]), lang).toEqual(en)
    }
  })

  it('leaves no entry empty', () => {
    for (const lang of LANGUAGES) {
      const t = TEXTS[lang]
      expect(t.title).not.toBe('')
      expect(t.ranges).toHaveLength(8)
      expect(t.summary(2, '1 KB', '2 KB', '3 KB'), lang).toContain('2 KB')
      expect(t.sampleIn(3, 'a'), lang).toContain('a')
    }
  })

  it('keeps English words only where they are names', () => {
    for (const lang of ['ko', 'de', 'fr', 'ru'] as const) {
      expect(TEXTS[lang].title, lang).not.toBe(TEXTS.en.title)
      expect(TEXTS[lang].fields, lang).not.toBe(TEXTS.en.fields)
      expect(TEXTS[lang].tryAgain, lang).not.toBe(TEXTS.en.tryAgain)
    }
  })

  it('gives each language its singular for one document and Russian its three forms', () => {
    expect(TEXTS.en.count(1)).toContain('1 document')
    expect(TEXTS.en.count(1)).not.toContain('documents')
    expect(TEXTS.de.count(1)).toMatch(/1 Dokument$/)
    expect(TEXTS.de.count(2)).toMatch(/2 Dokumente$/)
    expect(TEXTS.fr.count(0)).toMatch(/0 document$/)
    expect(TEXTS.fr.count(1)).toMatch(/1 document$/)
    expect(TEXTS.fr.count(2)).toMatch(/2 documents$/)
    expect(TEXTS.ru.count(1)).toMatch(/1 документ$/)
    expect(TEXTS.ru.count(21)).toMatch(/21 документ$/)
    expect(TEXTS.ru.count(2)).toMatch(/2 документа$/)
    expect(TEXTS.ru.count(24)).toMatch(/24 документа$/)
    expect(TEXTS.ru.count(5)).toMatch(/5 документов$/)
    expect(TEXTS.ru.count(11)).toMatch(/11 документов$/)
    expect(TEXTS.ru.count(14)).toMatch(/14 документов$/)
    expect(TEXTS.ru.count(0)).toMatch(/0 документов$/)
    expect(TEXTS.ru.summaryIn(1, 'a', 'x', 'y')).toContain('в 1 документе')
    expect(TEXTS.ru.summaryIn(3, 'a', 'x', 'y')).toContain('в 3 документах')
    expect(TEXTS.de.allNote(1)).toContain('einzige')
    expect(TEXTS.ru.allNote(1)).toContain('единственный')
    expect(TEXTS.fr.allNote(1)).toContain('seul')
    expect(TEXTS.fr.sampleIn(1, 'a')).toContain('1 document contient')
    expect(TEXTS.fr.sampleIn(2, 'a')).toContain('2 documents contiennent')
  })
  it('writes the average element count in the form of each language', () => {
    const at = (lang: Language, n: number) => TEXTS[lang].elements(formatNumber(n, lang, 1), n)
    expect([1, 2, 5, 12.5].map((n) => at('en', n))).toEqual([
      '≈ 1 element',
      '≈ 2 elements',
      '≈ 5 elements',
      '≈ 12.5 elements',
    ])
    expect([1, 2].map((n) => at('de', n))).toEqual(['≈ 1 Element', '≈ 2 Elemente'])
    expect(at('de', 12.5)).toMatch(/Elemente$/)
    expect([1, 2].map((n) => at('fr', n))).toEqual(['≈ 1 élément', '≈ 2 éléments'])
    expect(at('fr', 12.5)).toMatch(/éléments$/)
    expect([1, 2].map((n) => at('es', n))).toEqual(['≈ 1 elemento', '≈ 2 elementos'])
    expect([1, 2].map((n) => at('pt', n))).toEqual(['≈ 1 elemento', '≈ 2 elementos'])
    expect([1, 2, 5, 11, 21, 22].map((n) => at('ru', n).replace(/^≈ \d+ /, ''))).toEqual([
      'элемент',
      'элемента',
      'элементов',
      'элементов',
      'элемент',
      'элемента',
    ])
    expect(at('ru', 12.5)).toMatch(/ элемента$/)
    expect(at('ru', 12.5)).toContain(new Intl.NumberFormat('ru', { maximumFractionDigits: 1 }).format(12.5))
    // A language without plural forms writes the same for every count.
    for (const lang of ['tr', 'zh', 'ja', 'ko'] as const)
      expect(at(lang, 1).replace('1', ''), lang).toBe(at(lang, 2).replace('2', ''))
  })

  it('gives English, with English numbers, for a language the table lacks', () => {
    const partial = { en: TEXTS.en, tr: TEXTS.tr }
    const language = shown(partial, 'ru')
    expect(language).toBe('en')
    expect(pick(partial, 'ru')).toBe(TEXTS.en)
    expect(pick(partial, 'tr')).toBe(TEXTS.tr)
    expect(formatNumber(12345, language)).toBe('12,345')
    expect(formatNumber(12345, shown(partial, 'tr'))).toBe(new Intl.NumberFormat('tr').format(12345))
    expect(TEXTS.en.count(12345)).toBe('12,345 documents')
  })
})
