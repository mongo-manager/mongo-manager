// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createI18n } from 'vue-i18n'
import { UI_LANGUAGES, isHiddenChar } from '@mongo-manager/shared/browser'
import { browserLocale, i18n, LOCALE_NAMES, LOCALES, loadLocale, setLocale } from '../src/i18n'

/**
 * Languages (user request 2026-10-29: "hiç bir çeviriyi kaçırma" — miss no translation): every
 * language file has every message, in its own words, with the same placeholders, plural forms its
 * grammar needs, and nothing vue-i18n would read as markup or syntax.
 */
type Tree = { [key: string]: string | Tree }
const DIR = join(import.meta.dirname, '..', 'src', 'i18n', 'locales')
const read = (lang: string) => JSON.parse(readFileSync(join(DIR, `${lang}.json`), 'utf8')) as Tree
function flatten(tree: Tree, prefix = ''): Map<string, string> {
  const out = new Map<string, string>()
  for (const [k, v] of Object.entries(tree)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (typeof v === 'string') out.set(key, v)
    else for (const [kk, vv] of flatten(v, key)) out.set(kk, vv)
  }
  return out
}
const placeholders = (s: string) => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort()
const words = (s: string) => s.replace(/\{\w+\}/g, '').match(/[A-Za-z]{3,}/g) ?? []

const E = flatten(read('en'))
const FILES = readdirSync(DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.slice(0, -5))
  .sort()
const OTHERS = FILES.filter((l) => l !== 'en')
/** Turkish came first, worded by hand (one plural form, a few kept terms); these rules are the new ones'. */
const NEW = OTHERS.filter((l) => l !== 'tr')

/** Names and codes that read the same in every language (a product, a format, a key name). */
const SAME_EVERYWHERE = new Set([
  'app.name',
  'tabs.sqlTransfer',
  'sqlTransfer.title',
  'connection.sections.tls',
  'connection.encryption.kms.aws',
  'connection.encryption.kms.azure',
  'connection.encryption.kms.gcp',
  'overview.dashboard.gallery.groups.app',
  'overview.widgets.appStatus.title',
  'shell.theme.names.github-light',
  'shell.theme.names.github-dark',
  'shell.theme.names.one-dark',
  'shell.theme.names.solarized-light',
  'shell.theme.names.solarized-dark',
  'shell.snippets.types.boolean',
  'dataTransfer.formatNames.xlsx',
  'dataTransfer.ejson',
  'dataTransfer.encodings.latin1',
  'dataTransfer.types.int64',
  'dataTransfer.lineEndings.crlf',
  'dataTransfer.lineEndings.lf',
  'backup.format.archiveCode',
  'backup.format.gzipCode',
  'backup.format.mmbakCode',
  'destinations.type.gdrive',
  'destinations.type.gcs',
  'destinations.type.azure',
  'destinations.preset.spaces',
  'destinations.preset.spacesCold',
  'destinations.preset.nextcloud',
  'destinations.editor.sseAes',
  'destinations.editor.sseKms',
  'ai.kind.gemini',
  'plugins.github.placeholder',
  'dbAccess.users.externalDb',
  'indexes.kind2dsphere',
  'indexes.ttlMinutes',
  'overview.shards.chunks',
  'alerts.channels.webhooks',
  'shell.results.kinds.ChangeStreamCursor',
])
/** Words a language's own developers use as they are (Brazilian Portuguese: "backup", "plugin"). */
const SAME_IN: Record<string, string[]> = {
  pt: ['ai.agent.summary.backups', 'plugins.filter.count'],
  // German and French write these as English does.
  de: [
    'connection.schemeStandard',
    'indexes.nameOptional',
    'keys.importFlow.name',
    'sqlTransfer.parts.import',
    'sqlTransfer.parts.export',
  ],
  fr: [
    'connection.schemeStandard',
    'database.collectionsCount',
    'collection.header.documents',
    'overview.view.documents',
    'users.session.minutes',
    'jobs.ui.documentsOf',
    'shell.results.docs',
    'dataTransfer.types.json',
    'backup.scope.countCollections',
    'ai.agent.summary.collections',
    'ai.agent.summary.destinations',
    'ai.agent.summary.count',
    'ai.agent.summary.suggestions',
    'ai.agent.results.count',
    'alerts.rules.sustainOption',
    'model.counts.collections',
  ],
}
const SCRIPT: Record<string, RegExp> = {
  zh: /[一-鿿]/,
  ja: /[぀-ヿ一-鿿]/,
  ko: /[가-힯]/,
  ru: /[Ѐ-ӿ]/,
}

