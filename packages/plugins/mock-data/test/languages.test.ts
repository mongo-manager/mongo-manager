// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { fakeClient, flush } from '../../kit/test/fakeClient'
import { LANGUAGES, pick, pluralOf, shown } from '../../kit/src/i18n'
import { DE, ES, FR, JA, KO, PT, RU, ZH } from '../src/data/extra'
import { EN, TR, type Lists } from '../src/data/lists'
import { DATA_LANGUAGES, dataLanguageOf, generate } from '../src/generate'
import { rand } from '../src/prng'
import { TEMPLATES, templateOf } from '../src/templates'
import { TEXT, mount, type Text } from '../src/view'

/** Languages: English, Turkish, Chinese, Japanese, Spanish, Portuguese, Korean, German, French and Russian. */
const PLACE = { connectionId: 'c', connectionName: 'Shop', db: 'shop', coll: 'people', documentId: null }
const PEOPLE = [{ _id: { $oid: '65a1b2c3d4e5f60718293a01' }, name: 'Ada', age: { $numberInt: '36' } }]
const NEW = ['zh', 'ja', 'es', 'pt', 'ko', 'de', 'fr', 'ru'] as const
const LATEST = ['ko', 'de', 'fr', 'ru'] as const
const LISTS: Record<(typeof DATA_LANGUAGES)[number], Lists> = {
  en: EN,
  tr: TR,
  zh: ZH,
  ja: JA,
  es: ES,
  pt: PT,
  ko: KO,
  de: DE,
  fr: FR,
  ru: RU,
}
/** What `<html lang>` says for each language. */
const TAG: Record<string, string> = { zh: 'zh-CN', pt: 'pt-BR' }
const tag = (lang: string) => TAG[lang] ?? lang
const grouped = (n: number, lang: string) => new Intl.NumberFormat(tag(lang)).format(n)

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>'
})
const app = () => document.getElementById('app')!

async function open(locale: string) {
  const fake = fakeClient({ place: PLACE, locale }, { 'documents.find': () => ({ documents: PEOPLE }) })
  mount(app(), fake.client)
  fake.greet()
  await flush()
}

/** The shape of a text block: its keys, deeply; a function stands for itself. */
const shape = (value: unknown): unknown =>
  typeof value === 'function'
    ? 'function'
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shape(v)]))
      : typeof value

