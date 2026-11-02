// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import type { Accent, PluginClient, PluginContext } from '../../kit/src/client'
import { langTag, pick, shown as shownLanguage } from '../../kit/src/ui'
import { TEXT, mount } from '../src/view'

const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0))
}

const PLACE = {
  connectionId: 'c',
  connectionName: 'Shop',
  db: 'shop',
  coll: 'orders',
  documentId: null,
} as PluginContext['place']
const ID = { name: '_id_', key: { _id: { $numberInt: '1' } }, options: {}, usage: null }
const UNIQUE = { name: 'a_1', key: { a: { $numberInt: '1' } }, options: { unique: true }, usage: null }

function fakeClient() {
  let ready: (() => void) | null = null
  const contexts: Array<(l: string, t: 'light' | 'dark', a: Accent) => void> = []
  const client: PluginClient = {
    contribution: { kind: 'collectionTab', id: 'script' },
    ask: async <T>(method: string) => {
      if (method === 'context.get')
        return {
          plugin: { id: 'index-script', version: '1' },
          contribution: { kind: 'collectionTab', id: 'script' },
          locale: 'en',
          theme: 'light',
          accent: 'violet',
          place: PLACE,
          settings: {},
        } as T
      if (method === 'indexes.list') return [ID, UNIQUE] as T
      return true as T
    },
    onReady: (fn) => (ready = fn),
    onContext: (fn) => contexts.push(fn),
    onCells: () => {},
  }
  return { client, greet: () => ready!(), contexts }
}

/** Mounts the tab and tells it the locale. */
async function shown(locale: string) {
  const { client, greet, contexts } = fakeClient()
  mount(document.getElementById('app')!, client)
  greet()
  await flush()
  for (const fn of contexts) fn(locale, 'light', 'violet')
  return document.body.textContent ?? ''
}

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>'
})

const SHOWN: Record<string, string[]> = {
  zh: ['索引脚本', '此集合', '整个数据库', '复制', '下载'],
  ja: ['インデックススクリプト', 'このコレクション', 'データベース全体', 'コピー', 'ダウンロード'],
  es: ['Script de índices', 'Esta colección', 'Toda la base de datos', 'Copiar', 'Descargar'],
  pt: ['Script de índices', 'Esta coleção', 'O banco de dados inteiro', 'Copiar', 'Baixar'],
  ko: ['인덱스 스크립트', '이 컬렉션', '데이터베이스 전체', '복사', '다운로드'],
  de: ['Index-Skript', 'Diese Collection', 'Gesamte Datenbank', 'Kopieren', 'Herunterladen'],
  fr: ['Script d’index', 'Cette collection', 'Toute la base de données', 'Copier', 'Télécharger'],
  ru: ['Скрипт индексов', 'Эта коллекция', 'Вся база данных', 'Копировать', 'Скачать'],
}

describe('languages', () => {
  for (const [locale, words] of Object.entries(SHOWN)) {
    it(`shows its title and labels in ${locale}`, async () => {
      const page = await shown(locale)
      for (const word of words) expect(page).toContain(word)
      expect(document.documentElement.lang).toBe(langTag(locale))
    })
  }

  it('counts in the reader’s language', async () => {
    expect(await shown('zh')).toContain('1 个集合中共 1 个索引')
    expect(await shown('es')).toContain('1 índice en 1 colección')
    expect(await shown('pt')).toContain('1 índice em 1 coleção')
    expect(await shown('ja')).toContain('1 件のコレクションに 1 件のインデックス')
    expect(await shown('ko')).toContain('컬렉션 1개에 인덱스 1개')
    expect(await shown('de')).toContain('1 Index in 1 Collection')
    expect(await shown('fr')).toContain('1 index dans 1 collection')
    expect(await shown('ru')).toContain('1 индекс в 1 коллекции')
  })

  it('reads English for a language it has no words for', async () => {
    const page = await shown('xx')
    expect(page).toContain('This collection')
    expect(page).toContain('Copy')
    expect(document.documentElement.lang).toBe('en')
    expect(page).toContain('1 index in 1 collection')
  })

  it('falls back to English, with English numbers, from a table that lacks the language', () => {
    const partial = { en: TEXT.en, tr: TEXT.tr }
    expect(shownLanguage(partial, 'de')).toBe('en')
    const text = pick<typeof TEXT.en>(partial, 'de')
    expect(text.counted(12345, 2)).toBe('12,345 indexes in 2 collections')
    expect(text.counted(12345, 2)).not.toBe(TEXT.de.counted(12345, 2))
  })

  it('formats numbers in the language the words are in', () => {
    expect(TEXT.en.counted(1234, 2)).toContain(new Intl.NumberFormat('en').format(1234))
    expect(TEXT.de.counted(1234, 2)).toContain(new Intl.NumberFormat('de').format(1234))
    expect(TEXT.ru.counted(1234, 2)).toContain(new Intl.NumberFormat('ru').format(1234))
  })
})

