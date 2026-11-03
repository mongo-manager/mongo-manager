import { createI18n } from 'vue-i18n'
import {
  UI_LANGUAGES,
  UI_LANGUAGE_TAGS,
  uiLanguageFromTags,
  type UiLanguage,
} from '@mongo-manager/shared/browser'
import en from './locales/en.json'
import tr from './locales/tr.json'

/**
 * Languages (user request 2026-10-29): English first, Turkish second, then Chinese, Japanese,
 * Spanish, Brazilian Portuguese, Korean, German, French and Russian. English and Turkish are in the
 * bundle; the others load when chosen.
 */
export type Locale = UiLanguage

/** Each language by its own name, so it is found whatever language is on screen. */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: 'English',
  tr: 'Türkçe',
  zh: '简体中文',
  ja: '日本語',
  es: 'Español',
  pt: 'Português (Brasil)',
  ko: '한국어',
  de: 'Deutsch',
  fr: 'Français',
  ru: 'Русский',
}

/** The page's lang attribute: what picks the right glyphs (Chinese, Japanese) and hyphenation. */
export const LOCALE_TAGS: Record<Locale, string> = UI_LANGUAGE_TAGS

export const isLocale = (value: unknown): value is Locale =>
  typeof value === 'string' && (LOCALES as readonly string[]).includes(value)

/** The browser's language when it is one offered (zh-TW and the like are not Simplified Chinese). */
export function browserLocale(languages: readonly string[]): Locale {
  return uiLanguageFromTags(languages, LOCALES) ?? 'en'
}

type Messages = typeof en
const LOADERS = import.meta.glob<{ default: Messages }>([
  './locales/*.json',
  '!./locales/en.json',
  '!./locales/tr.json',
])

/** The languages offered: those with words, in the app's order. */
export const LOCALES: readonly Locale[] = UI_LANGUAGES.filter(
  (l) => l === 'en' || l === 'tr' || `./locales/${l}.json` in LOADERS,
)

/** Russian: one, few, many — after a zero form when English has one ("none | 1 | {n}"). */
function russian(choice: number): number {
  const n = Math.abs(choice)
  const d = n % 10
  const h = n % 100
  if (d === 1 && h !== 11) return 0
  if (d >= 2 && d <= 4 && (h < 12 || h > 14)) return 1
  return 2
}

export const i18n = createI18n({
  legacy: false,
  locale: 'en',
  fallbackLocale: 'en',
  messages: { en, tr } as Record<string, Messages>,
  missingWarn: false,
  fallbackWarn: false,
  pluralRules: {
    ru: (choice: number, forms: number) =>
      forms === 4
        ? choice === 0
          ? 0
          : 1 + russian(choice)
        : forms === 3
          ? russian(choice)
          : choice === 1
            ? 0
            : 1,
    // French: zero takes the singular ("0 document").
    fr: (choice: number, forms: number) =>
      forms === 3 ? (choice === 0 ? 0 : choice === 1 ? 1 : 2) : Math.abs(choice) <= 1 ? 0 : 1,
  },
})

/** Whether the language's words are here: it shows at once when chosen. */
export const isLoaded = (locale: Locale) => i18n.global.availableLocales.includes(locale)
const loaded = isLoaded

/** The language's messages, loaded once; a failed load leaves the language unloaded (the page as it was). */
export async function loadLocale(locale: Locale): Promise<void> {
  if (loaded(locale)) return
  const load = LOADERS[`./locales/${locale}.json`]
  if (!load) return
  i18n.global.setLocaleMessage(locale, (await load()).default)
}

let wanted: Locale = 'en'
function show(locale: Locale): void {
  i18n.global.locale.value = locale
  document.documentElement.lang = LOCALE_TAGS[locale]
}

/**
 * On screen at once when loaded; otherwise once loaded, unless another was chosen meanwhile. Whether
 * it is on screen: a language that could not be loaded leaves the page as it was (review I2).
 */
export type LocaleOutcome = 'shown' | 'superseded' | 'failed'
export function setLocale(locale: Locale): Promise<LocaleOutcome> {
  wanted = locale
  if (loaded(locale)) {
    show(locale)
    return Promise.resolve('shown')
  }
  return loadLocale(locale).then(
    () => {
      if (wanted !== locale) return 'superseded'
      if (!loaded(locale)) return 'failed'
      show(locale)
      return 'shown'
    },
    () => (wanted === locale ? 'failed' : 'superseded'),
  )
}
