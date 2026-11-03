// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import type { Accent, PluginClient } from '../../kit/src/client'
import { formatNumber, langTag, pick as pickText, pluralOf, shown, type Language } from '../../kit/src/ui'
import { TEXT, mount } from '../src/view'

const flush = () => new Promise((r) => setTimeout(r, 0))
const app = () => document.getElementById('app')!

/** The shape of a text block: object keys deep, functions as leaves. */
function shape(value: unknown): unknown {
  if (typeof value === 'function') return 'fn'
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shape(v)]))
  return typeof value
}

function mounted(locale: string) {
  const contexts: Array<(l: string, t: 'light' | 'dark', a: Accent) => void> = []
  let ready: (() => void) | null = null
  const client: PluginClient = {
    contribution: { kind: 'collectionTab', id: 'search' },
    ask: async <T>(method: string) => {
      if (method === 'context.get')
        return {
          plugin: { id: 'value-search', version: '1' },
          contribution: { kind: 'collectionTab', id: 'search' },
          locale,
          theme: 'light',
          accent: 'ocean',
          place: { connectionId: 'c', connectionName: 'Shop', db: 'shop', coll: 'orders', documentId: null },
          settings: {},
        } as T
      return { documents: [] } as T
    },
    onReady: (fn) => (ready = fn),
    onContext: (fn) => contexts.push(fn),
    onCells: () => {},
  }
  mount(app(), client)
  return async () => {
    ready!()
    await flush()
    await flush()
  }
}

beforeEach(() => {
  document.body.replaceChildren(Object.assign(document.createElement('div'), { id: 'app' }))
})

