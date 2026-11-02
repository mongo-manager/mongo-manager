// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import type { Accent, PluginClient } from '../../kit/src/client'
import { LANGUAGES, formatNumber, langTag, pick, pluralOf, shown, type Language } from '../../kit/src/ui'
import { mount, TEXT, type Text } from '../src/view'

const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0))
}

/** A client with no document place: the page shows its title and the "open from a menu" note. */
function client(locale: string, docs?: Record<string, Record<string, unknown>>) {
  let ready: (() => void) | null = null
  const contexts: Array<(l: string, t: 'light' | 'dark', a: Accent) => void> = []
  const c: PluginClient = {
    contribution: { kind: 'documentAction', id: 'compare' },
    ask: async <T>(method: string, params?: unknown) => {
      if (method === 'context.get')
        return {
          plugin: { id: 'document-diff', version: '1' },
          contribution: { kind: 'documentAction', id: 'compare' },
          locale,
          theme: 'light',
          accent: 'indigo',
          place: docs
            ? { connectionId: 'c', connectionName: 'Shop', db: 'shop', coll: 'people', documentId: 'a' }
            : null,
          settings: {},
        } as T
      if (docs && method === 'documents.get') return (docs[(params as { id: string }).id] ?? null) as T
      if (docs && method === 'documents.find') return { documents: [] } as T
      return null as T
    },
    onReady: (fn) => (ready = fn),
    onContext: (fn) => contexts.push(fn),
    onCells: () => {},
  }
  return { c, greet: () => ready!(), contexts }
}

const app = () => document.getElementById('app')!

beforeEach(() => {
  document.body.replaceChildren(Object.assign(document.createElement('div'), { id: 'app' }))
})

/** The shape of a text block: its keys, deeply; a function counts by its name only. */
function shape(value: unknown): unknown {
  if (typeof value === 'function') return 'function'
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, shape(v)]),
    )
  return typeof value
}

