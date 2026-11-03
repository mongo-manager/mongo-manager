// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { AskError } from '../../kit/src/client'
import { fakeClient, flush } from '../../kit/test/fakeClient'
import { langTag, pluralOf, shown } from '../../kit/src/ui'
import { bytesText } from '../src/report'
import { mount, TEXT } from '../src/view'
import type { StorageCollection, StorageReport } from '../src/report'

/** Plugins wave 4 (spec §2): the storage tab — the database's report, an estimate, compact. */
const MB = 1024 * 1024
const PLACE = { connectionId: 'c', connectionName: 'Shop', db: 'shop', coll: 'orders', documentId: null }
const coll = (name: string, o: Partial<StorageCollection> = {}): StorageCollection => ({
  name,
  type: 'collection',
  count: 1200,
  size: 100 * MB,
  storageSize: 80 * MB,
  freeBytes: 30 * MB,
  indexSize: 20 * MB,
  indexFreeBytes: 10 * MB,
  indexes: [
    { name: '_id_', size: 15 * MB, freeBytes: 8 * MB },
    { name: 'email_1', size: 5 * MB, freeBytes: 2 * MB },
  ],
  ...o,
})
const REPORT: StorageReport = {
  collections: [
    coll('orders', { freeBytes: 1 * MB, indexFreeBytes: 0 }),
    coll('events'),
    coll('ticks', { type: 'timeseries', freeBytes: 0, indexFreeBytes: 0 }),
    coll('people', {
      size: null,
      storageSize: null,
      freeBytes: null,
      indexSize: null,
      indexFreeBytes: null,
      indexes: [{ name: '_id_', size: null, freeBytes: null }],
      sizesHidden: true,
    }),
  ],
  more: false,
}

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>'
})
const app = () => document.getElementById('app')!
const text = () => app().textContent ?? ''
const rowNames = () => [...app().querySelectorAll<HTMLElement>('[data-coll]')].map((r) => r.dataset.coll)
const open = async (name: string) => {
  app().querySelector<HTMLButtonElement>(`[data-coll="${name}"] button`)!.click()
  await flush()
}

async function opened(handlers: Record<string, (p: Record<string, unknown>) => unknown> = {}, place = PLACE) {
  const fake = fakeClient({ place }, { 'storage.stats': () => structuredClone(REPORT), ...handlers })
  mount(app(), fake.client)
  fake.greet()
  await flush()
  return fake
}

describe('the report', () => {
  it('lists the database’s collections, the most reclaimable first, with what they add up to', async () => {
    const { calls } = await opened()
    expect(calls.filter((c) => c.method === 'storage.stats')).toHaveLength(1)
    expect(rowNames()).toEqual(['events', 'orders', 'ticks', 'people'])
    const events = app().querySelector('[data-coll="events"]')!.textContent!
    expect(events).toContain('40 MB')
    expect(events).toContain('40%')
    expect(app().querySelector('[data-coll="ticks"]')!.textContent).toContain('Time series')
    // The tab's own collection is marked.
    expect(app().querySelector('[data-coll="orders"]')!.textContent).toContain('This collection')
    const totals = app().querySelector('#totals')!.textContent!
    expect(totals).toContain('240 MB')
    expect(totals).toContain('41 MB')
  })

  it('says a hidden collection’s sizes are hidden, never nothing, and leaves them out of the totals', async () => {
    await opened()
    const people = app().querySelector('[data-coll="people"]')!.textContent!
    expect(people).toContain('Hidden')
    expect(people).not.toContain('0 B')
    expect(app().querySelector('#totals')!.textContent).toContain('1 collection is not counted')
    await open('people')
    expect(app().querySelector('#compact')).toBeNull()
    expect(app().querySelector('#detail')!.textContent).toContain('personal data')
  })

  it('marks a collection worth compacting', async () => {
    await opened()
    expect(app().querySelector('[data-coll="events"] [data-worth]')).not.toBeNull()
    expect(app().querySelector('[data-coll="orders"] [data-worth]')).toBeNull()
  })

  it('says when more collections were there than it read, and when one could not be read', async () => {
    await opened({
      'storage.stats': () => ({
        collections: [
          coll('broken', {
            unread: true,
            count: null,
            size: null,
            storageSize: null,
            freeBytes: null,
            indexSize: null,
            indexFreeBytes: null,
            indexes: [],
          }),
        ],
        more: true,
      }),
    })
    expect(text()).toContain('first 500')
    expect(app().querySelector('[data-coll="broken"]')!.textContent).toContain('Could not be read')
  })

  it('reads again on Refresh', async () => {
    const { calls } = await opened()
    app().querySelector<HTMLButtonElement>('#refresh')!.click()
    await flush()
    expect(calls.filter((c) => c.method === 'storage.stats')).toHaveLength(2)
  })

  it('asks to open a collection where there is none, and says why a read failed', async () => {
    await opened({}, null as never)
    expect(text()).toContain('Open a collection')
    document.body.innerHTML = '<div id="app"></div>'
    await opened({
      'storage.stats': () => {
        throw new AskError('not_permitted', 'no')
      },
    })
    expect(text()).toContain('The plugin is not allowed to do this.')
  })
})