describe('value search languages', () => {
  it('every language block has the same keys as English', () => {
    for (const lang of ['tr', 'zh', 'ja', 'es', 'pt', 'ko', 'de', 'fr', 'ru'] as const) {
      expect(shape(TEXT[lang]), lang).toEqual(shape(TEXT.en))
    }
  })

  it.each([
    ['zh', 'zh-CN', '值搜索'],
    ['ja', 'ja', '値の検索'],
    ['es', 'es', 'Búsqueda de valores'],
    ['pt', 'pt-BR', 'Busca de valores'],
    ['ko', 'ko', '값 검색'],
    ['de', 'de', 'Wertsuche'],
    ['fr', 'fr', 'Recherche de valeurs'],
    ['ru', 'ru', 'Поиск значений'],
  ])('shows the page in %s', async (locale, tag, title) => {
    const greet = mounted(locale)
    await greet()
    expect(document.querySelector('h1')!.textContent).toBe(title)
    expect(document.documentElement.lang).toBe(tag)
    expect(document.getElementById('find')!.textContent).toBe(
      TEXT[locale as 'zh' | 'ja' | 'es' | 'pt' | 'ko' | 'de' | 'fr' | 'ru'].find,
    )
    expect(app().textContent).toContain(
      TEXT[locale as 'zh' | 'ja' | 'es' | 'pt' | 'ko' | 'de' | 'fr' | 'ru'].emptyTitle,
    )
  })

  it('falls back to English for an unknown language', async () => {
    const greet = mounted('xx')
    await greet()
    expect(document.querySelector('h1')!.textContent).toBe('Value search')
    expect(document.documentElement.lang).toBe('en')
    expect(document.getElementById('find')!.textContent).toBe(TEXT.en.find)
  })

  it('gives each language the plural form its rules ask for, for a count of documents', () => {
    const one = (l: Language, n: number) => TEXT[l].found(String(n), false, pluralOf(n, l))
    expect(one('en', 1)).toBe('1 document')
    expect(one('en', 0)).toBe('0 documents')
    expect(one('es', 1)).toBe('1 documento')
    expect(one('es', 2)).toBe('2 documentos')
    expect(one('pt', 1)).toBe('1 documento')
    expect(one('pt', 5)).toBe('5 documentos')
    expect(one('de', 1)).toBe('1 Dokument')
    expect(one('de', 3)).toBe('3 Dokumente')
    expect(one('fr', 0)).toBe('0 document')
    expect(one('fr', 1)).toBe('1 document')
    expect(one('fr', 2)).toBe('2 documents')
    expect(TEXT.fr.found('3', true, 'other')).toBe('3+ documents')
    expect(one('ko', 3)).toBe('3개 도큐먼트')
    const ru = [1, 2, 5, 11, 21, 22, 24, 25].map((n) => one('ru', n))
    expect(ru).toEqual([
      '1 документ',
      '2 документа',
      '5 документов',
      '11 документов',
      '21 документ',
      '22 документа',
      '24 документа',
      '25 документов',
    ])
    expect(TEXT.ru.found('100', true, 'many')).toBe('100+ документов')
  })

  it('gives each language the plural form its rules ask for, for a count of fields', () => {
    const inF = (l: Language, n: number) => TEXT[l].inFields(n, 'whole', pluralOf(n, l))
    const none = (l: Language, n: number) => TEXT[l].noneHint(n, 'whole', pluralOf(n, l))
    expect(inF('en', 1)).toContain('1 field ·')
    expect(inF('en', 2)).toContain('2 fields ·')
    expect(none('en', 1)).toContain('Looked in 1 field of')
    expect(none('en', 3)).toContain('Looked in 3 fields of')
    expect(inF('es', 1)).toContain('1 campo ·')
    expect(inF('es', 4)).toContain('4 campos ·')
    expect(none('es', 1)).toContain('en 1 campo de')
    expect(none('es', 4)).toContain('en 4 campos de')
    expect(inF('pt', 1)).toContain('1 campo ·')
    expect(inF('pt', 4)).toContain('4 campos ·')
    expect(none('pt', 1)).toContain('Foi verificado 1 campo da')
    expect(none('pt', 4)).toContain('Foram verificados 4 campos da')
    expect(inF('de', 1)).toContain('1 Feld ·')
    expect(inF('de', 4)).toContain('4 Felder ·')
    expect(none('de', 1)).toContain('in 1 Feld der')
    expect(none('de', 4)).toContain('in 4 Feldern der')
    expect(inF('fr', 0)).toContain('0 champ ·')
    expect(inF('fr', 1)).toContain('1 champ ·')
    expect(inF('fr', 4)).toContain('4 champs ·')
    expect(none('fr', 1)).toContain('dans 1 champ de')
    expect(none('fr', 4)).toContain('dans 4 champs de')
    expect(inF('ru', 1)).toContain('1 поле ·')
    expect(inF('ru', 3)).toContain('3 поля ·')
    expect(inF('ru', 11)).toContain('11 полей ·')
    expect(inF('ru', 21)).toContain('21 поле ·')
    expect(inF('ru', 22)).toContain('22 поля ·')
    expect(none('ru', 21)).toContain('21 полю')
    expect(none('ru', 22)).toContain('22 полям')
    expect(none('ru', 11)).toContain('11 полям')
  })

  it('reads English, with English numbers, in a language the plugin has no words for', () => {
    const partial = { en: TEXT.en, tr: TEXT.tr }
    const language = shown(partial, 'de')
    expect(language).toBe('en')
    expect(pickText<(typeof TEXT)['en']>(partial, 'de')).toBe(TEXT.en)
    expect(formatNumber(12345, language)).toBe('12,345')
    expect(formatNumber(12345, 'de')).not.toBe('12,345')
    expect(langTag(language)).toBe('en')
    expect(shown(partial, 'tr')).toBe('tr')
  })

  it('marks the page English when the locale is unknown', async () => {
    const greet = mounted('xx')
    await greet()
    expect(document.documentElement.lang).toBe('en')
    expect(app().textContent).toContain(TEXT.en.emptyTitle)
  })
})