describe('the languages of the tab', () => {
  it('shows its title and main labels in each new language', async () => {
    const expected = {
      zh: ['测试数据', '导入…', '下载 JSON', '添加'],
      ja: ['テストデータ', 'インポート…', 'JSON をダウンロード', '追加'],
      es: ['Datos de prueba', 'Importar…', 'Descargar JSON', 'Añadir'],
      pt: ['Dados de teste', 'Importar…', 'Baixar JSON', 'Adicionar'],
      ko: ['테스트 데이터', '가져오기…', 'JSON 다운로드', '추가'],
      de: ['Testdaten', 'Importieren…', 'JSON herunterladen', 'Hinzufügen'],
      fr: ['Données de test', 'Importer…', 'Télécharger le JSON', 'Ajouter'],
      ru: ['Тестовые данные', 'Импортировать…', 'Скачать JSON', 'Добавить'],
    }
    for (const lang of NEW) {
      document.body.innerHTML = '<div id="app"></div>'
      await open(lang)
      const [title, insert, download, add] = expected[lang]
      expect(app().textContent, lang).toContain(title)
      expect(app().querySelector('#insert')!.textContent, lang).toBe(insert)
      expect(app().querySelector('#download')!.textContent, lang).toBe(download)
      expect(app().querySelector('#add-field')!.textContent, lang).toBe(add)
      expect(app().querySelector<HTMLSelectElement>('#lang')!.value, lang).toBe(lang)
      expect(document.documentElement.lang, lang).toBe(tag(lang))
    }
  })

  it("names the templates in the reader's language", async () => {
    await open('ja')
    const options = [...app().querySelectorAll('select.md-template option')].map((o) => o.textContent)
    expect(options).toContain('氏名')
    expect(options).toContain('メールアドレス（例示用ドメイン）')
    document.body.innerHTML = '<div id="app"></div>'
    await open('ru')
    const russian = [...app().querySelectorAll('select.md-template option')].map((o) => o.textContent)
    expect(russian).toContain('Полное имя')
    expect(russian).toContain('Электронная почта (домены для примеров)')
    document.body.innerHTML = '<div id="app"></div>'
    await open('de')
    const german = [...app().querySelectorAll('select.md-template option')].map((o) => o.textContent)
    expect(german).toContain('Vollständiger Name')
    expect(german).toContain('E-Mail (Beispiel-Domains)')
  })

  it("counts in the reader's language", async () => {
    const said = {
      pt: (n: string) => `Os primeiros 5 de ${n}`,
      zh: (n: string) => `${n} 个文档中的前 5 个`,
      ko: (n: string) => `${n}개 중 처음 5개`,
      de: (n: string) => `Die ersten 5 von ${n}`,
      fr: (n: string) => `Les 5 premiers sur ${n}`,
      ru: (n: string) => `Первые 5 из ${n}`,
    }
    for (const [lang, say] of Object.entries(said)) {
      document.body.innerHTML = '<div id="app"></div>'
      await open(lang)
      const count = app().querySelector<HTMLInputElement>('#count')!
      count.value = '5000'
      count.dispatchEvent(new Event('change'))
      expect(app().textContent, lang).toContain(say(grouped(5000, lang)))
    }
  })

  it('reads English for a locale it has no words in, and says so', async () => {
    await open('xx')
    expect(app().textContent).toContain('Test data')
    expect(app().querySelector('#insert')!.textContent).toBe('Insert…')
    expect(app().querySelector<HTMLSelectElement>('#lang')!.value).toBe('en')
    expect(document.documentElement.lang).toBe('en')
    const count = app().querySelector<HTMLInputElement>('#count')!
    count.value = '5000'
    count.dispatchEvent(new Event('change'))
    expect(app().textContent).toContain(`The first 5 of ${new Intl.NumberFormat('en').format(5000)}`)
    expect(dataLanguageOf('xx')).toBe('en')
    for (const lang of DATA_LANGUAGES) expect(dataLanguageOf(lang)).toBe(lang)
  })

  it('falls back to English and English numbers in a table that lacks the language', () => {
    const partial = { en: TEXT.en, tr: TEXT.tr }
    for (const locale of ['de', 'ru', 'fr', 'ko', 'xx']) {
      expect(shown(partial, locale), locale).toBe('en')
      expect(pick<Text>(partial, locale), locale).toBe(TEXT.en)
      expect(new Intl.NumberFormat(tag(shown(partial, locale))).format(12345), locale).toBe('12,345')
    }
    expect(shown(partial, 'tr')).toBe('tr')
    expect(pick<Text>(partial, 'tr')).toBe(TEXT.tr)
  })

  it('has a block of words and of data for every language the app speaks', () => {
    expect(Object.keys(TEXT).sort()).toEqual([...LANGUAGES].sort())
    expect([...DATA_LANGUAGES].sort()).toEqual([...LANGUAGES].sort())
    expect(Object.keys(LISTS).sort()).toEqual([...LANGUAGES].sort())
  })

  it('has the same words in every language as in English, key for key', () => {
    const en = shape(TEXT.en)
    for (const lang of LANGUAGES.filter((x) => x !== 'en')) {
      expect(shape(TEXT[lang]), lang).toEqual(en)
      expect(Object.keys(TEXT[lang].langs).sort(), lang).toEqual([...DATA_LANGUAGES].sort())
      expect(Object.keys(TEXT[lang].groups).sort(), lang).toEqual(Object.keys(TEXT.en.groups).sort())
      for (const [key, value] of Object.entries(TEXT[lang]))
        if (typeof value === 'string') expect(value.length, `${lang}.${key}`).toBeGreaterThan(0)
    }
    // Nothing left in English: a new language's sentences differ from the English ones.
    for (const lang of NEW)
      for (const key of ['title', 'reading', 'noPlace', 'hiddenHint', 'badField', 'retry'] as const)
        expect(TEXT[lang][key], `${lang}.${key}`).not.toBe(TEXT.en[key])
    for (const lang of NEW) {
      expect(TEXT[lang].tooLarge('1.05', '1', '1.04'), lang).toContain('1.05')
      expect(TEXT[lang].tooLargeDownload('1.05', '1', '1.04'), lang).toContain('1.04')
      expect(TEXT[lang].badFieldArray('items[]'), lang).toContain('items[]')
      expect(TEXT[lang].description('people'), lang).toContain('people')
      expect(TEXT[lang].previewOf(5, 9, String), lang).toMatch(/9/)
    }
  })

  it('writes each new language in its own script and words', () => {
    expect(TEXT.ko.title).toMatch(/^[가-힣 ]+$/)
    expect(TEXT.ru.title).toMatch(/^[А-Яа-я ]+$/)
    expect(TEXT.de.insertHint).toContain('Import-Assistenten')
    expect(TEXT.fr.insertHint).toContain('assistant d’importation')
    // The French rule: a narrow no-break space before a colon.
    expect(TEXT.fr.noFields).toContain(' :')
    // Sizes are written with the app's own unit in every language: MB, never Mo or МБ.
    expect(TEXT.fr.tooLarge('1', '2', '3')).toContain(' MB')
    for (const lang of LANGUAGES) {
      expect(TEXT[lang].tooLarge('1', '2', '3'), lang).toContain('MB')
      expect(TEXT[lang].tooLargeDownload('1', '2', '3'), lang).not.toMatch(/ Mo\b|МБ/)
    }
  })

  it('says one document in the right form, and Russian counts in three forms', () => {
    const only = {
      en: 'The only document',
      ko: '도큐먼트 1개뿐',
      de: 'Das einzige Dokument',
      fr: 'Le seul document',
      ru: 'Единственный документ',
    } as const
    for (const [lang, said] of Object.entries(only))
      expect(TEXT[lang as keyof typeof only].previewOf(1, 1, String), lang).toBe(said)
    const all = (n: number) => TEXT.ru.previewOf(n, n, String, pluralOf(n, 'ru'))
    expect(all(2)).toBe('Все 2 документа')
    expect(all(5)).toBe('Все 5 документов')
    expect(all(11)).toBe('Все 11 документов')
    expect(all(12)).toBe('Все 12 документов')
    expect(all(21)).toBe('Все 21 документ')
    expect(all(22)).toBe('Все 22 документа')
    expect(all(25)).toBe('Все 25 документов')
    expect(all(101)).toBe('Все 101 документ')
    expect(all(111)).toBe('Все 111 документов')
    expect(all(0)).toBe('Все 0 документов')
    expect(all(1.5)).toBe('Все 1.5 документов')
    // French counts 0 and 1 in the singular, 2 and more in the plural.
    const french = (n: number) => TEXT.fr.previewOf(n, n, String, pluralOf(n, 'fr'))
    expect(french(0)).toBe('Les 0 document')
    expect(french(2)).toBe('Les 2 documents')
    expect(french(21)).toBe('Les 21 documents')
    expect(french(1.5)).toBe('Les 1.5 document')
  })

  it('names every template in every language', () => {
    for (const x of TEMPLATES)
      for (const lang of LANGUAGES) expect(x.label[lang].length, `${x.id}.${lang}`).toBeGreaterThan(0)
    for (const lang of NEW)
      expect(TEMPLATES.filter((x) => x.label[lang] !== x.label.en).length, lang).toBeGreaterThan(80)
    const label = (id: string) => templateOf(id)!.label
    expect(label('fullName').ko).toBe('전체 이름')
    expect(label('fullName').de).toBe('Vollständiger Name')
    expect(label('fullName').fr).toBe('Nom complet')
    expect(label('fullName').ru).toBe('Полное имя')
    // Another language's name for a template is not borrowed.
    expect(new Set(LATEST.map((lang) => label('email')[lang])).size).toBe(LATEST.length)
  })
})

