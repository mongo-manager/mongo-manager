// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import type { Accent, PluginClient } from '../../kit/src/client'
import { LANGUAGES, formatNumber, langTag, pluralOf, shown } from '../../kit/src/ui'
import { TEXT, mount } from '../src/view'

const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0))
}
const int = (n: number) => ({ $numberInt: String(n) })
const PLACE = { connectionId: 'c', connectionName: 'Shop', db: 'shop', coll: 'orders', documentId: null }
const ORDERS = [
  { _id: int(1), total: int(10), tags: Array.from({ length: 1500 }, () => 'x') },
  { _id: int(2), total: int(12) },
  { _id: int(3), total: '14' },
]
const SIZES = { count: int(3), avg: int(900), max: int(9_000_000), over1mb: int(1), over8mb: int(1) }

function fakeClient(locale: string) {
  let ready: (() => void) | null = null
  const contexts: Array<(l: string, t: 'light' | 'dark', a: Accent) => void> = []
  const client: PluginClient = {
    contribution: { kind: 'collectionTab', id: 'health' },
    ask: async <T>(method: string, params?: unknown) => {
      if (method === 'context.get')
        return {
          plugin: { id: 'schema-health', version: '1' },
          contribution: { kind: 'collectionTab', id: 'health' },
          locale,
          theme: 'light',
          accent: 'violet',
          place: PLACE,
          settings: {},
        } as T
      if (method === 'documents.aggregate') {
        const p = params as { pipeline: unknown[] }
        return (p.pipeline.length === 1 ? { documents: ORDERS } : { documents: [SIZES] }) as T
      }
      return [] as T
    },
    onReady: (fn) => (ready = fn),
    onContext: (fn) => contexts.push(fn),
    onCells: () => {},
  }
  return { client, greet: () => ready!(), contexts }
}

beforeEach(() => {
  document.body.replaceChildren(Object.assign(document.createElement('div'), { id: 'app' }))
})

const SHAPE = (v: unknown): unknown =>
  typeof v === 'function'
    ? 'fn'
    : Array.isArray(v)
      ? v.map(SHAPE)
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SHAPE(x)]))
        : typeof v