describe('singular and plural', () => {
  const ONE: Record<string, string> = {
    en: '1 index in 1 collection',
    es: '1 índice en 1 colección',
    pt: '1 índice em 1 coleção',
    de: '1 Index in 1 Collection',
    fr: '1 index dans 1 collection',
    ru: '1 индекс в 1 коллекции',
  }
  for (const [language, one] of Object.entries(ONE))
    it(`counts one in ${language}`, () => {
      const t = TEXT[language as keyof typeof TEXT]
      expect(t.counted(1, 1)).toBe(one)
      expect(t.counted(2, 2)).not.toBe(one)
    })

  it('has a singular for one hidden index and one unordered key in every language', () => {
    for (const language of Object.keys(TEXT) as Array<keyof typeof TEXT>) {
      const t = TEXT[language]
      if (language === 'zh' || language === 'ja' || language === 'ko' || language === 'tr') continue
      expect(t.hidden(1)).not.toContain('1')
      expect(t.unordered(1)).not.toContain('1')
      expect(t.hidden(3)).toContain('3')
      expect(t.unordered(3)).toContain('3')
    }
  })

  it('writes the singular for a read of one collection', () => {
    expect(TEXT.en.readingOf(1, 1)).toContain('1 collection…')
    expect(TEXT.es.readingOf(1, 1)).toContain('1 colección…')
    expect(TEXT.pt.readingOf(1, 1)).toContain('1 coleção…')
    expect(TEXT.de.readingOf(1, 1)).toContain('1 Collection werden')
  })

  it('puts Russian counts in one, few and many', () => {
    expect(TEXT.ru.counted(1, 1)).toBe('1 индекс в 1 коллекции')
    expect(TEXT.ru.counted(21, 21)).toBe('21 индекс в 21 коллекции')
    expect(TEXT.ru.counted(2, 2)).toBe('2 индекса в 2 коллекциях')
    expect(TEXT.ru.counted(22, 5)).toBe('22 индекса в 5 коллекциях')
    expect(TEXT.ru.counted(5, 5)).toBe('5 индексов в 5 коллекциях')
    expect(TEXT.ru.counted(11, 11)).toBe('11 индексов в 11 коллекциях')
    expect(TEXT.ru.counted(0, 0)).toBe('0 индексов в 0 коллекциях')
    expect(TEXT.ru.unordered(21)).toContain('21 индекса')
    expect(TEXT.ru.unordered(5)).toContain('5 индексов')
    expect(TEXT.ru.hidden(22)).toContain('22 индекса содержат')
    expect(TEXT.ru.hidden(1)).toBe('Индекс содержит значения, скрытые от вас')
    expect(TEXT.ru.hidden(21)).toContain('21 индекс содержит')
    expect(TEXT.ru.hidden(3)).toContain('3 индекса содержат')
    expect(TEXT.ru.hidden(11)).toContain('11 индексов содержат')
  })

  it('counts zero, one and many for French, German, Spanish and Portuguese', () => {
    expect(TEXT.fr.counted(0, 0)).toBe('0 index dans 0 collection')
    expect(TEXT.fr.counted(2, 2)).toBe('2 index dans 2 collections')
    expect(TEXT.fr.hidden(0)).toContain('Un index')
    expect(TEXT.de.counted(2, 2)).toBe('2 Indizes in 2 Collections')
    expect(TEXT.de.counted(0, 0)).toBe('0 Indizes in 0 Collections')
    expect(TEXT.es.counted(2, 21)).toBe('2 índices en 21 colecciones')
    expect(TEXT.pt.counted(0, 0)).toBe('0 índice em 0 coleção')
    expect(TEXT.pt.counted(2, 2)).toBe('2 índices em 2 coleções')
  })
})

/** The shape of a value: its keys, deep for objects; a function counts as one leaf. */
function shape(value: unknown): unknown {
  if (typeof value === 'function') return 'fn'
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, shape(v)]),
    )
  return 'text'
}

describe('every language has the keys of English', () => {
  for (const language of ['tr', 'zh', 'ja', 'es', 'pt', 'ko', 'de', 'fr', 'ru'] as const) {
    it(language, () => {
      expect(shape(TEXT[language])).toEqual(shape(TEXT.en))
    })
  }

  it('writes every template function out in each language', () => {
    for (const language of ['en', 'tr', 'zh', 'ja', 'es', 'pt', 'ko', 'de', 'fr', 'ru'] as const) {
      const t = TEXT[language]
      for (const out of [
        t.description('orders'),
        t.readingOf(2, 5),
        t.counted(3, 2),
        t.hidden(1),
        t.hidden(4),
        t.skipped('a, b'),
        t.unordered(1),
        t.unordered(3),
        t.more(100),
      ])
        expect(out).not.toMatch(/undefined|\[object/)
    }
  })
})
