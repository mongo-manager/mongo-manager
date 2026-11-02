// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { AskError } from '../../kit/src/client'
import { LANGUAGES, langTag, shown } from '../../kit/src/i18n'
import { formatNumber } from '../../kit/src/ui'
import { fakeClient, flush } from '../../kit/test/fakeClient'
import { TEXT, mount, sizeText } from '../src/view'
import type { Analysis } from '../src/analysis'

/** Plugins wave 4 (spec §4): the shard key tab — candidates, analysed side by side. */
const PLACE = {
  connectionId: 'c',
  connectionName: 'Shop',
  db: 'shop',
  coll: 'orders',
  documentId: null,
  hidden: [['ssn']],
}
const ORDERS = [
  { _id: { $oid: '65a1b2c3d4e5f60718293a01' }, city: 'Izmir', seq: { $numberInt: '1' }, ssn: '***' },
  { _id: { $oid: '65a1b2c3d4e5f60718293a02' }, city: 'Ankara', seq: { $numberInt: '2' }, ssn: '***' },
]
const GOOD: Analysis = {
  available: true,
  numDocsTotal: 100_000,
  numDocsSampled: 10_000,
  numDistinctValues: 80_000,
  avgDocSizeBytes: 210,
  isUnique: false,
  mostCommonValues: [{ value: 'Izmir', frequency: 30 }],
  monotonicity: 'not monotonic',
}
const GROWING: Analysis = {
  ...GOOD,
  monotonicity: 'monotonic',
  mostCommonValues: [{ value: { $numberInt: '7' }, frequency: 1 }],
}

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>'
})
const app = () => document.getElementById('app')!
const text = () => app().textContent ?? ''
const select = (id: string, value: string) => {
  const s = app().querySelector<HTMLSelectElement>(`#${id}`)!
  s.value = value
  s.dispatchEvent(new Event('change'))
}
const click = async (id: string) => {
  app().querySelector<HTMLButtonElement>(`#${id}`)!.click()
  await flush()
}
const candidate = async (...fields: Array<[string, 'asc' | 'hashed']>) => {
  for (const [field, kind] of fields) {
    select('field', field)
    select('kind', kind)
    await click('add-field')
  }
  await click('analyze')
}

async function opened(
  analyze: (p: Record<string, unknown>) => unknown = (p) => ('seq' in (p.key as object) ? GROWING : GOOD),
  place: unknown = PLACE,
) {
  const fake = fakeClient(
    { place: place as never },
    { 'documents.find': () => ({ documents: ORDERS }), 'shardKey.analyze': analyze, 'ui.copy': () => true },
  )
  mount(app(), fake.client)
  fake.greet()
  await flush()
  return fake
}

describe('the fields offered', () => {
  it('are the sampled fields, never one hidden from the user', async () => {
    await opened()
    const options = [...app().querySelectorAll<HTMLOptionElement>('#field option')].map((o) => o.value)
    expect(options).toEqual(['_id', 'city', 'seq'])
  })
})

describe('candidates', () => {
  it('are analysed one by one with the key as MongoDB takes it, and shown side by side', async () => {
    const { calls } = await opened()
    await candidate(['city', 'asc'])
    await candidate(['seq', 'asc'])
    const asked = calls.filter((c) => c.method === 'shardKey.analyze').map((c) => c.params)
    expect(asked).toEqual([{ key: { city: 1 } }, { key: { seq: 1 } }])
    const heads = [...app().querySelectorAll('#results thead th')].map((th) => th.textContent)
    expect(heads.slice(1).map((h) => h!.replace(/Remove.*/, ''))).toEqual(['{ city: 1 }', '{ seq: 1 }'])
    const cells = (metric: string) =>
      [...app().querySelectorAll(`#results tr[data-metric="${metric}"] td`)].map((td) => td.textContent ?? '')
    expect(cells('overall')[0]).toContain('Good')
    expect(cells('overall')[1]).toContain('Poor')
    expect(cells('monotonicity')[1]).toContain('Grows with each insert')
    expect(cells('distinct')[0]).toContain('80,000')
    // 30 of 10,000 sampled documents.
    expect(cells('frequency')[0]).toContain('0.3%')
    expect(cells('common')[0]).toContain('Izmir')
  })

  it('compounds fields, and a hashed field spreads a growing one', async () => {
    const { calls } = await opened()
    await candidate(['city', 'asc'], ['seq', 'hashed'])
    expect(calls.find((c) => c.method === 'shardKey.analyze')!.params).toEqual({
      key: { city: 1, seq: 'hashed' },
    })
    expect(app().querySelector('#results tr[data-metric="monotonicity"] td')!.textContent).toContain('Good')
  })

  it('refuses a key MongoDB would not take, without asking', async () => {
    const { calls } = await opened()
    select('field', 'city')
    select('kind', 'hashed')
    await click('add-field')
    select('field', 'seq')
    select('kind', 'hashed')
    await click('add-field')
    await click('analyze')
    expect(app().querySelector('#key-error')!.textContent).toContain('one hashed field')
    expect(calls.some((c) => c.method === 'shardKey.analyze')).toBe(false)
  })

  it('does not analyse the same key twice, and a candidate can be removed', async () => {
    const { calls } = await opened()
    await candidate(['city', 'asc'])
    await candidate(['city', 'asc'])
    expect(calls.filter((c) => c.method === 'shardKey.analyze')).toHaveLength(1)
    app().querySelector<HTMLButtonElement>('#results thead button')!.click()
    await flush()
    expect(app().querySelector('#results')).toBeNull()
  })
})