describe('schema health speaks every added language', () => {
  const TITLES: Record<string, [string, string, string]> = {
    zh: ['模式健康度', '检查', '为什么重要'],
    ja: ['スキーマの健全性', 'チェック', '重要な理由'],
    es: ['Salud del esquema', 'Comprobar', 'Por qué importa'],
    pt: ['Integridade do esquema', 'Verificar', 'Por que isso importa'],
    ko: ['스키마 상태', '점검', '중요한 이유'],
    de: ['Schema-Zustand', 'Prüfen', 'Warum das wichtig ist'],
    fr: ['Santé du schéma', 'Vérifier', 'Pourquoi c’est important'],
    ru: ['Состояние схемы', 'Проверить', 'Почему это важно'],
  }
  for (const [lang, [title, checkLabel, why]] of Object.entries(TITLES)) {
    it(`shows its title and labels in ${lang}`, async () => {
      const { client, greet } = fakeClient(lang)
      mount(document.getElementById('app')!, client)
      greet()
      await flush()
      expect(document.querySelector('h1')!.textContent).toBe(title)
      expect(document.getElementById('check')!.textContent).toBe(checkLabel)
      expect(document.querySelector('[data-finding="mixedTypes"]')!.textContent).toContain(why)
      expect(document.documentElement.lang).toBe(langTag(lang))
    })
  }

  it('has the same keys in every language block as in English', () => {
    expect(Object.keys(TEXT).sort()).toEqual([...LANGUAGES].sort())
    for (const lang of LANGUAGES) expect(SHAPE(TEXT[lang])).toEqual(SHAPE(TEXT.en))
  })

  it('words the plural forms of German, French and Russian', () => {
    expect(TEXT.de.count(1, 'warning')).toBe('1 Warnung')
    expect(TEXT.de.count(2, 'warning')).toBe('2 Warnungen')
    expect(TEXT.de.checked(1, 1, 1)).toBe(
      '1 Dokument in der Stichprobe · Größe von 1 Dokument gemessen · 1 Index',
    )
    expect(TEXT.de.checked(5, 5, 5)).toContain('5 Dokumente in der Stichprobe')
    expect(
      TEXT.de.words.largeDocuments.found({ count: 1, max: 2_000_000 }, { shares: [], severity: 'warning' }),
    ).toContain('1 gemessenes Dokument ist')
    expect(
      TEXT.de.words.largeDocuments.found({ count: 3, max: 2_000_000 }, { shares: [], severity: 'warning' }),
    ).toContain('3 gemessene Dokumente sind')
    // French writes 0 and 1 in the singular.
    expect(TEXT.fr.count(0, 'warning')).toBe('0 avertissement')
    expect(TEXT.fr.count(1, 'warning')).toBe('1 avertissement')
    expect(TEXT.fr.count(2, 'warning')).toBe('2 avertissements')
    expect(TEXT.fr.clean(1)).toContain('1 document échantillonné')
    expect(TEXT.fr.clean(7)).toContain('7 documents échantillonnés')
    expect(
      TEXT.fr.words.largeDocuments.found({ count: 1, max: 2_000_000 }, { shares: [], severity: 'warning' }),
    ).toContain('1 document mesuré dépasse')
    // Russian has one, few and many.
    const doc = (n: number) => TEXT.ru.checked(n, null, null)
    expect(doc(1)).toContain('1 документ')
    expect(doc(21)).toContain('21 документ')
    expect(doc(2)).toContain('2 документа')
    expect(doc(24)).toContain('24 документа')
    expect(doc(5)).toContain('5 документов')
    expect(doc(11)).toContain('11 документов')
    expect(doc(12)).toContain('12 документов')
    expect(doc(0)).toContain('0 документов')
    expect(TEXT.ru.checked(1, 1, 1)).toBe('в выборке 1 документ · размер измерен у 1 документа · 1 индекс')
    expect(TEXT.ru.checked(3, 3, 3)).toBe('в выборке 3 документа · размер измерен у 3 документов · 3 индекса')
    expect(TEXT.ru.checked(1000, null, null)).toContain('документов')
    const depth = (n: number) => TEXT.ru.words.deepNesting.found({ depth: n })
    expect(depth(21)).toBe('Документы вложены на 21 уровень.')
    expect(depth(22)).toBe('Документы вложены на 22 уровня.')
    expect(depth(25)).toBe('Документы вложены на 25 уровней.')
    expect(depth(13)).toBe('Документы вложены на 13 уровней.')
    // Korean has one form.
    expect(TEXT.ko.count(1, 'warning')).toBe(TEXT.ko.count(2, 'warning').replace('2', '1'))
  })

  it('words the mixed-types finding in German, French and Russian', () => {
    const shares = [
      { type: 'number', count: 981 },
      { type: 'string', count: 19 },
    ]
    const found = (lang: 'de' | 'fr' | 'ru', s = shares) =>
      TEXT[lang].words.mixedTypes.found({ types: 'x' }, { shares: s, severity: 'info' })
    expect(found('de')).toBe('number in 981 Dokumenten der Stichprobe, string in 19.')
    expect(found('fr')).toBe('number dans 981 documents échantillonnés, string dans 19.')
    expect(found('ru')).toBe('number в 981 документе, string в 19 документах.')
    expect(found('de', [shares[1]!, { type: 'null', count: 1 }])).toContain(
      'string in 19 Dokumenten der Stichprobe',
    )
  })

  it('words the plural forms of Spanish and Brazilian Portuguese', () => {
    expect(TEXT.es.count(1, 'warning')).toBe('1 advertencia')
    expect(TEXT.es.count(2, 'warning')).toBe('2 advertencias')
    expect(TEXT.pt.count(1, 'warning')).toBe('1 aviso')
    expect(TEXT.pt.count(3, 'warning')).toBe('3 avisos')
    expect(TEXT.pt.checked(1, null, 1)).toContain('1 documento amostrado')
  })

  it('falls back to English for an unknown language', async () => {
    const { client, greet } = fakeClient('xx')
    mount(document.getElementById('app')!, client)
    greet()
    await flush()
    expect(document.querySelector('h1')!.textContent).toBe('Schema health')
    expect(document.getElementById('check')!.textContent).toBe('Check')
    expect(document.documentElement.lang).toBe('en')
    expect(document.querySelector('[data-finding="mixedTypes"]')!.textContent).toContain('Why it matters')
    expect(document.getElementById('findings')!.textContent).toContain('1,500')
  })

  it('formats the text it shows in the language of that text', () => {
    // The page is English, so numbers are formatted as English whatever the locale asked for.
    expect(TEXT.en.limits[0]).toContain(formatNumber(10_000, 'en'))
    expect(shown(TEXT, 'xx')).toBe('en')
    const partial = { en: TEXT.en, tr: TEXT.tr }
    expect(shown(partial, 'ru')).toBe('en')
    expect(formatNumber(12_345, shown(partial, 'ru'))).toBe('12,345')
    expect(formatNumber(12_345, shown(partial, 'tr'))).not.toBe('12,345')
    expect(shown(TEXT, 'ru')).toBe('ru')
    expect(shown({ en: TEXT.en }, 'ru')).toBe('en')
  })

  it('writes the dates and sizes of each language in that language', () => {
    const since = '2026-03-04T05:06:07Z'
    for (const lang of ['ko', 'de', 'fr', 'ru'] as const) {
      const words = TEXT[lang].words.unusedIndex.found({ since })
      expect(words).toContain(new Date(since).toLocaleString(langTag(lang)))
    }
  })

  it('writes the singular of the English sampled-documents line (review M16)', () => {
    expect(TEXT.en.checked(1, 1, 1)).toBe('1 document sampled · 1 measured for size · 1 index')
    expect(TEXT.en.checked(0, null, 0)).toBe('0 documents sampled · 0 indexes')
    expect(TEXT.en.checked(2, 2, 2)).toBe('2 documents sampled · 2 measured for size · 2 indexes')
    expect(TEXT.en.checked(12_345, null, null)).toBe('12,345 documents sampled')
  })

  it('writes every count in the form of its language (0, 1, 2, 5, 11, 21, 22)', () => {
    const ru = (n: number) => TEXT.ru.checked(n, null, null)
    const expected: Record<number, string> = {
      0: 'документов',
      1: 'документ',
      2: 'документа',
      5: 'документов',
      11: 'документов',
      21: 'документ',
      22: 'документа',
    }
    for (const [n, word] of Object.entries(expected)) expect(ru(Number(n))).toBe(`в выборке ${n} ${word}`)
    for (const n of [0, 1, 2, 5, 11, 21, 22]) {
      const one = pluralOf(n, 'fr') === 'one'
      expect(TEXT.fr.clean(n)).toContain(one ? 'document échantillonné' : 'documents échantillonnés')
      expect(TEXT.fr.clean(n)).not.toContain(one ? 'documents' : ' document ')
    }
    // French 0 and 1 are singular, English 0 is plural.
    expect(TEXT.fr.clean(0)).toContain('0 document échantillonné')
    expect(TEXT.en.clean(0)).toContain('0 sampled documents')
  })

  it('writes sizes as MB in every language, the number in that language (review M19, M20)', () => {
    const max = 1.3 * 1024 * 1024
    for (const lang of LANGUAGES) {
      const size = (n: number) =>
        `${new Intl.NumberFormat(lang === 'en' ? 'en-US' : langTag(lang), { maximumFractionDigits: 2 }).format(n)} MB`
      const found = TEXT[lang].words.largeDocuments.found(
        { count: 3, max },
        { shares: [], severity: 'warning' },
      )
      expect(found).toContain(size(1.3))
      expect(found).toContain(size(1))
      expect(TEXT[lang].limits[0]).toContain(size(1))
      expect(TEXT[lang].limits[0]).toContain(size(8))
      expect(TEXT[lang].limits[0]).toContain('16 MB')
      expect(TEXT[lang].limits[0]).not.toMatch(/\d (Mo|Ko|МБ|КБ)/)
    }
    // The decimal mark is the language's: 1,3 in German, French and Russian; 1.3 in English.
    expect(TEXT.de.words.largeDocuments.found({ count: 3, max }, { shares: [], severity: 'high' })).toContain(
      '1,3 MB',
    )
    expect(TEXT.fr.words.largeDocuments.found({ count: 3, max }, { shares: [], severity: 'high' })).toContain(
      '1,3 MB',
    )
    expect(TEXT.ru.words.largeDocuments.found({ count: 3, max }, { shares: [], severity: 'high' })).toContain(
      '1,3 MB',
    )
    expect(TEXT.en.words.largeDocuments.found({ count: 3, max }, { shares: [], severity: 'high' })).toContain(
      '1.3 MB',
    )
  })

  it('formats the array limits and counts in the language of the text (review M20)', () => {
    for (const lang of LANGUAGES) {
      expect(TEXT[lang].limits[1]).toContain(formatNumber(1000, lang))
      expect(TEXT[lang].limits[1]).toContain(formatNumber(10_000, lang))
      expect(TEXT[lang].words.largeArray.found({ length: 12_345 })).toContain(formatNumber(12_345, lang))
    }
    expect(TEXT.de.limits[1]).toContain('10.000')
    expect(TEXT.en.limits[1]).toContain('10,000')
  })
})
