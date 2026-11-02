// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { fakeClient, flush } from '../../kit/test/fakeClient'
import { LANGUAGES } from '../../kit/src/ui'
import {
  WORDS,
  dictionaryHtml,
  dictionaryMarkdown,
  savable,
  tagOf,
  when,
  type Dictionary,
  type Model,
} from '../src/dictionary'
import { PAGE_TEXT, mount } from '../src/view'
import manifest from '../public/mongo-manager-plugin.json'

/** Every language the plugin speaks: the same words everywhere, English for any other. */
const PLACE = { connectionId: 'c', connectionName: 'Shop', db: 'shop', coll: 'orders', documentId: null }
const MODEL: Model = {
  db: 'shop',
  sampleSize: 200,
  collections: [
    {
      name: 'orders',
      type: 'collection',
      sampled: 3,
      fields: [{ path: '_id', types: ['objectId'], share: 1 }],
      moreFields: 0,
    },
  ],
  references: [],
  skipped: 0,
  at: '2026-10-26T00:00:00.000Z',
}
const DICT: Dictionary = {
  db: 'shop',
  sampleSize: 200,
  at: '2026-10-26T00:00:00.000Z',
  skipped: 0,
  collections: [
    {
      name: 'orders',
      anchor: 'coll-orders',
      type: 'collection',
      sampled: 3,
      fields: [{ path: '_id', types: ['objectId'], share: 1, hidden: false, required: true }],
      moreFields: 0,
      indexes: [{ name: '_id_', keys: '_id', unique: true, partial: false }],
      validation: null,
      refsOut: [],
      refsIn: [],
    },
  ],
}

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>'
})

async function open(locale: string) {
  const fake = fakeClient(
    { place: PLACE, locale },
    {
      'database.model': () => MODEL,
      'indexes.list': () => [{ name: '_id_', key: { _id: 1 }, options: {} }],
      'validation.get': () => ({ validator: null, validationLevel: 'strict', validationAction: 'error' }),
    },
  )
  mount(document.getElementById('app')!, fake.client)
  fake.greet()
  await flush(12)
}

/** Every key of a text table, deeply; a function counts as a leaf. */
const shape = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.length
    : v && typeof v === 'object'
      ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x)]))
      : typeof v

const OTHERS = LANGUAGES.filter((l) => l !== 'en')