describe('languages', () => {
  const added = ['zh', 'ja', 'es', 'pt', 'ko', 'de', 'fr', 'ru'] as const

  it('keeps the same keys in every language as in English', () => {
    for (const lang of LANGUAGES) {
      expect(TEXT[lang], lang).toBeDefined()
      expect(shape(TEXT[lang]), lang).toEqual(shape(TEXT.en))
    }
  })

  it('has no empty text, and every template function says its number', () => {
    for (const lang of added) {
      const t = TEXT[lang]
      for (const [k, v] of Object.entries(t)) {
        if (typeof v === 'string') expect(v.trim().length, `${lang}.${k}`).toBeGreaterThan(0)
      }
      for (const fn of Object.values(t.counts)) {
        expect(fn('7', 'other')).toContain('7')
        expect(fn('1', 'one')).toContain('1')
      }
      expect(t.sameHint('3', 'other')).toContain('3')
    }
  })

  /** The text of a count in a language, the plural category taken as the app takes it. */
  const changed = (lang: Language, n: number) => TEXT[lang].counts.changed(String(n), pluralOf(n, lang))
  const same = (lang: Language, n: number) => TEXT[lang].counts.same(String(n), pluralOf(n, lang))
  const hint = (lang: Language, n: number) => TEXT[lang].sameHint(String(n), pluralOf(n, lang))

  it('gives every language its singular for one', () => {
    expect(changed('es', 1)).toBe('1 cambiado')
    expect(changed('es', 2)).toBe('2 cambiados')
    expect(changed('pt', 1)).toBe('1 alterado')
    expect(changed('pt', 2)).toBe('2 alterados')
    expect(changed('fr', 1)).toBe('1 modifié')
    expect(changed('fr', 0)).toBe('0 modifié')
    expect(changed('fr', 2)).toBe('2 modifiés')
    expect(same('es', 1)).toBe('1 igual')
    expect(same('pt', 1)).toBe('1 igual')
    expect(same('fr', 1)).toBe('1 identique')
    expect(hint('en', 1)).toContain('1 field,')
    expect(hint('en', 2)).toContain('2 fields,')
    expect(hint('es', 1)).toContain('1 campo,')
    expect(hint('pt', 1)).toContain('1 campo,')
    expect(hint('de', 1)).toContain('1 Feld,')
    expect(hint('de', 2)).toContain('2 Felder,')
    expect(hint('fr', 0)).toContain('0 champ,')
    expect(hint('fr', 2)).toContain('2 champs,')
  })

  it('declines Russian fields as one, few and many', () => {
    const word = (n: number) => hint('ru', n).split(' ')[1]!.replace(',', '')
    for (const n of [1, 21, 101]) expect(word(n), String(n)).toBe('поле')
    for (const n of [2, 3, 4, 22, 24, 102]) expect(word(n), String(n)).toBe('поля')
    for (const n of [0, 5, 11, 12, 14, 20, 25, 111]) expect(word(n), String(n)).toBe('полей')
  })

  it('words Russian changed counts without a number-dependent form', () => {
    for (const n of [0, 1, 2, 5, 11, 21, 22]) expect(changed('ru', n), String(n)).toBe(`Изменено: ${n}`)
  })

  const titles = {
    zh: '比较文档',
    ja: 'ドキュメントを比較',
    es: 'Comparar documentos',
    pt: 'Comparar documentos',
    ko: '도큐먼트 비교',
    de: 'Dokumente vergleichen',
    fr: 'Comparer des documents',
    ru: 'Сравнение документов',
  } as const satisfies Record<(typeof added)[number], string>
  const notes = {
    zh: '请从文档的菜单中打开此功能进行比较。',
    ja: '比較するには、ドキュメントのメニューからこれを開いてください。',
    es: 'Ábrelo desde el menú de un documento para compararlo.',
    pt: 'Abra isto pelo menu de um documento para compará-lo.',
    ko: '비교하려면 도큐먼트의 메뉴에서 여세요.',
    de: 'Öffnen Sie dies über das Menü eines Dokuments, um es zu vergleichen.',
    fr: 'Ouvrez ceci depuis le menu d’un document pour le comparer.',
    ru: 'Откройте это из меню документа, чтобы сравнить его.',
  } as const satisfies Record<(typeof added)[number], string>

  for (const lang of added)
    it(`shows its title and main labels in ${lang}`, async () => {
      const { c, greet } = client(lang)
      mount(app(), c)
      greet()
      await flush()
      expect(document.querySelector('h1')!.textContent).toBe(titles[lang])
      expect(app().textContent).toContain(notes[lang])
      expect(document.getElementById('compare')!.textContent).toContain(TEXT[lang].compare)
      expect(document.documentElement.lang).toBe(langTag(lang))
    })

  it('re-words the page when the app changes language', async () => {
    const { c, greet, contexts } = client('en')
    mount(app(), c)
    greet()
    await flush()
    expect(document.querySelector('h1')!.textContent).toBe('Compare documents')
    contexts[0]!('ja', 'light', 'indigo')
    expect(document.querySelector('h1')!.textContent).toBe(titles.ja)
    contexts[0]!('ru', 'light', 'indigo')
    expect(document.querySelector('h1')!.textContent).toBe(titles.ru)
    expect(document.documentElement.lang).toBe('ru')
  })

  it('falls back to English, with English numbers, for a table that lacks the language', () => {
    const partial = { en: TEXT.en, tr: TEXT.tr }
    expect(shown(partial, 'de')).toBe('en')
    expect(pick<Text>(partial, 'de').title).toBe(TEXT.en.title)
    expect(shown(partial, 'tr')).toBe('tr')
    expect(formatNumber(12345, shown(partial, 'de'))).toBe('12,345')
    expect(formatNumber(12345, shown(partial, 'tr'))).toBe(new Intl.NumberFormat('tr').format(12345))
  })

  it('reads English, marked and numbered as English, for a language it has no words for', async () => {
    // 1,200 changed fields: the badge shows the number as the language shown writes it.
    const wide = (id: string) =>
      Object.fromEntries([['_id', id], ...Array.from({ length: 1200 }, (_, i) => [`f${i}`, id])])
    const docs = { a: wide('a'), b: wide('b') }
    const badge = async (locale: string) => {
      document.body.replaceChildren(Object.assign(document.createElement('div'), { id: 'app' }))
      const { c, greet } = client(locale, docs)
      mount(app(), c)
      greet()
      await flush()
      const box = document.getElementById('other') as HTMLInputElement
      box.value = 'b'
      document.getElementById('compare')!.click()
      await flush()
      return document.querySelector('#status .mm-badge')!.textContent!
    }
    expect(await badge('xx')).toContain(formatNumber(1200, 'en'))
    expect(document.documentElement.lang).toBe('en')
    expect(await badge('de')).toContain(formatNumber(1200, 'de'))
    expect(document.documentElement.lang).toBe('de')
    expect(formatNumber(1200, 'de')).not.toBe(formatNumber(1200, 'en'))
  })
})