describe('the language files', () => {
  it('are each a language of the app, offered in the app’s order', () => {
    expect(FILES.filter((l) => !(UI_LANGUAGES as readonly string[]).includes(l))).toEqual([])
    expect(LOCALES).toEqual(UI_LANGUAGES.filter((l) => FILES.includes(l)))
    // Languages (2026-10-29): all ten are here.
    expect(FILES).toEqual([...UI_LANGUAGES].sort())
    expect(Object.keys(LOCALE_NAMES).sort()).toEqual([...UI_LANGUAGES].sort())
  })

  for (const lang of NEW) {
    describe(lang, () => {
      const T = flatten(read(lang))

      it('have exactly the keys of English', () => {
        expect([...T.keys()].filter((k) => !E.has(k))).toEqual([])
        expect([...E.keys()].filter((k) => !T.has(k))).toEqual([])
      })

      it('keep every placeholder, and only those', () => {
        const wrong = [...E].filter(
          ([k, v]) => placeholders(T.get(k) ?? '').join() !== placeholders(v).join(),
        )
        expect(wrong.map(([k]) => k)).toEqual([])
      })

      it('have the plural forms the language needs', () => {
        const wrong = [...E].filter(([k, v]) => {
          const t = T.get(k) ?? ''
          if (!v.includes(' | ')) return t.split('|').length !== v.split('|').length
          const forms = v.split(' | ').length + (lang === 'ru' ? 1 : 0)
          return t.split('|').length !== forms
        })
        expect(wrong.map(([k]) => `${k}: ${T.get(k)}`)).toEqual([])
      })

      it('say nothing vue-i18n would read as syntax or markup', () => {
        // vue-i18n's own test, its range #-\/ spelled out: # $ % & ' ( ) * + , - . /
        const html = /<\/?[\w\s="/.':;#$%&()*+,-]+>/
        const bad = [...T].filter(
          ([, v]) =>
            !v.trim() ||
            /[{}]/.test(v.replace(/\{\w+\}/g, '')) ||
            v.includes('@') ||
            v.includes('${') ||
            /<[a-z]/i.test(v) ||
            html.test(v),
        )
        expect(bad.map(([k, v]) => `${k}: ${v}`)).toEqual([])
      })

      // Review of the languages (minor 22): this finds a message left in English, or one in Latin
      // letters where the language has its own script; a Spanish or Portuguese message only half in
      // English it cannot tell — the reviews per language look for those.
      it('translate every message', () => {
        const untranslated = [...E].filter(([k, v]) => {
          if (SAME_EVERYWHERE.has(k) || SAME_IN[lang]?.includes(k)) return false
          const t = T.get(k) ?? ''
          if (t === v && words(v).length >= 2) return true
          return !!SCRIPT[lang] && words(v).length >= 3 && !SCRIPT[lang]!.test(t)
        })
        expect(untranslated.map(([k]) => k)).toEqual([])
      })
    })
  }
})

// Review of the last four languages (I7): the language files are not linted for odd spaces (French
// puts U+202F before ; : ! ?), so this test keeps what the lint did and more, in all ten: nothing
// that hides, reverses or blanks text (the app's own list), and no odd space but French's.
describe('the language files’ characters', () => {
  const ODD_SPACES = [
    0x85,
    0xa0,
    0x1680,
    ...Array.from({ length: 11 }, (_, i) => 0x2000 + i),
    0x202f,
    0x205f,
    0x3000,
  ]
  for (const lang of FILES)
    it(`${lang} holds nothing hidden, and no odd space but French typography's`, () => {
      const bad = [...flatten(read(lang))].filter(([, v]) =>
        [...v].some((c) => {
          const code = c.codePointAt(0)!
          if (code === 0x0a) return false
          if (isHiddenChar(code)) return true
          return ODD_SPACES.includes(code) && !(lang === 'fr' && code === 0x202f)
        }),
      )
      expect(bad.map(([k, v]) => `${k}: ${JSON.stringify(v)}`)).toEqual([])
    })
})

describe('choosing a language', () => {
  it('follows the browser when the app has its language', () => {
    expect(browserLocale(['zh-CN', 'en'])).toBe('zh')
    expect(browserLocale(['zh-TW', 'ja-JP'])).toBe('ja')
    expect(browserLocale(['pt-PT'])).toBe('pt')
    expect(browserLocale(['nl-NL', 'es-AR'])).toBe('es')
    expect(browserLocale(['nl-NL'])).toBe('en')
    expect(browserLocale([])).toBe('en')
  })

  it('loads a language when it is chosen, and marks the page with it', async () => {
    await setLocale('ja')
    expect(i18n.global.locale.value).toBe('ja')
    expect(document.documentElement.lang).toBe('ja')
    expect(i18n.global.t('header.settings')).toBe((read('ja').header as Tree).settings)
    await setLocale('zh')
    expect(document.documentElement.lang).toBe('zh-CN')
    await setLocale('en')
    expect(document.documentElement.lang).toBe('en')
  })

  it('keeps the last choice when two are made at once', async () => {
    const a = setLocale('es')
    const b = setLocale('en')
    await Promise.all([a, b])
    expect(i18n.global.locale.value).toBe('en')
  })

  it('loads every language’s messages', async () => {
    for (const lang of NEW) await loadLocale(lang as never)
    for (const lang of NEW) expect(i18n.global.availableLocales, lang).toContain(lang)
  })
})

describe('plural forms by language', () => {
  const make = (locale: string, message: string) =>
    createI18n({
      legacy: false,
      locale,
      messages: { [locale]: { m: message } },
      pluralRules: (i18n.global as unknown as { pluralRules: Record<string, never> }).pluralRules,
    })

  it('puts Russian counts in one, few and many, after the zero form', () => {
    const three = make('ru', '{n} файл | {n} файла | {n} файлов').global
    const say = (n: number) => three.t('m', { n }, n)
    expect([1, 2, 5, 11, 21, 22, 25, 111, 112].map(say)).toEqual([
      '1 файл',
      '2 файла',
      '5 файлов',
      '11 файлов',
      '21 файл',
      '22 файла',
      '25 файлов',
      '111 файлов',
      '112 файлов',
    ])
    const four = make('ru', 'нет файлов | {n} файл | {n} файла | {n} файлов').global
    expect([0, 1, 3, 7].map((n) => four.t('m', { n }, n))).toEqual([
      'нет файлов',
      '1 файл',
      '3 файла',
      '7 файлов',
    ])
  })

  it('puts a French zero in the singular', () => {
    const fr = make('fr', '{n} document | {n} documents').global
    expect([0, 1, 2].map((n) => fr.t('m', { n }, n))).toEqual(['0 document', '1 document', '2 documents'])
  })
})