describe('the words of the new languages', () => {
  it('have every list English has, and nothing empty', () => {
    for (const [lang, lists] of Object.entries(LISTS))
      for (const key of Object.keys(EN) as Array<keyof Lists>) {
        const list = lists[key]
        expect(list, `${lang}.${key}`).toBeDefined()
        if (Array.isArray(list)) expect(list.length, `${lang}.${key}`).toBeGreaterThan(0)
      }
    for (const lists of [ES, JA, PT, ZH, KO, DE, FR, RU]) {
      expect(lists.weekdays).toHaveLength(7)
      expect(lists.months).toHaveLength(12)
      expect(lists.statuses).toHaveLength(EN.statuses.length)
      expect(lists.genders).toHaveLength(EN.genders.length)
    }
  })

  // Its own time: under half a second here, more than the default 5 s on a CI runner busy with every
  // package's tests at once (CI 2026-11-05, Node 26).
  it('make a value that is JSON for every template, and the same for the same seed', () => {
    for (const lists of [ZH, JA, ES, PT, KO, DE, FR, RU])
      for (let seed = 1; seed <= 25; seed++)
        for (const x of TEMPLATES) {
          const make = () => x.make({ r: rand(seed), lists, index: seed, existing: ['a'], constant: 'c' })
          const value = make()
          expect(() => JSON.parse(JSON.stringify(value)), x.id).not.toThrow()
          expect(value, x.id).not.toBeUndefined()
          expect(make(), x.id).toEqual(value)
        }
  }, 30_000)

  it('keep e-mails, web addresses, domains and phone numbers to what reaches no one', () => {
    const phones = {
      zh: /^\+86 000 \d{4} \d{4}$/,
      ja: /^\+81 000-\d{4}-\d{4}$/,
      es: /^\+34 000 /,
      pt: /^\+55 00 0\d{4}-\d{4}$/,
      ko: /^\+82 000-\d{4}-\d{4}$/,
      de: /^\+49 000 \d{7}$/,
      // The numbers France keeps for films and books.
      fr: /^\+33 1 99 00 \d\d \d\d$/,
      ru: /^\+7 000 \d{3}-\d\d-\d\d$/,
    }
    for (const [lang, lists] of [
      ['zh', ZH],
      ['ja', JA],
      ['es', ES],
      ['pt', PT],
      ['ko', KO],
      ['de', DE],
      ['fr', FR],
      ['ru', RU],
    ] as const)
      for (let seed = 1; seed <= 100; seed++) {
        const make = (id: string) => templateOf(id)!.make({ r: rand(seed), lists, index: 0 }) as string
        expect(make('email'), lang).toMatch(/^[a-z0-9.]+@(example\.(com|org|net)|mail\.test|shop\.test)$/)
        expect(make('url'), lang).toMatch(
          /^https:\/\/(example\.(com|org|net)|mail\.test|shop\.test)\/[a-z0-9]+\/\d+$/,
        )
        expect(make('domain'), lang).toMatch(/^[a-z0-9]+\.test$/)
        expect(make('slug'), lang).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
        expect(make('username'), lang).toMatch(/^[a-z0-9]+$/)
        expect(make('phone'), lang).toMatch(phones[lang])
      }
  })

  it('never make a real brand, company or famous person from the lists', () => {
    // Real companies and brands the lists once held or must never hold, and famous full names a
    // first name and a surname of the lists could join into (also in the Latin spelling).
    const brands = [
      '하나로',
      'Рубеж',
      'Hanaro',
      'Rubezh',
      '大和',
      '光洋',
      '三葉',
      'あおぞら',
      '星河',
      '华腾',
      'Verdemar',
      'Altamar',
      'Solaris',
      'Nordlicht',
      'Weitblick',
      'Falkenberg',
      'Eisenfels',
    ]
    const famous = [
      '박지민',
      '한지민',
      '김채원',
      '김시우',
      '朱军',
      '李娜',
      '杨洋',
      '张杰',
      '刘涛',
      '郭涛',
      '胡军',
      '王刚',
      '吴刚',
      '黄磊',
      '马超',
      '山田太郎',
      '山田花子',
      '鈴木愛',
      '高橋愛',
      '木村拓也',
      'Sergio Ramos',
      'Diego Torres',
      'Hugo Sánchez',
      'Raúl González',
      'Alejandro Fernández',
      'Pablo López',
      'Marta Sánchez',
      'Rosa López',
      'Paula Vázquez',
      'Lucía Jiménez',
      'Julia Navarro',
      'Thiago Silva',
      'André Silva',
      'André Gomes',
      'Bruno Fernandes',
      'Camila Alves',
      'Gabriel Barbosa',
      'Lucas Lima',
      'João Gomes',
      'João Pereira',
      'Fernanda Lima',
      'Fernanda Souza',
      'Eduardo Costa',
      'Beatriz Souza',
      'Lena Meyer',
      'Laura Müller',
      'Pierre Richard',
      'Louise Michel',
      'Louis Michel',
      'Jules Simon',
      'Gabriel Garcia',
      'Андрей Шевченко',
      'Сергей Лысенко',
      // English and Turkish (review of the last four languages): pioneers the lists once paired on
      // purpose, and well-known people common names happened to make.
      'Ada Lovelace',
      'Grace Hopper',
      'Alan Turing',
      'Edsger Dijkstra',
      'Barbara Liskov',
      'Ken Thompson',
      'Dennis Ritchie',
      'Margaret Hamilton',
      'Katherine Johnson',
      'Tim Berners',
      'Michael Jackson',
      'James Brown',
      'Paul Allen',
      'Recep Erdoğan',
      'Abdullah Gül',
      'Ali Koç',
      'Ahmet Kaya',
    ]
    for (const [lang, lists] of Object.entries(LISTS)) {
      const names = new Set<string>()
      for (const f of lists.firstNames)
        for (const l of lists.lastNames) {
          names.add(`${f} ${l}`)
          names.add(`${l} ${f}`)
          names.add(`${f}${l}`)
          names.add(`${l}${f}`)
        }
      for (const x of famous) expect(names.has(x), `${lang}: ${x}`).toBe(false)
      const everything = [...lists.companies, ...lists.firstNames, ...lists.lastNames, ...lists.products]
      for (const x of brands) expect(everything, `${lang}: ${x}`).not.toContain(x)
      for (const company of lists.companies) for (const x of brands) expect(company, lang).not.toContain(x)
    }
  })

  it('keep the Russian surnames Russian and the same for either gender', () => {
    expect(RU.lastNames).toHaveLength(20)
    for (const name of RU.lastNames) expect(name, name).toMatch(/(ых|их)$/)
    for (const name of RU.lastNames) expect(RU.latin?.[name], name).toMatch(/^[A-Z][a-z]+kh$/)
  })

  it('give every Chinese, Japanese, Korean and Russian name a Latin spelling', () => {
    for (const lists of [ZH, JA, KO, RU])
      for (const name of [...lists.firstNames, ...lists.lastNames])
        expect(lists.latin?.[name], name).toMatch(/^[A-Z][a-z]+$/)
    // Family name first, no space, in the three East Asian languages; Russian has a space.
    for (const lists of [ZH, JA, KO]) {
      const full = templateOf('fullName')!.make({ r: rand(3), lists, index: 0 }) as string
      expect(full).not.toContain(' ')
      expect(lists.lastNames.some((x) => full.startsWith(x))).toBe(true)
    }
    const russian = templateOf('fullName')!.make({ r: rand(3), lists: RU, index: 0 }) as string
    expect(russian.split(' ')).toHaveLength(2)
    expect(RU.firstNames).toContain(russian.split(' ')[0])
    expect(RU.lastNames).toContain(russian.split(' ')[1])
  })

  it('write a street and an address the way each language does', () => {
    const at = (lists: Lists) => templateOf('streetAddress')!.make({ r: rand(2), lists, index: 0 })
    expect(at(ES)).toMatch(/^(Calle|Avenida|Plaza|Paseo|Camino) .+ \d+$/)
    expect(at(PT)).toMatch(/^(Rua|Avenida|Travessa|Alameda|Praça) .+, \d+$/)
    expect(at(ZH)).toMatch(/号$/)
    expect(at(JA)).toMatch(/番地$/)
    expect(at(KO)).toMatch(/^\S+(로|길|대로) \d+$/)
    expect(at(DE)).toMatch(/^[A-ZÄÖÜ][a-zäöü]+(straße|allee|weg|platz|gasse) \d+$/)
    expect(at(FR)).toMatch(/^\d+ (rue|avenue|place|boulevard|impasse) .+$/)
    expect(at(RU)).toMatch(/^\S+ (улица|аллея|площадь|набережная), д\. \d+$/)
    const street = (lists: Lists) => templateOf('street')!.make({ r: rand(4), lists, index: 0 })
    expect(street(DE)).toMatch(/^[A-ZÄÖÜ][a-zäöü]+(straße|allee|weg|platz|gasse)$/)
    expect(street(FR)).toMatch(/^(rue|avenue|place|boulevard|impasse) /)
  })

  it('name a product so that the grammar holds', () => {
    const product = (lists: Lists, seed: number) =>
      templateOf('productName')!.make({ r: rand(seed), lists, index: 0 }) as string
    for (let seed = 1; seed <= 30; seed++) {
      // German: a prefix and a hyphen, never a declined adjective.
      expect(product(DE, seed)).toMatch(/^[A-Za-zÄÖÜäöü]+-[A-Za-zÄÖÜäöü]+$/)
      // Russian: the product, then the name of its line in quotes.
      expect(product(RU, seed)).toMatch(/^[А-Яа-я]+ «[А-Яа-я]+»$/)
      // French: the adjective follows the noun, and is the same for both genders.
      expect(product(FR, seed).split(' ').at(-1)).toMatch(
        /^(robuste|pratique|confortable|portable|moderne|solide|sobre|souple)$/,
      )
      // Korean: the adjective comes first, as in English.
      expect(KO.productAdjectives.some((x) => product(KO, seed).startsWith(x))).toBe(true)
    }
  })

  it('give the languages without a year-month-day habit their own names for days and months', () => {
    expect(KO.months[0]).toBe('1월')
    expect(RU.weekdays[0]).toBe('понедельник')
    expect(DE.months[2]).toBe('März')
    expect(FR.months[7]).toBe('août')
  })

  it('generate documents in the chosen language', () => {
    const plans = [
      { path: 'city', seen: 'string', template: 'city', include: true },
      { path: 'note', seen: 'string', template: 'sentence', include: true },
    ] as never
    const settings = { count: 3, blankShare: 0, seed: 5 }
    for (const lang of NEW) {
      const docs = generate(plans, { ...settings, lang })
      expect(LISTS[lang].cities, lang).toContain((docs[0] as { city: string }).city)
    }
    expect((generate(plans, { ...settings, lang: 'zh' })[0] as { note: string }).note).toMatch(/。$/)
    expect((generate(plans, { ...settings, lang: 'ko' })[0] as { note: string }).note).toMatch(/\.$/)
  })
})

