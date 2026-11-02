// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { fakeClient, flush } from '../../kit/test/fakeClient'
import { LANGUAGES, langTag, shown as shownLanguage } from '../../kit/src/ui'
import { mount, TEXT } from '../src/view'

const NEW = ['zh', 'ja', 'es', 'pt', 'ko', 'de', 'fr', 'ru'] as const
const FRESH = ['ko', 'de', 'fr', 'ru'] as const

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>'
})

async function shown(locale: string) {
  const fake = fakeClient({ place: null, kind: 'sidebarPanel', id: 'logs', locale }, {})
  const root = document.getElementById('app')!
  mount(root, fake.client)
  fake.greet()
  await flush()
  return root
}

const at = (min: number) => new Date(Date.UTC(2026, 9, 26, 10, min)).toISOString()
const LOG = [
  {
    t: { $date: at(0) },
    s: 'I',
    c: 'CONTROL',
    id: 23403,
    msg: 'Build Info',
    attr: { buildInfo: { version: '8.0.4' } },
  },
  {
    t: { $date: at(1) },
    s: 'I',
    c: 'COMMAND',
    id: 51803,
    msg: 'Slow query',
    attr: {
      type: 'command',
      ns: 'shop.orders',
      command: { find: 'orders', filter: { sku: 'a' } },
      planSummary: 'COLLSCAN',
      docsExamined: 1200,
      nreturned: 1,
      durationMillis: 700,
    },
  },
  { t: { $date: at(2) }, s: 'W', c: 'STORAGE', id: 20001, msg: 'Low disk' },
]
  .map((o) => JSON.stringify(o))
  .join('\n')

/** The page with a log read, in the given language. */
async function analysed(locale: string) {
  const fake = fakeClient({ place: null, kind: 'sidebarPanel', id: 'logs', locale }, {})
  const root = document.getElementById('app')!
  mount(root, fake.client)
  fake.greet()
  await flush()
  const input = root.querySelector<HTMLInputElement>('#file')!
  Object.defineProperty(input, 'files', { value: [new File([LOG], 'mongod.log')], configurable: true })
  input.dispatchEvent(new Event('change'))
  await flush(12)
  return root
}

/** The shape of a text block: its keys, deep, with a function told by its name only. */
function keysOf(value: unknown, path = ''): string[] {
  if (value && typeof value === 'object' && !Array.isArray(value))
    return Object.entries(value).flatMap(([k, v]) => keysOf(v, `${path}.${k}`))
  if (Array.isArray(value)) return [`${path}[${value.length}]`]
  return [path + (typeof value === 'function' ? '()' : '')]
}

