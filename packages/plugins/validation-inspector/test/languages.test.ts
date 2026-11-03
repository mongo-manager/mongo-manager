// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import type { Accent, PluginClient } from '../../kit/src/client'
import { pick, shown as shownLanguage } from '../../kit/src/ui'
import { TEXT, mount } from '../src/view'

const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0))
}
const int = (n: number) => ({ $numberInt: String(n) })
const PLACE = { connectionId: 'c', connectionName: 'Shop', db: 'shop', coll: 'customers', documentId: null }
const ANSWER = {
  documents: [{ read: [{ n: int(1000) }], broken: [{ n: int(15) }], r0: [{ n: int(1) }] }],
}

function open(locale: string) {
  let ready: (() => void) | null = null
  const contexts: Array<(l: string, t: 'light' | 'dark', a: Accent) => void> = []
  const client: PluginClient = {
    contribution: { kind: 'collectionTab', id: 'check' },
    ask: async <T>(method: string) => {
      if (method === 'context.get')
        return {
          plugin: { id: 'validation-inspector', version: '1' },
          contribution: { kind: 'collectionTab', id: 'check' },
          locale,
          theme: 'light',
          accent: 'violet',
          place: PLACE,
          settings: {},
        } as T
      if (method === 'validation.get')
        return {
          validator: { $jsonSchema: { required: ['email'] } },
          validationLevel: 'strict',
          validationAction: 'error',
        } as T
      return ANSWER as T
    },
    onReady: (fn) => (ready = fn),
    onContext: (fn) => contexts.push(fn),
    onCells: () => {},
  }
  const root = document.getElementById('app')!
  mount(root, client)
  ready!()
  return { root, contexts }
}

beforeEach(() => {
  document.body.replaceChildren(Object.assign(document.createElement('div'), { id: 'app' }))
})

const percent = (tag: string, fraction: number) =>
  new Intl.NumberFormat(tag, { style: 'percent', maximumFractionDigits: 1 }).format(fraction)
const number = (tag: string, n: number) => new Intl.NumberFormat(tag, { maximumFractionDigits: 2 }).format(n)

