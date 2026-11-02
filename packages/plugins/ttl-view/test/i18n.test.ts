// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import type { Accent, PluginClient } from '../../kit/src/client'
import { LANGUAGES, pick, shown, type Language } from '../../kit/src/i18n'
import { formatNumber } from '../../kit/src/ui'
import { duration, ttlIndexes } from '../src/ttl'
import { TEXT, mount } from '../src/view'

const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0))
}

const int = (n: number) => ({ $numberInt: String(n) })

const shape = (v: unknown): unknown =>
  typeof v === 'function'
    ? 'fn'
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.entries(v)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, x]) => [k, shape(x)]),
        )
      : typeof v

function greeted(locale: string, counts = false) {
  const contexts: Array<(l: string, t: 'light' | 'dark', a: Accent) => void> = []
  const ready: Array<() => void | Promise<void>> = []
  const client = {
    contribution: { kind: 'collectionTab', id: 'expiry' },
    ask: async (method: string) => {
      if (method === 'context.get')
        return {
          contribution: { kind: 'collectionTab', id: 'expiry' },
          locale,
          theme: 'light',
          accent: 'violet',
          place: { coll: 'sessions', view: false },
        }
      if (method === 'indexes.list')
        return counts
          ? [{ name: 'lastSeen_1', key: { lastSeen: int(1) }, options: { expireAfterSeconds: int(86400) } }]
          : []
      return { documents: counts ? [{ n: int(1234) }] : [] }
    },
    onContext: (fn: (typeof contexts)[number]) => void contexts.push(fn),
    onReady: (fn: () => void | Promise<void>) => void ready.push(fn),
  } as unknown as PluginClient
  const root = document.createElement('div')
  document.body.replaceChildren(root)
  mount(root, client)
  for (const fn of ready) void fn()
  return { root, contexts }
}

const NEW = ['ko', 'de', 'fr', 'ru'] as const
const ALL = ['tr', 'zh', 'ja', 'es', 'pt', ...NEW] as const

describe('languages', () => {
  it('has a block for each shipped language with the same keys as English', () => {
    for (const lang of ALL) {
      expect(LANGUAGES).toContain(lang)
      expect(shape(TEXT[lang])).toEqual(shape(TEXT.en))
    }
    expect(Object.keys(TEXT).sort()).toEqual([...LANGUAGES].sort())
  })

  const titles = {
    zh: '到期',
    ja: '有効期限',
    es: 'Caducidad',
    pt: 'Expiração',
    ko: '만료',
    de: 'Ablauf',
    fr: 'Expiration',
    ru: 'Срок действия',
  } as const
  const none = {
    zh: '此集合没有 TTL 索引',
    ja: 'このコレクションには TTL インデックスがありません',
    es: 'Esta colección no tiene ningún índice TTL',
    pt: 'Esta coleção não tem índice TTL',
    ko: '이 컬렉션에는 TTL 인덱스가 없습니다',
    de: 'Diese Collection hat keinen TTL-Index',
    fr: 'Cette collection n’a aucun index TTL',
    ru: 'В этой коллекции нет TTL-индекса',
  } as const
  for (const lang of ['zh', 'ja', 'es', 'pt', ...NEW] as const)
    it(`shows the page in ${lang}`, async () => {
      const { root } = greeted(lang)
      await flush()
      expect(root.textContent).toContain(titles[lang])
      expect(root.textContent).toContain(none[lang])
      expect(document.documentElement.lang).toBe(lang === 'zh' ? 'zh-CN' : lang === 'pt' ? 'pt-BR' : lang)
    })

  it('falls back to English, in words, lang and numbers, for an unknown locale', async () => {
    const { root } = greeted('xx', true)
    await flush()
    expect(root.textContent).toContain('1 day after its lastSeen')
    expect(root.textContent).toContain(new Intl.NumberFormat('en-US').format(1234))
    expect(document.documentElement.lang).toBe('en')
  })

  it('falls back to English words and number format when the plugin lacks the locale', () => {
    const partial = { en: { n: 'en' }, tr: { n: 'tr' } }
    expect(shown(partial, 'de')).toBe('en')
    expect(shown(partial, 'tr')).toBe('tr')
    expect(pick(partial, 'ru')).toBe(partial.en)
    expect(formatNumber(12345, shown(partial, 'de'))).toBe('12,345')
    expect(formatNumber(12345, shown(partial, 'tr'))).toBe(new Intl.NumberFormat('tr-TR').format(12345))
  })

  it('formats counts in the language of the words', async () => {
    const { root } = greeted('de', true)
    await flush()
    expect(root.textContent).toContain(`${new Intl.NumberFormat('de').format(1234)} Dokumente`)
  })

  it('words a duration in each language', () => {
    expect(duration(86_400, 'zh')).toBe('1 天后')
    expect(duration(7200, 'ja')).toBe('2時間後')
    expect(duration(86_400 * 7, 'es')).toBe('1 semana después')
    expect(duration(120, 'pt')).toBe('2 minutos depois')
    expect(duration(3600, 'xx')).toBe('1 hour after it')
    expect(duration(3600, 'ko')).toBe('1시간 후')
    expect(duration(7200, 'de')).toBe('2 Stunden nach dem Datum')
    expect(duration(86_400, 'de')).toBe('1 Tag nach dem Datum')
    expect(duration(1, 'fr')).toBe('1 seconde après la date')
    expect(duration(90, 'fr')).toBe('90 secondes après la date')
  })

  it('gives Russian the one, few and many forms of a unit, in the accusative after "через"', () => {
    expect(duration(3600, 'ru')).toBe('через 1 час')
    expect(duration(2 * 3600, 'ru')).toBe('через 2 часа')
    expect(duration(5 * 3600, 'ru')).toBe('через 5 часов')
    expect(duration(11 * 3600, 'ru')).toBe('через 11 часов')
    expect(duration(21 * 3600, 'ru')).toBe('через 21 час')
    expect(duration(22 * 3600, 'ru')).toBe('через 22 часа')
    expect(duration(2 * 86_400, 'ru')).toBe('через 2 дня')
    expect(duration(3 * 604_800, 'ru')).toBe('через 3 недели')
    expect(duration(45, 'ru')).toBe('через 45 секунд')
    expect(duration(60, 'ru')).toBe('через 1 минуту')
    expect(duration(604_800, 'ru')).toBe('через 1 неделю')
    expect(duration(1, 'ru')).toBe('через 1 секунду')
    expect(duration(1260, 'ru')).toBe('через 21 минуту')
    expect(duration(11 * 604_800, 'ru')).toBe('через 11 недель')
  })

  it('formats the number of a duration in the language and picks the form of a decimal', () => {
    const n = (v: number, l: string) => new Intl.NumberFormat(l, { maximumFractionDigits: 2 }).format(v)
    expect(duration(1.5, 'ru')).toBe(`через ${n(1.5, 'ru')} секунды`)
    expect(duration(1.5, 'fr')).toBe(`${n(1.5, 'fr')} seconde après la date`)
    expect(duration(1.5, 'en')).toBe('1.5 seconds after it')
    expect(duration(1.5, 'de')).toBe(`${n(1.5, 'de')} Sekunden nach dem Datum`)
    expect(duration(86_400 * 7 * 1000, 'de')).toBe(`${n(1000, 'de')} Wochen nach dem Datum`)
    expect(duration(100_000, 'en')).toBe('100,000 seconds after it')
  })

  it('counts documents with the right singular and plural', () => {
    expect(TEXT.en.documents('1', 1)).toBe('1 document')
    expect(TEXT.en.documents('2', 2)).toBe('2 documents')
    expect(TEXT.de.documents('1', 1)).toBe('1 Dokument')
    expect(TEXT.de.documents('2', 2)).toBe('2 Dokumente')
    expect(TEXT.fr.documents('0', 0)).toBe('0 document')
    expect(TEXT.fr.documents('1', 1)).toBe('1 document')
    expect(TEXT.fr.documents('2', 2)).toBe('2 documents')
    expect(TEXT.ko.documents('1')).toBe('1개 도큐먼트')
    expect(TEXT.ru.documents('1', 1)).toBe('1 документ')
    expect(TEXT.ru.documents('3', 3)).toBe('3 документа')
    expect(TEXT.ru.documents('5', 5)).toBe('5 документов')
    expect(TEXT.ru.documents('0', 0)).toBe('0 документов')
    expect(TEXT.ru.documents('11', 11)).toBe('11 документов')
    expect(TEXT.ru.documents('21', 21)).toBe('21 документ')
    expect(TEXT.es.documents('1', 1)).toBe('1 documento')
    expect(TEXT.pt.documents('2', 2)).toBe('2 documentos')
  })
})