// Final review Minor 14: a redraw leaves the focus where the user is.
describe('the focus', () => {
  it('stays on what was pressed, or moves to what is next when it is gone', async () => {
    await opened()
    select('field', 'city')
    $add()
    await flush()
    const chip = app().querySelector<HTMLButtonElement>('#draft button')!
    chip.focus()
    chip.click()
    await flush()
    expect(document.activeElement?.id).toBe('field')
    select('field', 'city')
    $add()
    await flush()
    const analyze = app().querySelector<HTMLButtonElement>('#analyze')!
    analyze.focus()
    analyze.click()
    await flush()
    expect(document.activeElement?.id).toBe('analyze')
    const remove = app().querySelector<HTMLButtonElement>('#results thead button')!
    remove.focus()
    remove.click()
    await flush()
    expect(document.activeElement?.id).toBe('analyze')
  })
})
const $add = () => app().querySelector<HTMLButtonElement>('#add-field')!.click()

describe('what MongoDB could not tell', () => {
  it('says a standalone server or an old version cannot analyse', async () => {
    await opened(() => ({ available: false, reason: 'standalone' }))
    await candidate(['city', 'asc'])
    expect(text()).toContain('replica set')
    document.body.innerHTML = '<div id="app"></div>'
    await opened(() => ({ available: false, reason: 'version' }))
    await candidate(['city', 'asc'])
    expect(text()).toContain('MongoDB 7.0')
  })

  it('names the index to create when none supports the key, and copies it on a click', async () => {
    const { calls } = await opened(() => ({ available: false, reason: 'no_index' }))
    await candidate(['city', 'asc'])
    expect(text()).toContain('db.getCollection("orders").createIndex({ city: 1 })')
    app().querySelector<HTMLButtonElement>('[data-copy-index]')!.click()
    await flush()
    expect(calls.find((c) => c.method === 'ui.copy')!.params).toEqual({
      text: 'db.getCollection("orders").createIndex({ city: 1 })',
    })
  })

  it('says why the app refused', async () => {
    await opened(() => {
      throw new AskError('failed', 'Personal data rules reach this collection')
    })
    await candidate(['city', 'asc'])
    expect(app().querySelector('#status')!.textContent).toContain('Personal data rules reach this collection')
    expect(app().querySelector('#results')).toBeNull()
  })

  it('says a view cannot be sharded, and asks for a collection where there is none', async () => {
    const { calls } = await opened(undefined, { ...PLACE, view: true })
    expect(text()).toContain('A view cannot be sharded')
    expect(calls.some((c) => c.method === 'documents.find')).toBe(false)
    document.body.innerHTML = '<div id="app"></div>'
    await opened(undefined, null)
    expect(text()).toContain('Open a collection')
  })
})

describe('the language', () => {
  it('follows the app', async () => {
    const { contexts } = await opened()
    await candidate(['city', 'asc'])
    contexts.forEach((fn) => fn('tr', 'light', 'emerald'))
    await flush()
    expect(text()).toContain('Parça anahtarı')
    expect(app().querySelector('#results tr[data-metric="overall"] td')!.textContent).toContain('İyi')
  })
})

/** The same keys at every depth: functions compare by name only. */
const shape = (v: unknown): unknown =>
  typeof v === 'function'
    ? 'fn'
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, x]) => [k, shape(x)]),
        )
      : 'str'