describe('the languages', () => {
  for (const lang of NEW) {
    it(`shows the page in ${lang}`, async () => {
      const root = await shown(lang)
      const t = TEXT[lang]
      expect(root.textContent).toContain(t.drop)
      expect(root.textContent).toContain(t.choose)
      expect(root.textContent).toContain(t.title)
      expect(t.title).not.toBe(TEXT.en.title)
      expect(t.drop).not.toBe(TEXT.en.drop)
      expect(document.documentElement.lang).toBe(langTag(lang))
    })
  }

  it('says its words in the language each new one is written in', () => {
    expect(TEXT.ko.title).toBe('로그 분석기')
    expect(TEXT.de.drop).toBe('Logdatei hier ablegen')
    expect(TEXT.fr.title).toBe('Analyseur de journaux')
    expect(TEXT.ru.choose).toBe('Выбрать файл')
  })

  it('has every language with the same keys as English', () => {
    const en = keysOf(TEXT.en).sort()
    for (const lang of LANGUAGES) {
      const block = (TEXT as Record<string, unknown>)[lang]
      expect(block, lang).toBeTruthy()
      expect(keysOf(block).sort(), lang).toEqual(en)
    }
  })

  it('has every time unit in every language', () => {
    for (const lang of NEW)
      expect(Object.keys(TEXT[lang].units).sort()).toEqual(Object.keys(TEXT.en.units).sort())
  })

  it('shows the analysis in a new language, with that language’s words and numbers', async () => {
    for (const lang of FRESH) {
      document.body.innerHTML = '<div id="app"></div>'
      const root = await analysed(lang)
      const t = TEXT[lang]
      expect(document.documentElement.lang, lang).toBe(langTag(lang))
      const text = root.textContent!
      expect(text, lang).toContain(t.summary)
      expect(text, lang).toContain(t.slowOps)
      expect(text, lang).toContain(t.timeline)
      expect(text, lang).toContain(t.csv)
      for (const column of t.columns.slice(0, 4)) expect(text, lang).toContain(column)
      // The number and the time follow the language, formatted by Intl with the same options.
      const number = new Intl.NumberFormat(lang).format(3)
      expect(text, lang).toContain(`${t.lines}${number}`)
      const time = new Intl.DateTimeFormat(lang, {
        dateStyle: 'medium',
        timeStyle: 'medium',
        timeZone: 'UTC',
      }).format(Date.UTC(2026, 9, 26, 10, 0))
      expect(text, lang).toContain(`${time} UTC`)
      // Nothing of the English page is left.
      expect(text, lang).not.toContain(TEXT.en.slowOps)
      expect(text, lang).not.toContain(TEXT.en.csv)
    }
  })

  it('falls back to English for a language it does not know', async () => {
    const root = await shown('xx')
    expect(root.textContent).toContain(TEXT.en.drop)
    expect(document.documentElement.lang).toBe('en')
  })

  it('formats numbers and times as English for a language it does not know', async () => {
    const root = await analysed('xx')
    expect(document.documentElement.lang).toBe('en')
    const text = root.textContent!
    expect(text).toContain(`${TEXT.en.lines}${new Intl.NumberFormat('en').format(3)}`)
    const time = new Intl.DateTimeFormat('en', {
      dateStyle: 'medium',
      timeStyle: 'medium',
      timeZone: 'UTC',
    }).format(Date.UTC(2026, 9, 26, 10, 0))
    expect(text).toContain(`${time} UTC`)
  })

  it('keeps the plural forms of the languages that have them', () => {
    expect(TEXT.es.done('a.log', 1, '1')).toBe('Leído a.log: 1 línea.')
    expect(TEXT.es.done('a.log', 2, '2')).toBe('Leído a.log: 2 líneas.')
    expect(TEXT.pt.done('a.log', 1, '1')).toBe('Lido a.log: 1 linha.')
    expect(TEXT.pt.done('a.log', 2, '2')).toBe('Lido a.log: 2 linhas.')
    expect(TEXT.de.done('a.log', 1, '1')).toContain('1 Zeile.')
    expect(TEXT.de.done('a.log', 2, '2')).toContain('2 Zeilen.')
    // French counts 0 and 1 as singular.
    expect(TEXT.fr.done('a.log', 0, '0')).toContain('0 ligne.')
    expect(TEXT.fr.done('a.log', 1, '1')).toContain('1 ligne.')
    expect(TEXT.fr.done('a.log', 2, '2')).toContain('2 lignes.')
  })

  it('gives Russian its three forms', () => {
    const done = (n: number) => TEXT.ru.done('a.log', n, String(n))
    for (const n of [1, 21, 101]) expect(done(n), String(n)).toContain(`${n} строка.`)
    for (const n of [2, 3, 4, 22, 24]) expect(done(n), String(n)).toContain(`${n} строки.`)
    for (const n of [0, 5, 11, 12, 14, 20, 25, 111]) expect(done(n), String(n)).toContain(`${n} строк.`)
    expect(TEXT.ru.otherMessages(1, '1')).toContain('учтено 1 сообщение')
    expect(TEXT.ru.otherMessages(3, '3')).toContain('учтены 3 сообщения')
    expect(TEXT.ru.otherMessages(5, '5')).toContain('учтено 5 сообщений')
  })

  it('falls back to English for a table that lacks the language, numbers included', () => {
    const partial = { en: TEXT.en, tr: TEXT.tr }
    const language = shownLanguage(partial, 'fr')
    expect(language).toBe('en')
    expect(new Intl.NumberFormat(langTag(language)).format(12345)).toBe('12,345')
  })

  it('agrees the connection line with its counts, for 0, 1 and 2', () => {
    const line = (lang: 'es' | 'pt' | 'fr', o: number, e: number) =>
      TEXT[lang].connectionsLine(o, String(o), e, String(e), 0, '')
    const words = {
      es: ['abierta', 'cerrada'],
      pt: ['aberta', 'encerrada'],
      fr: ['ouverte', 'terminée'],
    } as const
    for (const lang of ['es', 'pt', 'fr'] as const) {
      const [open, end] = words[lang]
      expect(line(lang, 1, 1), lang).toBe(`1 ${open}, 1 ${end}.`)
      expect(line(lang, 2, 2), lang).toBe(`2 ${open}s, 2 ${end}s.`)
      // Intl decides 0: French and Brazilian Portuguese count it as singular, Spanish as plural.
      const zero = new Intl.PluralRules(langTag(lang)).select(0) === 'one' ? '' : 's'
      expect(line(lang, 0, 0), lang).toBe(`0 ${open}${zero}, 0 ${end}${zero}.`)
    }
    expect(TEXT.ru.connectionsLine(1, '1', 0, '0', 5, '5')).toBe(
      'Открыто: 1, закрыто: 0, одновременно не более 5.',
    )
  })

  it('has a singular for one in every language that has one', () => {
    for (const lang of ['en', 'es', 'pt', 'de', 'fr'] as const) {
      expect(TEXT[lang].otherSlow(1, '1'), lang).not.toBe(TEXT[lang].otherSlow(2, '2').replace('2', '1'))
      expect(TEXT[lang].csvLeft(1, '1'), lang).not.toBe(TEXT[lang].csvLeft(2, '2').replace('2', '1'))
    }
  })
})