describe('the manifest', () => {
  const manifest = JSON.parse(
    readFileSync(join(process.cwd(), 'public', 'mongo-manager-plugin.json'), 'utf8'),
  )
  /** Every `{ en, … }` object in the manifest. */
  const texts = (value: unknown): Array<Record<string, string>> =>
    value && typeof value === 'object'
      ? 'en' in value && typeof (value as { en: unknown }).en === 'string'
        ? [value as Record<string, string>]
        : Object.values(value).flatMap(texts)
      : []

  it('speaks all ten languages everywhere, within the limits, and is released as 1.2.1', () => {
    expect(manifest.version).toBe('1.2.1')
    expect(manifest.publishedAt).toBe('2026-11-07')
    expect(manifest.changelog[0].version).toBe('1.2.1')
    expect(manifest.changelog[0].notes.en).toContain('large documents')
    expect(manifest.changelog[1].version).toBe('1.2.0')
    expect(manifest.changelog[1].notes.en).toContain('Now in Korean, German, French and Russian too')
    expect(manifest.changelog[1].notes.en).not.toContain('Nothing else changes')
    expect(manifest.changelog[1].notes.fr).toContain(' ;')
    const found = texts(manifest)
    expect(found.length).toBeGreaterThanOrEqual(5)
    for (const text of found) expect(Object.keys(text).sort()).toEqual([...LANGUAGES].sort())
    for (const text of texts(manifest.changelog))
      for (const note of Object.values(text)) expect(note.length).toBeLessThanOrEqual(1000)
    for (const text of texts(manifest.description))
      for (const d of Object.values(text)) expect(d.length).toBeLessThanOrEqual(300)
    for (const title of texts(manifest.contributes))
      for (const t of Object.values(title)) expect(t.length).toBeLessThanOrEqual(40)
    for (const text of found) for (const value of Object.values(text)) expect(value).not.toMatch(/\p{Cc}/u)
  })

  it('has a README in every language', () => {
    for (const lang of LANGUAGES) {
      const file = lang === 'en' ? 'README.md' : `README.${lang}.md`
      const text = readFileSync(join(process.cwd(), 'public', file), 'utf8')
      expect(text.startsWith('# '), file).toBe(true)
      expect(text, file).toContain('`_id`')
    }
  })
})