describe('every language', () => {
  const langs = ['tr', 'zh', 'ja', 'es', 'pt', 'ko', 'de', 'fr', 'ru'] as const
  it('has exactly the keys of English, in all ten languages', () => {
    expect(Object.keys(TEXT).sort()).toEqual([...LANGUAGES].sort())
    for (const lang of langs) expect(shape(TEXT[lang]), lang).toEqual(shape(TEXT.en))
  })

  const titles: Record<string, [string, string, string]> = {
    zh: ['分片键', '分析', '良好'],
    ja: ['シャードキー', '分析', '良好'],
    es: ['Clave de fragmentación', 'Analizar', 'Buena'],
    pt: ['Chave de shard', 'Analisar', 'Boa'],
    ko: ['샤드 키', '분석', '좋음'],
    de: ['Shard-Schlüssel', 'Analysieren', 'Gut'],
    fr: ['Clé de partition', 'Analyser', 'Bonne'],
    ru: ['Ключ шардирования', 'Анализировать', 'Хороший'],
  }
  for (const [lang, [title, analyse, good]] of Object.entries(titles)) {
    it(`shows the page in ${lang}`, async () => {
      const { contexts } = await opened()
      await candidate(['city', 'asc'])
      contexts.forEach((fn) => fn(lang, 'light', 'emerald'))
      await flush()
      expect(text()).toContain(title)
      expect(app().querySelector('#analyze')!.textContent).toContain(analyse)
      expect(app().querySelector('#results tr[data-metric="overall"] td')!.textContent).toContain(good)
      expect(document.documentElement.lang).toBe(langTag(lang))
      // The count is formatted the way that language does it.
      const distinct = new Intl.NumberFormat(langTag(lang), { maximumFractionDigits: 0 }).format(80_000)
      expect(app().querySelector('#results tr[data-metric="distinct"] td')!.textContent).toContain(distinct)
    })
  }

  it('marks Chinese and Brazilian Portuguese with their region', async () => {
    const { contexts } = await opened()
    contexts.forEach((fn) => fn('zh', 'light', 'emerald'))
    await flush()
    expect(document.documentElement.lang).toBe('zh-CN')
    contexts.forEach((fn) => fn('pt', 'light', 'emerald'))
    await flush()
    expect(document.documentElement.lang).toBe('pt-BR')
  })

  it('falls back to English, and to the English number format, for an unknown locale', async () => {
    const { contexts } = await opened()
    await candidate(['city', 'asc'])
    contexts.forEach((fn) => fn('xx', 'light', 'emerald'))
    await flush()
    expect(text()).toContain('Shard key')
    expect(app().querySelector('#analyze')!.textContent).toContain('Analyse')
    expect(document.documentElement.lang).toBe('en')
    const distinct = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(80_000)
    expect(app().querySelector('#results tr[data-metric="distinct"] td')!.textContent).toContain(distinct)
    // The percentage follows English too.
    const share = new Intl.NumberFormat('en', { style: 'percent', maximumFractionDigits: 1 }).format(0.003)
    expect(app().querySelector('#results tr[data-metric="frequency"] td')!.textContent).toContain(share)
  })

  it('uses the English text and number format when the table lacks the locale', () => {
    const partial = { en: TEXT.en, tr: TEXT.tr }
    // Every language is present in the real table, so test against one that really lacks them.
    expect(shown(partial, 'ru')).toBe('en')
    expect(shown(partial, 'tr')).toBe('tr')
    const language = shown(partial, 'ru')
    expect(formatNumber(12345, language, 0)).toBe('12,345')
    const share = new Intl.NumberFormat(langTag(language), {
      style: 'percent',
      maximumFractionDigits: 1,
    }).format(0.003)
    expect(share).toBe(
      new Intl.NumberFormat('en', { style: 'percent', maximumFractionDigits: 1 }).format(0.003),
    )
    expect(sizeText(12345, 'xx')).toBe('12,345 bytes')
  })

  it('writes a size in the plural form each language needs', () => {
    expect(sizeText(1, 'en')).toBe('1 byte')
    expect(sizeText(2, 'en')).toBe('2 bytes')
    expect(sizeText(1.4, 'en')).toBe('1 byte')
    expect(sizeText(1, 'de')).toBe('1 Byte')
    expect(sizeText(1, 'es')).toBe('1 byte')
    expect(sizeText(1, 'pt')).toBe('1 byte')
    expect(sizeText(0, 'fr')).toBe('0 octet')
    expect(sizeText(1, 'fr')).toBe('1 octet')
    expect(sizeText(2, 'fr')).toBe('2 octets')
    expect([1, 2, 5, 11, 21, 22, 112].map((n) => sizeText(n, 'ru'))).toEqual([
      '1 байт',
      '2 байта',
      '5 байт',
      '11 байт',
      '21 байт',
      '22 байта',
      '112 байт',
    ])
    expect(sizeText(5, 'tr')).toBe('5 bayt')
  })
})