describe('what an index removes, in words', () => {
  const index = (seconds: number) =>
    ttlIndexes([
      { name: 'lastSeen_1', key: { lastSeen: int(1) }, options: { expireAfterSeconds: int(seconds) } },
    ])[0]!
  const removes = (lang: Language, seconds: number) => {
    const ttl = index(seconds)
    return TEXT[lang].removes(ttl.field, duration(ttl.after, lang), ttl.after === 0)
  }

  const day = {
    en: 'Removes a document 1 day after its lastSeen',
    tr: 'Bir belgeyi lastSeen alanındaki tarihten 1 gün sonra siler',
    ko: '도큐먼트를 lastSeen 필드의 날짜 1일 후에 삭제합니다',
    de: 'Entfernt ein Dokument 1 Tag nach dem Datum im Feld lastSeen',
    fr: 'Supprime un document 1 jour après la date du champ lastSeen',
    ru: 'Удаляет документ через 1 день после даты в поле lastSeen',
  } as const
  const zero = {
    en: 'Removes a document at the field’s date',
    tr: 'Bir belgeyi lastSeen alanındaki tarihte siler',
    ko: '도큐먼트를 lastSeen 필드의 날짜에 삭제합니다',
    de: 'Entfernt ein Dokument zum Datum im Feld lastSeen',
    fr: 'Supprime un document à la date du champ lastSeen',
    ru: 'Удаляет документ в момент даты в поле lastSeen',
  } as const
  for (const lang of ['en', 'tr', 'ko', 'de', 'fr', 'ru'] as const)
    it(`reads right in ${lang}, for a day and for zero seconds`, () => {
      expect(removes(lang, 86_400)).toBe(day[lang])
      expect(removes(lang, 0)).toBe(zero[lang])
    })

  it('names the field and the wait in every language', () => {
    for (const lang of LANGUAGES) {
      expect(removes(lang, 3600)).toContain('lastSeen')
      if (lang !== 'en') expect(removes(lang, 0)).toContain('lastSeen')
      expect(removes(lang, 0)).not.toBe(removes(lang, 3600))
    }
  })
})