describe('a collection’s detail', () => {
  it('shows its indexes’ sizes and free space', async () => {
    await opened()
    await open('events')
    const detail = app().querySelector('#detail')!
    expect(detail.textContent).toContain('email_1')
    expect(detail.textContent).toContain('5 MB')
    expect(detail.textContent).toContain('2 MB')
  })

  it('estimates what compact would give back, or says why it cannot', async () => {
    const { calls } = await opened({
      'storage.compactEstimate': (p) =>
        p.coll === 'events'
          ? { available: true, estimatedBytes: 35 * MB }
          : { available: false, reason: 'version' },
    })
    await open('events')
    app().querySelector<HTMLButtonElement>('#estimate')!.click()
    await flush()
    expect(calls.find((c) => c.method === 'storage.compactEstimate')!.params).toEqual({ coll: 'events' })
    expect(app().querySelector('#estimate-result')!.textContent).toContain('35 MB')
    await open('orders')
    app().querySelector<HTMLButtonElement>('#estimate')!.click()
    await flush()
    expect(app().querySelector('#estimate-result')!.textContent).toContain('MongoDB 8.0')
  })

  it('compacts through the app, which asks the user, then reads the report again', async () => {
    const { calls } = await opened({ 'ui.compact': () => ({ bytesFreed: 38 * MB }) })
    await open('events')
    app().querySelector<HTMLButtonElement>('#compact')!.click()
    await flush()
    expect(calls.find((c) => c.method === 'ui.compact')!.params).toEqual({ coll: 'events' })
    expect(app().querySelector('#status')!.textContent).toContain('38 MB')
    expect(calls.filter((c) => c.method === 'storage.stats')).toHaveLength(2)
  })

  it('says nothing was done when the user said no', async () => {
    const { calls } = await opened({
      'ui.compact': () => {
        throw new AskError('declined', 'no')
      },
    })
    await open('events')
    app().querySelector<HTMLButtonElement>('#compact')!.click()
    await flush()
    expect(app().querySelector('#status')!.textContent).toContain('you said no')
    expect(calls.filter((c) => c.method === 'storage.stats')).toHaveLength(1)
  })
})

// Final review I5, Minor 5: a time series is not compacted here; a compact may run for long.
describe('compact’s limits', () => {
  it('offers a time series no compact, and says why', async () => {
    const { calls } = await opened()
    await open('ticks')
    expect(app().querySelector('#compact')).toBeNull()
    expect(app().querySelector('#detail')!.textContent).toContain('time series')
    expect(calls.some((c) => c.method === 'storage.compactEstimate')).toBe(false)
  })

  it('says a compact runs, for as long as it runs', async () => {
    let finish: (v: unknown) => void = () => {}
    // The tab's own collection is the one shown first.
    await opened({ 'ui.compact': () => new Promise((r) => (finish = r)) })
    app().querySelector<HTMLButtonElement>('#compact')!.click()
    await flush()
    expect(app().querySelector('#status')!.textContent).toContain('Compacting')
    expect(app().querySelector<HTMLButtonElement>('#compact')!.disabled).toBe(true)
    finish({ bytesFreed: 1024 })
    await flush()
    expect(app().querySelector('#status')!.textContent).toContain('orders compacted')
  })
})

