// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import type { Accent, PluginClient } from '../../kit/src/client'
import { LANGUAGES, langTag, pick, shown } from '../../kit/src/i18n'
import { formatNumber } from '../../kit/src/ui'
import { isOne, ru } from '../src/plural'
import { MISSING, createRenderer } from '../src/renderer'

import { TEXT as REFERENCED_TEXT, mountReferenced } from '../src/referencedView'
import { TEXT as VIEW_TEXT, mount } from '../src/view'

const NEW = ['zh', 'ja', 'es', 'pt', 'ko', 'de', 'fr', 'ru'] as const

/** The shape of a text table: its keys, deeply, with functions marked as such. */
function shape(value: unknown): unknown {
  if (typeof value === 'function') return 'fn'
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, shape(v)]),
    )
  return typeof value
}

function fakeClient(kind: 'collectionTab' | 'documentAction') {
  let ready: (() => void) | null = null
  const contexts: Array<(l: string, t: 'light' | 'dark', a: Accent) => void> = []
  const client: PluginClient = {
    contribution: { kind, id: 'x' },
    ask: async <T>(method: string) => {
      if (method !== 'context.get') throw new Error(`unexpected ${method}`)
      return {
        plugin: { id: 'references', version: '1' },
        contribution: { kind, id: 'x' },
        locale: 'en',
        theme: 'light',
        accent: 'ocean',
        place: null,
        settings: {},
      } as T
    },
    onReady: (fn) => (ready = fn),
    onContext: (fn) => contexts.push(fn),
    onCells: () => {},
  }
  return {
    client,
    async open(locale: string) {
      ready!()
      for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0))
      for (const fn of contexts) fn(locale, 'light', 'ocean')
    },
  }
}

