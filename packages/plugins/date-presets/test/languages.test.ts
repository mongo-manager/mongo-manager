// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import type { Accent, PluginClient } from '../../kit/src/client'
import { LANGUAGES, pluralOf, shown, type Language } from '../../kit/src/i18n'
import { TEXT, mount } from '../src/view'

const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0))
}
const PLACE = { connectionId: 'c', connectionName: 'Shop', db: 'shop', coll: 'orders', documentId: null }
const NOW = new Date(Date.UTC(2026, 9, 28, 15, 30))

function fakeClient(locale: string, sampled = 0) {
  let ready: (() => void) | null = null
  const contexts: Array<(l: string, t: 'light' | 'dark', a: Accent) => void> = []
  const client: PluginClient = {
    contribution: { kind: 'collectionTab', id: 'dates' },
    ask: async <T>(method: string) => {
      if (method === 'context.get')
        return {
          plugin: { id: 'date-presets', version: '1' },
          contribution: { kind: 'collectionTab', id: 'dates' },
          locale,
          theme: 'light',
          accent: 'violet',
          place: PLACE,
          settings: {},
        } as T
      return {
        documents: Array.from({ length: sampled }, () => ({ createdAt: { $date: { $numberLong: '0' } } })),
      } as T
    },
    onReady: (fn) => (ready = fn),
    onContext: (fn) => contexts.push(fn),
    onCells: () => {},
  }
  return { client, greet: () => ready!(), contexts }
}

const app = () => document.getElementById('app')!
beforeEach(() => {
  document.body.replaceChildren(Object.assign(document.createElement('div'), { id: 'app' }))
})

/** The keys of a text block, deeply: an object's keys recursively, a function by its name only. */
function shape(v: unknown, path = ''): string[] {
  if (v !== null && typeof v === 'object')
    return Object.entries(v).flatMap(([k, x]) => shape(x, `${path}.${k}`))
  return [`${path}:${typeof v}`]
}

describe('the words of every language', () => {
  const en = shape(TEXT.en).sort()
  for (const lang of LANGUAGES) {
    it(`${lang} has exactly the keys of English`, () => {
      expect(shape(TEXT[lang]).sort()).toEqual(en)
    })
  }

  it('never leaves a string empty and fills every template', () => {
    for (const lang of LANGUAGES) {
      const t = TEXT[lang]
      expect(t.title.length).toBeGreaterThan(0)
      expect(t.description('orders')).toContain('orders')
      expect(t.found('other', '200')).toContain('200')
      expect(t.showHint('X')).toContain('X')
      for (const v of Object.values(t.names)) expect(v.length).toBeGreaterThan(0)
    }
  })

  it('keeps English words out of the other languages', () => {
    for (const lang of LANGUAGES.filter((l) => l !== 'en')) {
      expect(TEXT[lang].title).not.toBe(TEXT.en.title)
      expect(TEXT[lang].names.thisWeek).not.toBe(TEXT.en.names.thisWeek)
      expect(TEXT[lang].weekNote).not.toBe(TEXT.en.weekNote)
    }
  })
})

const found = (lang: Language, n: number) => TEXT[lang].found(pluralOf(n, lang), String(n))

describe('a count of documents', () => {
  it('has its singular form in English, Spanish, Portuguese, German and French', () => {
    expect(found('en', 1)).toBe('Date fields found in 1 sampled document')
    expect(found('en', 3)).toBe('Date fields found in 3 sampled documents')
    expect(found('es', 1)).toBe('Campos de fecha encontrados en 1 documento de la muestra')
    expect(found('es', 3)).toContain('3 documentos de la muestra')
    expect(found('pt', 1)).toBe('Campos de data encontrados em 1 documento da amostra')
    expect(found('pt', 3)).toContain('3 documentos da amostra')
    expect(found('de', 1)).toBe('In 1 Stichprobendokument gefundene Datumsfelder')
    expect(found('de', 3)).toBe('In 3 Stichprobendokumenten gefundene Datumsfelder')
    expect(found('fr', 1)).toBe('Champs de date trouvés dans 1 document de l’échantillon')
    expect(found('fr', 3)).toContain('3 documents de l’échantillon')
  })

  it('counts zero as singular in French and plural in English', () => {
    expect(found('fr', 0)).toContain('0 document de l’échantillon')
    expect(found('en', 0)).toContain('0 sampled documents')
  })

  it('reads right for 0, 1, 2, 5, 11, 21 and 22 in every language', () => {
    const ending = (lang: Language, n: number) => found(lang, n).split(String(n))[1]
    for (const n of [0, 1, 2, 5, 11, 21, 22]) {
      const one = pluralOf(n, 'ru') === 'one'
      expect(ending('ru', n), String(n)).toBe(one ? ' документе выборки' : ' документах выборки')
      expect(found('de', n).includes('Stichprobendokument gefunden'), String(n)).toBe(
        pluralOf(n, 'de') === 'one',
      )
      expect(found('fr', n).includes(' document de'), String(n)).toBe(pluralOf(n, 'fr') === 'one')
      expect(found('en', n).endsWith(' document'), String(n)).toBe(pluralOf(n, 'en') === 'one')
    }
    expect(ending('ru', 21)).toBe(' документе выборки')
    expect(ending('ru', 22)).toBe(' документах выборки')
    expect(ending('ru', 11)).toBe(' документах выборки')
  })
})

