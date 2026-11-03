/**
 * Languages (2026-10-29): the app's ten languages, as a plugin's frame is told them (two letters:
 * Chinese is Simplified Chinese, Portuguese is Brazilian Portuguese). A plugin keeps its words per
 * language and picks them with {@link pick}; a language it has no words for reads English.
 */
export const LANGUAGES = ['en', 'tr', 'zh', 'ja', 'es', 'pt', 'ko', 'de', 'fr', 'ru'] as const
export type Language = (typeof LANGUAGES)[number]

/** One of the app's languages, from what the app said (English for anything else). */
export const languageOf = (locale: string): Language =>
  (LANGUAGES as readonly string[]).includes(locale) ? (locale as Language) : 'en'

/** The words in the reader's language, English when the plugin has none in it. */
export function pick<T>(texts: { en: T } & Partial<Record<Language, T>>, locale: string): T {
  return texts[languageOf(locale)] ?? texts.en
}

/**
 * Review of the languages (I3): the language the words picked are really in — the reader's when the
 * plugin has words in it, English otherwise. What marks the page and formats its numbers, so an
 * English page never reads as German.
 */
export function shown(texts: { en: unknown } & Partial<Record<Language, unknown>>, locale: string): Language {
  const language = languageOf(locale)
  return texts[language] === undefined ? 'en' : language
}

/**
 * Review of the last four languages (minor 18): a count's plural category in a language, by the
 * Unicode rules Intl carries — Russian one (1, 21, 101), few (2–4, 22–24), many (0, 5–20, 11–14…);
 * French one for 0 and 1; one or other elsewhere. One rule for every plugin, no hand-made copies.
 */
export function pluralOf(n: number, locale: string): Intl.LDMLPluralRule {
  return new Intl.PluralRules(langTag(locale)).select(n)
}

/** The page's lang attribute for a language: what picks Chinese and Japanese glyphs. */
export function langTag(locale: string): string {
  const language = languageOf(locale)
  return language === 'zh' ? 'zh-CN' : language === 'pt' ? 'pt-BR' : language
}
