// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import type { PluginClient } from '../../kit/src/client'
import { LANGUAGES, formatNumber, pick, shown } from '../../kit/src/ui'
import { TEXT, mount, type Text } from '../src/view'

const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0))
}

async function mounted(locale: string) {
  const client: PluginClient = {
    contribution: { kind: 'collectionTab', id: 'duplicates' },
    ask: async <T>(method: string) => {
      if (method === 'context.get')
        return {
          plugin: { id: 'duplicate-finder', version: '1' },
          contribution: { kind: 'collectionTab', id: 'duplicates' },
          locale,
          theme: 'light',
          accent: 'violet',
          place: { connectionId: 'c', connectionName: 'Shop', db: 'shop', coll: 'people', documentId: null },
          settings: {},
        } as T
      return { documents: [] } as T
    },
    onReady: (fn) => void fn(),
    onContext: () => {},
    onCells: () => {},
  }
  document.body.replaceChildren(Object.assign(document.createElement('div'), { id: 'app' }))
  mount(document.getElementById('app')!, client)
  await flush()
}

/** The shape of a value: object keys deeply; a function by its name only. */
function shape(value: unknown): unknown {
  if (typeof value === 'function') return 'fn'
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shape(v)]))
  return typeof value
}

beforeEach(() => {
  document.body.replaceChildren()
})

describe('the duplicate finder in every language', () => {
  const cases: Array<[string, string, string, string]> = [
    ['zh', '重复项', '查找重复项', 'zh-CN'],
    ['ja', '重複', '重複を検索', 'ja'],
    ['es', 'Duplicados', 'Buscar duplicados', 'es'],
    ['pt', 'Duplicados', 'Encontrar duplicados', 'pt-BR'],
    ['tr', 'Yinelenenler', 'Yinelenenleri bul', 'tr'],
    ['ko', '중복', '중복 찾기', 'ko'],
    ['de', 'Duplikate', 'Duplikate suchen', 'de'],
    ['fr', 'Doublons', 'Rechercher les doublons', 'fr'],
    ['ru', 'Дубликаты', 'Найти дубликаты', 'ru'],
  ]
  for (const [locale, title, find, lang] of cases) {
    it(`shows its title and labels in ${locale}`, async () => {
      await mounted(locale)
      expect(document.querySelector('h1')!.textContent).toBe(title)
      expect(document.getElementById('find')!.textContent).toBe(find)
      expect(document.documentElement.lang).toBe(lang)
    })
  }

  it('reads English for an unknown locale', async () => {
    await mounted('xx')
    expect(document.querySelector('h1')!.textContent).toBe('Duplicates')
    expect(document.getElementById('find')!.textContent).toBe('Find duplicates')
    expect(document.documentElement.lang).toBe('en')
  })

  it('has, in each language, exactly the keys of English', () => {
    const texts: Record<string, unknown> = TEXT
    expect(Object.keys(texts).sort()).toEqual([...LANGUAGES].sort())
    for (const language of LANGUAGES) expect(shape(texts[language]), language).toEqual(shape(TEXT.en))
  })

  it('falls back to English text and English number format for a language the table lacks', () => {
    const partial = { en: TEXT.en, tr: TEXT.tr }
    const language = shown(partial, 'ru')
    expect(language).toBe('en')
    expect(pick<Text>(partial, 'ru')).toBe(TEXT.en)
    expect(formatNumber(12345, language, 0)).toBe('12,345')
    expect(formatNumber(12345, shown(partial, 'tr'), 0)).toBe(new Intl.NumberFormat('tr-TR').format(12345))
    expect(formatNumber(12345, shown(TEXT, 'de'), 0)).toBe(new Intl.NumberFormat('de').format(12345))
  })

  it('marks the page in English for an unknown locale', async () => {
    await mounted('xx')
    expect(document.documentElement.lang).toBe('en')
    expect(document.querySelector('h1')!.textContent).toBe('Duplicates')
  })

  it('keeps the pluralised words right in German and French', () => {
    expect(TEXT.de.found('1', false)).toBe('1 doppelter Wert')
    expect(TEXT.de.found('2', false)).toBe('2 doppelte Werte')
    expect(TEXT.de.found('1', true)).toBe('1+ doppelte Werte')
    expect(TEXT.de.involved('1', false)).toBe('1 beteiligtes Dokument')
    expect(TEXT.de.involved('7', false)).toBe('7 beteiligte Dokumente')
    expect(TEXT.fr.found('0', false)).toBe('0 valeur en double')
    expect(TEXT.fr.found('1', false)).toBe('1 valeur en double')
    expect(TEXT.fr.found('2', false)).toBe('2 valeurs en double')
    expect(TEXT.fr.involved('1', false)).toBe('1 document concerné')
    expect(TEXT.fr.involved('200', true)).toBe('200+ documents concernés')
  })

  it('gives Russian its three forms, one, few and many', () => {
    const found = (n: string, more = false) => TEXT.ru.found(n, more)
    expect(found('1')).toBe('1 повторяющееся значение')
    expect(found('21')).toBe('21 повторяющееся значение')
    expect(found('2')).toBe('2 повторяющихся значения')
    expect(found('22')).toBe('22 повторяющихся значения')
    expect(found('24')).toBe('24 повторяющихся значения')
    expect(found('5')).toBe('5 повторяющихся значений')
    expect(found('11')).toBe('11 повторяющихся значений')
    expect(found('12')).toBe('12 повторяющихся значений')
    expect(found('0')).toBe('0 повторяющихся значений')
    // A count with a thousands separator is read as the number it is.
    expect(found('1 021')).toBe('1 021 повторяющееся значение')
    expect(found('200', true)).toBe('200+ повторяющихся значений')
    expect(TEXT.ru.involved('1', false)).toBe('1 затронутый документ')
    expect(TEXT.ru.involved('3', false)).toBe('3 затронутых документа')
    expect(TEXT.ru.involved('15', false)).toBe('15 затронутых документов')
  })

  it('keeps Korean to one form', () => {
    expect(TEXT.ko.found('1', false)).toBe('중복 값 1개')
    expect(TEXT.ko.found('200', true)).toBe('중복 값 200+개')
    expect(TEXT.ko.involved('2', false)).toBe('관련 도큐먼트 2개')
  })

  it('keeps the pluralised words right in Spanish and Portuguese', () => {
    expect(TEXT.es.found('1', false)).toBe('1 valor duplicado')
    expect(TEXT.es.found('2', false)).toBe('2 valores duplicados')
    expect(TEXT.pt.involved('1', false)).toBe('1 documento envolvido')
    expect(TEXT.pt.involved('200', true)).toBe('200+ documentos envolvidos')
  })
})