describe('languages', () => {
  // [locale, html lang, title, check button, tab-only word of that language]
  const shown: Array<[string, string, string, string]> = [
    ['zh', 'zh-CN', '验证检查', '检查'],
    ['ja', 'ja', '検証チェック', 'チェック'],
    ['es', 'es', 'Comprobación de validación', 'Comprobar'],
    ['pt', 'pt-BR', 'Verificação de validação', 'Verificar'],
    ['ko', 'ko', '유효성 검사 점검', '점검'],
    ['de', 'de', 'Validierungsprüfung', 'Prüfen'],
    ['fr', 'fr', 'Contrôle de validation', 'Vérifier'],
    ['ru', 'ru', 'Проверка валидации', 'Проверить'],
  ]
  for (const [locale, tag, title, check] of shown)
    it(`shows its title and main labels in ${locale}`, async () => {
      const { root } = open(locale)
      await flush()
      expect(document.documentElement.lang).toBe(tag)
      expect(root.textContent).toContain(title)
      expect(document.getElementById('check')!.textContent).toContain(check)
      expect(document.getElementById('status')!.textContent).not.toMatch(/documents? checked/)
      // The sample sizes are written in the shown language, numbers included.
      const sizes = document.getElementById('size')!.textContent!
      expect(sizes).toContain(number(tag, 10000))
      expect(sizes).not.toMatch(/at random/)
    })

  it('writes the counts and shares in the reader’s language', async () => {
    const { root } = open('es')
    await flush()
    expect(document.getElementById('status')!.textContent).toBe(
      `${number('es', 1000)} documentos comprobados · 15 incumplen las reglas (${percent('es', 0.015)})`,
    )
    expect(root.querySelector('h3')!.textContent).toBe('email es obligatorio')
  })

  it('writes the new languages’ counts with their own plural and percent style', async () => {
    for (const [locale, read, broken] of [
      ['ru', 'Проверено', 'нарушают правила'],
      ['de', 'Dokumente geprüft', 'verstoßen gegen die Regeln'],
      ['fr', 'documents vérifiés', 'enfreignent les règles'],
      ['ko', '도큐먼트', '위반합니다'],
    ] as const) {
      document.body.replaceChildren(Object.assign(document.createElement('div'), { id: 'app' }))
      open(locale)
      await flush()
      const status = document.getElementById('status')!.textContent!
      expect(status, locale).toContain(read)
      expect(status, locale).toContain(broken)
      expect(status, locale).toContain(`(${percent(locale, 0.015)})`)
    }
  })

  it('says one document in the singular in every language that has one', () => {
    expect(TEXT.en.read(1, '1')).toBe('1 document checked')
    expect(TEXT.es.read(1, '1')).toBe('1 documento comprobado')
    expect(TEXT.pt.read(1, '1')).toBe('1 documento verificado')
    expect(TEXT.de.read(1, '1')).toBe('1 Dokument geprüft')
    expect(TEXT.de.read(2, '2')).toBe('2 Dokumente geprüft')
    expect(TEXT.de.broken(1, '1', 'x')).toContain('Dokument verstößt')
    expect(TEXT.de.broken(2, '2', 'x')).toContain('Dokumente verstoßen')
    // French treats 0 and 1 alike.
    expect(TEXT.fr.read(0, '0')).toBe('0 document vérifié')
    expect(TEXT.fr.read(1, '1')).toBe('1 document vérifié')
    expect(TEXT.fr.read(2, '2')).toBe('2 documents vérifiés')
    expect(TEXT.fr.broken(1, '1', 'x')).toContain('document enfreint')
    expect(TEXT.fr.documents(2, '2', 'x')).toContain('documents')
    for (const lang of ['en', 'es', 'pt', 'de', 'fr', 'ru'] as const)
      expect(TEXT[lang].cleanHint(1, '1'), lang).not.toContain('1')
  })

  it('gives Russian its one, few and many forms', () => {
    const doc = (n: number) => TEXT.ru.documents(n, String(n), 'x')
    for (const n of [1, 21, 101]) expect(doc(n), String(n)).toContain('документ (')
    for (const n of [2, 3, 4, 22, 24]) expect(doc(n), String(n)).toContain('документа (')
    for (const n of [0, 5, 11, 12, 14, 20, 25, 111]) expect(doc(n), String(n)).toContain('документов (')
    expect(TEXT.ru.read(1, '1')).toBe('Проверен 1 документ')
    expect(TEXT.ru.read(3, '3')).toBe('Проверено 3 документа')
    expect(TEXT.ru.read(12, '12')).toBe('Проверено 12 документов')
    expect(TEXT.ru.broken(1, '1', 'x')).toContain('нарушает правила')
    expect(TEXT.ru.broken(2, '2', 'x')).toContain('нарушают правила')
  })

  it('gives every count the plural form of its language for 0, 1, 2, 5, 11, 21 and 22', () => {
    const counts = [0, 1, 2, 5, 11, 21, 22]
    // Same category rule the kit uses, for the one languages that split by it.
    const one = (n: number, tag: string) => new Intl.PluralRules(tag).select(n) === 'one'
    for (const [lang, tag, singular, plural] of [
      ['en', 'en', 'document', 'documents'],
      ['es', 'es', 'documento', 'documentos'],
      ['pt', 'pt-BR', 'documento', 'documentos'],
      ['de', 'de', 'Dokument', 'Dokumente'],
      ['fr', 'fr', 'document', 'documents'],
    ] as const)
      for (const n of counts) {
        const text = TEXT[lang].documents(n, String(n), 'x')
        const word = text.split(' ')[1]
        expect(word, `${lang} ${n}`).toBe(one(n, tag) ? singular : plural)
      }
    // French reads 0 and 1 alike; the other languages here do not.
    expect(TEXT.fr.documents(0, '0', 'x')).toContain(' document (')
    expect(TEXT.es.documents(0, '0', 'x')).toContain(' documentos (')
    const ru = (n: number) => TEXT.ru.documents(n, String(n), 'x')
    expect(ru(21)).toBe('21 документ (x)')
    expect(ru(22)).toBe('22 документа (x)')
    expect(ru(11)).toBe('11 документов (x)')
    expect(ru(5)).toBe('5 документов (x)')
    expect(TEXT.ru.read(21, '21')).toBe('Проверен 21 документ')
    expect(TEXT.ru.read(22, '22')).toBe('Проверено 22 документа')
    expect(TEXT.ru.broken(21, '21', 'x')).toBe('21 документ нарушает правила (x)')
    expect(TEXT.ru.broken(22, '22', 'x')).toBe('22 документа нарушают правила (x)')
    expect(TEXT.ru.broken(11, '11', 'x')).toBe('11 документов нарушают правила (x)')
    expect(TEXT.ru.broken(0, '0', 'x')).toBe('0 документов нарушают правила (x)')
  })

  it('falls back to English for a language the text table lacks', () => {
    const partial = { en: TEXT.en, tr: TEXT.tr }
    expect(shownLanguage(partial, 'ru')).toBe('en')
    expect(shownLanguage(partial, 'tr')).toBe('tr')
    expect(pick(partial, 'ru')).toBe(TEXT.en)
    expect(pick(partial, 'xx')).toBe(TEXT.en)
  })

  it('falls back to English for an unknown locale, in the page mark and the numbers', async () => {
    const { root } = open('xx')
    await flush()
    expect(document.documentElement.lang).toBe('en')
    expect(root.textContent).toContain('Validation check')
    expect(document.getElementById('status')!.textContent).toBe(
      `1,000 documents checked · 15 break the rules (${percent('en', 0.015)})`,
    )
    expect(document.getElementById('size')!.textContent).toContain('10,000 at random')
  })

  it('switches language when the app does', async () => {
    const { contexts } = open('en')
    await flush()
    for (const fn of contexts) fn('ja', 'light', 'violet')
    expect(document.getElementById('check')!.textContent).toContain('チェック')
    for (const fn of contexts) fn('ru', 'light', 'violet')
    expect(document.getElementById('check')!.textContent).toContain('Проверить')
    expect(document.documentElement.lang).toBe('ru')
  })

  it('keeps the same keys in every language as in English', () => {
    const keysOf = (o: object) => Object.keys(o).sort()
    for (const [lang, block] of Object.entries(TEXT)) {
      expect(keysOf(block), lang).toEqual(keysOf(TEXT.en))
      for (const key of keysOf(TEXT.en)) {
        const en = (TEXT.en as Record<string, unknown>)[key]
        const other = (block as Record<string, unknown>)[key]
        expect(typeof other, `${lang}.${key}`).toBe(typeof en)
        if (en !== null && typeof en === 'object')
          expect(keysOf(other as object), `${lang}.${key}`).toEqual(keysOf(en))
        if (typeof en === 'function')
          expect((other as (...a: never[]) => unknown).length, `${lang}.${key}`).toBe(
            (en as (...a: never[]) => unknown).length,
          )
      }
    }
    expect(Object.keys(TEXT).sort()).toEqual(['de', 'en', 'es', 'fr', 'ja', 'ko', 'pt', 'ru', 'tr', 'zh'])
  })
})