describe('the Dates tab in each language', () => {
  const cases: Array<[string, string, string, string]> = [
    ['zh', '本周', '每周从星期一开始。', 'zh-CN'],
    ['ja', '今週', '週は月曜日から始まります。', 'ja'],
    ['es', 'Esta semana', 'Las semanas empiezan el lunes.', 'es'],
    ['pt', 'Esta semana', 'As semanas começam na segunda-feira.', 'pt-BR'],
    ['ko', '이번 주', '한 주는 월요일에 시작합니다.', 'ko'],
    ['de', 'Diese Woche', 'Wochen beginnen am Montag.', 'de'],
    ['fr', 'Cette semaine', 'Les semaines commencent le lundi.', 'fr'],
    ['ru', 'Эта неделя', 'Неделя начинается в понедельник.', 'ru'],
  ]
  for (const [lang, name, note, tag] of cases) {
    it(`says it in ${lang}`, async () => {
      const { client, greet } = fakeClient(lang)
      mount(app(), client, () => NOW)
      greet()
      await flush()
      expect(document.querySelector('[data-preset="thisWeek"] .dp-preset-name')!.textContent).toBe(name)
      expect(app().textContent).toContain(note)
      expect(document.documentElement.lang).toBe(tag)
    })
  }

  it('writes the range in the language of the page', async () => {
    for (const lang of ['ko', 'de', 'fr', 'ru']) {
      document.body.replaceChildren(Object.assign(document.createElement('div'), { id: 'app' }))
      const { client, greet } = fakeClient(lang)
      mount(app(), client, () => NOW)
      greet()
      await flush()
      ;[...document.querySelectorAll<HTMLButtonElement>('#zone button')]
        .find((b) => b.textContent === 'UTC')!
        .click()
      await flush()
      const day = new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeZone: 'UTC' })
      const range = `${day.format(Date.UTC(2026, 9, 26))} – ${day.format(Date.UTC(2026, 10, 1))} UTC`
      expect(document.querySelector('[data-preset="thisWeek"] .dp-preset-range')!.textContent, lang).toBe(
        range,
      )
      const time = new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })
      expect(document.querySelector('[data-preset="last24h"] .dp-preset-range')!.textContent, lang).toBe(
        `${time.format(Date.UTC(2026, 9, 27, 15, 30))} – ${time.format(Date.UTC(2026, 9, 28, 15, 30))} UTC`,
      )
    }
  })

  it('says how many documents were sampled, in the singular for one', async () => {
    for (const [lang, one] of [
      ['de', 'In 1 Stichprobendokument gefundene Datumsfelder'],
      ['fr', 'Champs de date trouvés dans 1 document de l’échantillon'],
      ['ru', 'Поля с датами, найденные в 1 документе выборки'],
      ['es', 'Campos de fecha encontrados en 1 documento de la muestra'],
    ] as const) {
      document.body.replaceChildren(Object.assign(document.createElement('div'), { id: 'app' }))
      const { client, greet } = fakeClient(lang, 1)
      mount(app(), client, () => NOW)
      greet()
      await flush()
      expect(document.getElementById('status')!.textContent, lang).toBe(one)
    }
  })

  it('reads English, with English numbers, when the table lacks the language', async () => {
    const partial = { en: TEXT.en, tr: TEXT.tr }
    expect(shown(partial, 'de')).toBe('en')
    const { client, greet } = fakeClient('de', 12345)
    mount(app(), client, () => NOW, partial)
    greet()
    await flush()
    expect(document.querySelector('[data-preset="thisWeek"] .dp-preset-name')!.textContent).toBe('This week')
    expect(app().textContent).toContain('Weeks start on Monday.')
    expect(document.documentElement.lang).toBe('en')
    expect(document.getElementById('status')!.textContent).toBe(
      `Date fields found in ${new Intl.NumberFormat('en').format(12345)} sampled documents`,
    )
    expect(document.getElementById('status')!.textContent).toContain('12,345')
  })
})