describe('the language', () => {
  it('follows the app', async () => {
    const { contexts } = await opened()
    contexts.forEach((fn) => fn('tr', 'light', 'emerald'))
    await flush()
    expect(text()).toContain('Depolama')
    expect(app().querySelector('[data-coll="orders"]')!.textContent).toContain('Bu koleksiyon')
  })

  it('shows each new language', async () => {
    const cases: Array<[string, string, string, string]> = [
      ['zh', '存储', '当前集合', 'zh-CN'],
      ['ja', 'ストレージ', 'このコレクション', 'ja'],
      ['es', 'Almacenamiento', 'Esta colección', 'es'],
      ['pt', 'Armazenamento', 'Esta coleção', 'pt-BR'],
      ['ko', '스토리지', '현재 컬렉션', 'ko'],
      ['de', 'Speicher', 'Diese Collection', 'de'],
      ['fr', 'Stockage', 'Cette collection', 'fr'],
      ['ru', 'Хранилище', 'Эта коллекция', 'ru'],
    ]
    for (const [locale, title, current, tag] of cases) {
      document.body.innerHTML = '<div id="app"></div>'
      const { contexts } = await opened()
      contexts.forEach((fn) => fn(locale, 'light', 'emerald'))
      await flush()
      expect(text()).toContain(title)
      expect(app().querySelector('[data-coll="orders"]')!.textContent).toContain(current)
      expect(document.documentElement.lang).toBe(tag)
    }
  })

  it('falls back to English for an unknown language', async () => {
    const { contexts } = await opened()
    contexts.forEach((fn) => fn('xx', 'light', 'emerald'))
    await flush()
    expect(text()).toContain('Storage')
    expect(app().querySelector('[data-coll="orders"]')!.textContent).toContain('This collection')
    expect(document.documentElement.lang).toBe('en')
  })

  it('formats numbers in the language of the words, English for an unknown one', async () => {
    const { contexts } = await opened()
    contexts.forEach((fn) => fn('xx', 'light', 'emerald'))
    await flush()
    const english = new Intl.NumberFormat('en', { style: 'percent' }).format(0.4)
    expect(app().querySelector('[data-coll="events"]')!.textContent).toContain(english)
    expect(app().querySelector('[data-coll="events"]')!.textContent).toContain(
      new Intl.NumberFormat('en').format(1200),
    )
  })

  it('falls back to English with a table that lacks the language, numbers included', () => {
    const partial = { en: TEXT.en, tr: TEXT.tr }
    expect(shown(partial, 'de')).toBe('en')
    expect(shown(partial, 'tr')).toBe('tr')
    expect(bytesText(12345 * 1024, shown(partial, 'de'))).toBe(
      `${new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(12345 / 1024)} MB`,
    )
    expect(new Intl.NumberFormat(langTag(shown(partial, 'de'))).format(12345)).toBe('12,345')
  })

  it('counts collections by the plural category of the shown language', () => {
    const say = (lang: keyof typeof TEXT, n: number) => TEXT[lang].notCounted(n, pluralOf(n, lang))
    expect(say('en', 1)).toContain('1 collection is')
    expect(say('en', 2)).toContain('2 collections are')
    expect(say('de', 1)).toContain('1 Collection wird')
    expect(say('de', 1)).toContain('ihre Größen')
    expect(say('de', 3)).toContain('3 Collections werden')
    expect(say('fr', 1)).toContain('1 collection n’est')
    expect(say('fr', 3)).toContain('3 collections ne')
    expect(say('es', 1)).toContain('1 colección')
    expect(say('es', 2)).toContain('2 colecciones')
    expect(say('pt', 1)).toContain('1 coleção')
    expect(say('pt', 2)).toContain('2 coleções')
    expect(say('ru', 1)).toContain('1 коллекция не учтена')
    expect(say('ru', 21)).toContain('21 коллекция не учтена')
    expect(say('ru', 2)).toContain('2 коллекции не учтены')
    expect(say('ru', 22)).toContain('22 коллекции не учтены')
    expect(say('ru', 5)).toContain('5 коллекций не учтено')
    expect(say('ru', 11)).toContain('11 коллекций не учтено')
    expect(say('ru', 12)).toContain('12 коллекций не учтено')
  })

  it('has the same keys in every language as in English', () => {
    const shape = (v: unknown): unknown =>
      typeof v === 'function'
        ? 'fn'
        : v && typeof v === 'object'
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x)]))
          : 'str'
    expect(Object.keys(TEXT)).toEqual(['en', 'tr', 'zh', 'ja', 'es', 'pt', 'ko', 'de', 'fr', 'ru'])
    for (const [lang, block] of Object.entries(TEXT)) expect(shape(block), lang).toEqual(shape(TEXT.en))
  })
})