describe('the plugin in every language', () => {
  const sets = { WORDS, PAGE_TEXT } as unknown as Record<string, Record<string, Record<string, unknown>>>

  it('has a block for each of the ten languages of the app', () => {
    expect([...LANGUAGES]).toHaveLength(10)
    for (const lang of LANGUAGES)
      for (const table of Object.values(sets)) expect(table[lang], lang).toBeTruthy()
  })

  for (const [name, table] of Object.entries(sets))
    for (const lang of OTHERS)
      it(`${name}.${lang} has exactly the keys of English, and its functions answer in text`, () => {
        expect(shape(table[lang])).toEqual(shape(table.en))
        for (const [key, value] of Object.entries(table[lang]!)) {
          if (typeof value !== 'function') continue
          const args =
            key === 'refTo' ? ['f', 't', true] : key === 'validation' ? ['strict', 'error'] : ['x', 'y']
          const numeric = ['more', 'skipped', 'percent', 'readingDefs']
          const out = (value as (...a: unknown[]) => unknown)(...(numeric.includes(key) ? [2, 5] : args))
          expect(typeof out).toBe('string')
          expect(out as string).not.toBe('')
        }
      })

  it('does not leave English behind in a language other than English', () => {
    for (const lang of OTHERS) {
      expect(PAGE_TEXT[lang].title, lang).not.toBe(PAGE_TEXT.en.title)
      expect(WORDS[lang].columns[0], lang).not.toBe(WORDS.en.columns[0])
      expect(WORDS[lang].noValidation, lang).not.toBe(WORDS.en.noValidation)
    }
  })

  it('writes the Markdown in each language', () => {
    const titles = {
      zh: ['# shop — 数据字典', '## 集合', '| 字段 | 类型 | 出现率 | 必填 | 备注 |', '100%'],
      ja: ['# shop — データ辞書', '## コレクション', '| フィールド | 型 | 出現率 | 必須 | メモ |', '100%'],
      es: [
        '# shop — diccionario de datos',
        '## Colecciones',
        '| Campo | Tipo | Presencia | Obligatorio | Notas |',
        '100 %',
      ],
      pt: [
        '# shop — dicionário de dados',
        '## Coleções',
        '| Campo | Tipo | Presença | Obrigatório | Observações |',
        '100%',
      ],
      ko: [
        '# shop — 데이터 사전',
        '## 컬렉션',
        '| 필드 | 유형 | 존재율 | 필수 | 비고 |',
        '100%',
        '유효성 검사 규칙이 없습니다',
      ],
      de: [
        '# shop — Datenwörterbuch',
        '## Collections',
        '| Feld | Typ | Vorkommen | Pflicht | Hinweise |',
        '100 %',
        'Keine Validierungsregeln',
      ],
      fr: [
        '# shop — dictionnaire de données',
        '## Collections',
        '| Champ | Type | Présence | Obligatoire | Remarques |',
        '100 %',
        'Aucune règle de validation',
      ],
      ru: [
        '# shop — словарь данных',
        '## Коллекции',
        '| Поле | Тип | Наличие | Обязательное | Примечания |',
        '100 %',
        'Правил валидации нет',
      ],
    } as const
    for (const [lang, parts] of Object.entries(titles)) {
      const md = dictionaryMarkdown(DICT, lang)
      for (const part of parts) expect(md, `${lang}: ${part}`).toContain(part)
    }
  })

  it('writes the HTML in each new language, and marks it with the language it is in', () => {
    const marks = {
      ko: ['<h2>컬렉션</h2>', 'ko'],
      de: ['<h2>Collections</h2>', 'de'],
      fr: ['<h2>Collections</h2>', 'fr'],
      ru: ['<h2>Коллекции</h2>', 'ru'],
      zh: ['<h2>集合</h2>', 'zh-CN'],
      pt: ['<h2>Coleções</h2>', 'pt-BR'],
    } as const
    for (const [lang, [heading, tag]] of Object.entries(marks)) {
      const page = dictionaryHtml(DICT, lang)
      expect(page.body, lang).toContain(heading)
      expect(page.lang, lang).toBe(tag)
      expect(page.title, lang).toBe(WORDS[lang as 'ko'].title('shop'))
      const saved = savable(DICT, lang, 'html').params as { html: { lang: string } }
      expect(saved.html.lang, lang).toBe(tag)
    }
    // A language the plugin has no words in is written, and marked, as English.
    const xx = dictionaryHtml(DICT, 'xx')
    expect(xx.lang).toBe('en')
    expect(xx.body).toBe(dictionaryHtml(DICT, 'en').body)
  })

  it('shows the page in each language', async () => {
    const expected = {
      zh: '数据字典',
      ja: 'データ辞書',
      es: 'Diccionario de datos',
      pt: 'Dicionário de dados',
      ko: '데이터 사전',
      de: 'Datenwörterbuch',
      fr: 'Dictionnaire de données',
      ru: 'Словарь данных',
    }
    const tags = { zh: 'zh-CN', ja: 'ja', es: 'es', pt: 'pt-BR', ko: 'ko', de: 'de', fr: 'fr', ru: 'ru' }
    for (const [lang, title] of Object.entries(expected)) {
      document.body.innerHTML = '<div id="app"></div>'
      await open(lang)
      expect(document.querySelector('h1')!.textContent, lang).toBe(title)
      expect(document.getElementById('save-markdown')!.textContent, lang).toBe('Markdown')
      expect(document.getElementById('copy-markdown')!.textContent, lang).toBe(PAGE_TEXT[lang as 'ko'].copy)
      expect(document.documentElement.lang, lang).toBe(tags[lang as 'zh'])
    }
    // Words only that language produces.
    document.body.innerHTML = '<div id="app"></div>'
    await open('ko')
    expect(document.body.textContent).toContain('유효성 검사 규칙이 없습니다')
    document.body.innerHTML = '<div id="app"></div>'
    await open('ru')
    expect(document.body.textContent).toContain('Правил валидации нет')
  })

  it('falls back to English for a language it does not know', async () => {
    expect(dictionaryMarkdown(DICT, 'xx')).toBe(dictionaryMarkdown(DICT, 'en'))
    await open('xx')
    expect(document.querySelector('h1')!.textContent).toBe('Data dictionary')
    expect(document.documentElement.lang).toBe('en')
  })

  it('marks the page and formats numbers in English where the words are English', async () => {
    const big: Model = { ...MODEL, sampleSize: 12345 }
    const bigDict: Dictionary = { ...DICT, sampleSize: 12345 }
    const saved = { words: WORDS.de, page: PAGE_TEXT.de }
    const tables = { WORDS, PAGE_TEXT } as unknown as Record<string, Record<string, unknown>>
    delete tables.WORDS!.de
    delete tables.PAGE_TEXT!.de
    try {
      expect(dictionaryMarkdown(bigDict, 'de')).toBe(dictionaryMarkdown(bigDict, 'en'))
      expect(dictionaryMarkdown(bigDict, 'de')).toContain('12,345')
      expect(dictionaryHtml(bigDict, 'de').lang).toBe('en')
      const fake = fakeClient(
        { place: PLACE, locale: 'de' },
        {
          'database.model': () => big,
          'indexes.list': () => [],
          'validation.get': () => ({ validator: null, validationLevel: 'strict', validationAction: 'error' }),
        },
      )
      mount(document.getElementById('app')!, fake.client)
      fake.greet()
      await flush(12)
      expect(document.documentElement.lang).toBe('en')
      expect(document.querySelector('h1')!.textContent).toBe('Data dictionary')
      expect(document.body.textContent).toContain('12,345')
    } finally {
      tables.WORDS!.de = saved.words
      tables.PAGE_TEXT!.de = saved.page
    }
  })

  it('uses the singular for one, in every language that has one', () => {
    const words = (text: string) => text.replace(/\d+/, '')
    for (const lang of ['en', 'es', 'pt', 'de', 'fr'] as const) {
      expect(words(WORDS[lang].more(1)), lang).not.toBe(words(WORDS[lang].more(2)))
      expect(words(WORDS[lang].skipped(1)), lang).not.toBe(words(WORDS[lang].skipped(2)))
    }
    // German: "weiteres Feld" / "weitere Felder"; French counts 0 as a singular too.
    expect(WORDS.de.more(1)).toContain('weiteres Feld wurde')
    expect(WORDS.de.skipped(2)).toContain('weitere Collections wurden')
    expect(WORDS.fr.more(0)).toBe('0 autre champ n’a pas été listé.')
    expect(WORDS.fr.more(1)).toBe('1 autre champ n’a pas été listé.')
    expect(WORDS.fr.skipped(2)).toBe('2 autres collections n’ont pas été lues.')
    // Korean, Chinese, Japanese and Turkish have one form.
    for (const lang of ['ko', 'zh', 'ja', 'tr'] as const)
      expect(WORDS[lang].more(1).replace('1', '2'), lang).toBe(WORDS[lang].more(2))
  })

  it('gives Russian its three forms', () => {
    const fields: Array<[number, string]> = [
      [0, '0 полей не показано.'],
      [1, '1 поле не показано.'],
      [2, '2 поля не показаны.'],
      [5, '5 полей не показано.'],
      [11, '11 полей не показано.'],
      [21, '21 поле не показано.'],
      [22, '22 поля не показаны.'],
    ]
    for (const [n, text] of fields) expect(WORDS.ru.more(n), String(n)).toBe(text)
    expect(WORDS.ru.skipped(0)).toBe('0 коллекций не прочитано.')
    expect(WORDS.ru.skipped(21)).toBe('21 коллекция не прочитана.')
    expect(WORDS.ru.skipped(22)).toBe('22 коллекции не прочитаны.')
    expect(WORDS.ru.skipped(11)).toBe('11 коллекций не прочитано.')
  })

  it('sets French labels with a narrow no-break space before the colon, and sizes in MB', () => {
    expect(WORDS.fr.colon).toBe(' :')
    expect(WORDS.fr.partialFile('1', '2')).toMatch(/1\s+MB/)
    expect(WORDS.ru.partialFile('1', '2')).toMatch(/1\s+MB/)
  })

  it('writes dates in the language of the words, through Intl', () => {
    const iso = '2026-10-26T14:05:00.000Z'
    for (const lang of ['de', 'fr', 'ko', 'ru'] as const) {
      const expected =
        new Intl.DateTimeFormat(tagOf(lang), {
          dateStyle: 'medium',
          timeStyle: 'short',
          timeZone: 'UTC',
        }).format(Date.parse(iso)) + ' UTC'
      expect(when(iso, lang), lang).toBe(expected)
    }
    expect(when(iso, 'xx')).toBe(when(iso, 'en'))
  })

  it('names itself in every language of the manifest', () => {
    const m = manifest as unknown as {
      name: Record<string, string>
      description: Record<string, string>
      contributes: { collectionTabs: Array<{ title: Record<string, string> }> }
      changelog: Array<{ version: string; notes: Record<string, string> }>
    }
    for (const lang of LANGUAGES) {
      expect(m.name[lang], lang).toBeTruthy()
      expect(m.name[lang]!.length, lang).toBeLessThanOrEqual(40)
      expect(m.description[lang]!.length, lang).toBeLessThanOrEqual(300)
      expect(m.contributes.collectionTabs[0]!.title[lang], lang).toBeTruthy()
      for (const entry of m.changelog) {
        expect(entry.notes[lang], `${entry.version} ${lang}`).toBeTruthy()
        expect(entry.notes[lang]!.length, `${entry.version} ${lang}`).toBeLessThanOrEqual(1000)
      }
    }
    expect(manifest.version).toBe('1.2.0')
    expect(m.changelog[0]!.version).toBe('1.2.0')
    expect(m.changelog[0]!.notes.en).toBe(
      'Now in Korean, German, French and Russian too, as the app is. Some wording and counts also read better in several languages.',
    )
  })
})