describe('the languages of the references plugin', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="app"></div>'
  })

  it('has every new language in every text table, with exactly the keys of English', () => {
    for (const table of [VIEW_TEXT, REFERENCED_TEXT] as Array<Record<string, unknown>>) {
      for (const lang of NEW) expect(table[lang], lang).toBeDefined()
      for (const lang of Object.keys(table)) {
        expect(LANGUAGES as readonly string[]).toContain(lang)
        expect(shape(table[lang]), lang).toEqual(shape(table.en))
      }
    }
    for (const lang of NEW) expect(MISSING[lang]).toBeTruthy()
  })

  it('leaves no new language in English', () => {
    for (const lang of NEW) {
      expect(VIEW_TEXT[lang].title).toBeTruthy()
      expect(VIEW_TEXT[lang].find).not.toBe(VIEW_TEXT.en.find)
      expect(REFERENCED_TEXT[lang].none).not.toBe(REFERENCED_TEXT.en.none)
      expect(MISSING[lang]).not.toBe(MISSING.en)
    }
  })

  it.each([
    ['zh', '引用', '查找引用'],
    ['ja', '参照', '参照を検索'],
    ['es', 'Referencias', 'Buscar referencias'],
    ['pt', 'Referências', 'Encontrar referências'],
    ['ko', '참조', '참조 찾기'],
    ['de', 'Referenzen', 'Referenzen suchen'],
    ['fr', 'Références', 'Rechercher les références'],
    ['ru', 'Ссылки', 'Найти ссылки'],
  ])('shows the References tab in %s', async (lang, title, find) => {
    const { client, open } = fakeClient('collectionTab')
    mount(document.getElementById('app')!, client)
    await open(lang)
    expect(document.querySelector('h1')!.textContent).toBe(title)
    expect(document.getElementById('find')!.textContent).toBe(find)
    expect(document.documentElement.lang).toBe(langTag(lang))
  })

  it.each([
    ['zh', '引用方'],
    ['ja', '参照元'],
    ['es', 'Referenciado por'],
    ['pt', 'Referenciado por'],
    ['ko', '참조하는 도큐먼트'],
    ['de', 'Referenziert von'],
    ['fr', 'Référencé par'],
    ['ru', 'Кто ссылается'],
  ])('shows Referenced by in %s', async (lang, title) => {
    const { client, open } = fakeClient('documentAction')
    mountReferenced(document.getElementById('app')!, client)
    await open(lang)
    expect(document.querySelector('h1')!.textContent).toBe(title)
    expect(document.getElementById('app')!.textContent).toContain(REFERENCED_TEXT[lang as 'zh'].noDocument)
  })

  const count = (n: number) => ({ n, s: new Intl.NumberFormat('en-US').format(n) })
  const NEEDS_CATEGORIES = ['en', 'es', 'pt', 'de', 'fr', 'ru'] as const

  it('writes plurals the way each language does', () => {
    expect(REFERENCED_TEXT.es.found(1)).toBe('1 campo hace referencia a él')
    expect(REFERENCED_TEXT.es.found(3)).toBe('3 campos hacen referencia a él')
    expect(REFERENCED_TEXT.pt.documents(20, true)).toBe('20+ documentos')
    expect(REFERENCED_TEXT.pt.documents(1, false)).toBe('1 documento')
    expect(VIEW_TEXT.pt.relations(count(1))).toBe('1 relação')
    expect(VIEW_TEXT.zh.relations(count(3))).toBe('3 个关系')
    expect(VIEW_TEXT.ko.relations(count(3))).toBe('관계 3개')
  })

  it('writes the plurals of German, French and Russian', () => {
    expect(REFERENCED_TEXT.de.found(1)).toBe('1 Feld verweist darauf')
    expect(REFERENCED_TEXT.de.found(3)).toBe('3 Felder verweisen darauf')
    expect(REFERENCED_TEXT.fr.found(0)).toBe('0 champ y fait référence')
    expect(REFERENCED_TEXT.fr.found(2)).toBe('2 champs y font référence')
    expect(VIEW_TEXT.fr.relations(count(0))).toBe('0 relation')
    expect(VIEW_TEXT.fr.relations(count(1))).toBe('1 relation')
    expect(VIEW_TEXT.fr.relations(count(3))).toBe('3 relations')
    expect(VIEW_TEXT.de.relations(count(1))).toBe('1 Beziehung')
    expect(VIEW_TEXT.de.relations(count(2))).toBe('2 Beziehungen')
    const forms: Array<[number, string]> = [
      [1, '1 документ'],
      [21, '21 документ'],
      [2, '2 документа'],
      [22, '22 документа'],
      [24, '24 документа'],
      [5, '5 документов'],
      [11, '11 документов'],
      [12, '12 документов'],
      [0, '0 документов'],
    ]
    for (const [n, out] of forms) expect(REFERENCED_TEXT.ru.documents(n, false), String(n)).toBe(out)
    expect(REFERENCED_TEXT.ru.documents(20, true)).toBe('20+ документов')
    expect(VIEW_TEXT.ru.relations(count(1234))).toBe('1,234 связи')
    expect(VIEW_TEXT.ru.relations(count(1))).toBe('1 связь')
    expect(VIEW_TEXT.ru.relations(count(2))).toBe('2 связи')
    expect(VIEW_TEXT.ru.relations(count(11))).toBe('11 связей')
    expect(VIEW_TEXT.ru.relations(count(21))).toBe('21 связь')
    expect(VIEW_TEXT.ru.relations(count(22))).toBe('22 связи')
    expect(VIEW_TEXT.ru.relations(count(5))).toBe('5 связей')
  })

  it('reads right when exactly one id, collection or field is meant, in every language', () => {
    for (const lang of NEEDS_CATEGORIES) {
      const one = VIEW_TEXT[lang].orphansHint(count(1), 'customers')
      const two = VIEW_TEXT[lang].orphansHint(count(2), 'customers')
      // The singular names the id without a number ("one of the 1 ids" read wrong), the plural names the count.
      expect(one, lang).not.toMatch(/\b1\b/)
      expect(two, lang).toContain('2')
      expect(one, lang).not.toBe(two)
      expect(VIEW_TEXT[lang].unmatchedHint('a', count(1)), lang).not.toMatch(/\b1\b/)
      expect(VIEW_TEXT[lang].unmatchedHint('a', count(2)), lang).toContain('2')
      expect(VIEW_TEXT[lang].found('1', count(1)), lang).not.toBe(VIEW_TEXT[lang].found('1', count(2)))
    }
    for (const lang of ['tr', 'zh', 'ja', 'ko'] as const) {
      expect(VIEW_TEXT[lang].orphansHint(count(1), 'customers'), lang).toContain('1')
    }
    expect(VIEW_TEXT.fr.orphansHint(count(1), 'clients')).toBe(
      'Affiche dans Documents les documents qui contiennent l’identifiant de l’échantillon que clients ne contient pas.',
    )
    expect(VIEW_TEXT.fr.orphansHint(count(2), 'clients')).toContain('l’un des 2 identifiants')
    expect(VIEW_TEXT.fr.found('1', count(1))).toBe('1 sur 1 identifiant de l’échantillon trouvé')
    expect(VIEW_TEXT.fr.found('1', count(3))).toBe('1 sur 3 identifiants de l’échantillon trouvés')
    expect(VIEW_TEXT.de.orphansHint(count(1), 'kunden')).toContain('die ID aus der Stichprobe')
    expect(VIEW_TEXT.ru.orphansHint(count(1), 'клиенты')).toContain('идентификатор из выборки, которого')
    expect(VIEW_TEXT.ru.noFieldsHint(count(1))).toContain('из 1 документа')
    expect(VIEW_TEXT.ru.noFieldsHint(count(2))).toContain('из 2 документов')
    expect(VIEW_TEXT.fr.missing(count(0))).toBe('0 introuvable')
    expect(VIEW_TEXT.fr.missing(count(2))).toBe('2 introuvables')
    expect(REFERENCED_TEXT.es.noneHint(1)).not.toContain('1')
    expect(REFERENCED_TEXT.fr.noneHint(1)).not.toContain('1')
    expect(REFERENCED_TEXT.fr.noneHint(0)).toContain('aucun champ')
    expect(REFERENCED_TEXT.fr.noneHint(2)).toContain('Aucun des 2 champs')
  })

  it('names the plural category of a count the way Intl does, for every language', () => {
    for (const lang of LANGUAGES) {
      for (const n of [0, 1, 2, 5, 11, 21, 22]) {
        const category = new Intl.PluralRules(langTag(lang)).select(n)
        expect(isOne(n, lang), `${lang} ${n}`).toBe(category === 'one')
      }
    }
    expect([0, 1, 2, 5, 11, 21, 22].map((n) => ru(n, 'a', 'b', 'c'))).toEqual([
      'c',
      'a',
      'b',
      'c',
      'c',
      'a',
      'b',
    ])
  })

  it('marks a page in a language the plugin lacks as English, with English numbers', () => {
    // Every table has all ten languages now, so the fallback is tried on a table that really lacks some.
    const partial = { en: VIEW_TEXT.en, tr: VIEW_TEXT.tr }
    expect(shown(partial, 'de')).toBe('en')
    expect(langTag(shown(partial, 'de'))).toBe('en')
    expect(pick(partial, 'de')).toBe(VIEW_TEXT.en)
    expect(shown(partial, 'tr')).toBe('tr')
    expect(formatNumber(12345, shown(partial, 'de'), 0)).toBe('12,345')
    expect(formatNumber(12345, shown(partial, 'tr'), 0)).toBe(new Intl.NumberFormat('tr-TR').format(12345))
    expect(shown(VIEW_TEXT, 'xx')).toBe('en')
    for (const lang of NEW) expect(shown(VIEW_TEXT, lang)).toBe(lang)
  })

  it('falls back to English for a language it does not know', async () => {
    const { client, open } = fakeClient('collectionTab')
    mount(document.getElementById('app')!, client)
    await open('xx-YY')
    expect(document.querySelector('h1')!.textContent).toBe('References')
    expect(document.documentElement.lang).toBe('en')
  })

  it('names a missing reference in the reader’s language, English for an unknown one', async () => {
    const ask = async (method: string) => {
      if (method === 'collections.list') return [{ name: 'customers', type: 'collection' }]
      if (method === 'documents.findIn')
        return { documents: [{ _id: { $oid: '2'.repeat(24) }, name: 'Ada' }] }
      throw new Error(`unexpected ${method}`)
    }
    const place = { connectionId: 'c1', db: 'shop', coll: 'orders' }
    const id = { $oid: '1'.repeat(24) }
    const say = async (locale: string) => {
      const render = createRenderer(ask as never)
      const out = await render([id, { $oid: '2'.repeat(24) }], ['customerId', 'customerId'], place, locale)
      return (out[0] as { text: string } | null)?.text
    }
    expect(await say('zh')).toBe('→ 未找到')
    expect(await say('ja')).toBe('→ 見つかりません')
    expect(await say('es')).toBe('→ no encontrado')
    expect(await say('pt')).toBe('→ não encontrado')
    expect(await say('ko')).toBe('→ 찾을 수 없음')
    expect(await say('de')).toBe('→ nicht gefunden')
    expect(await say('fr')).toBe('→ introuvable')
    expect(await say('ru')).toBe('→ не найдено')
    expect(await say('xx')).toBe('→ not found')
  })
})
