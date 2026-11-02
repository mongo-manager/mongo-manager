/**
 * W2.4 (2026-10-16): the collation locales offered when a collection is made — the languages
 * MongoDB's ICU collation names most often, each with its variants, and "simple" (binary order).
 */
export const COLLATION_LOCALES = [
  'simple',
  'af',
  'ar',
  'az',
  'be',
  'bg',
  'bn',
  'bs',
  'ca',
  'cs',
  'cy',
  'da',
  'de',
  'de@collation=phonebook',
  'de_AT',
  'el',
  'en',
  'en_US',
  'en_US_POSIX',
  'es',
  'es@collation=traditional',
  'et',
  'fa',
  'fi',
  'fil',
  'fr',
  'fr_CA',
  'ga',
  'he',
  'hi',
  'hr',
  'hu',
  'hy',
  'id',
  'is',
  'it',
  'ja',
  'ka',
  'kk',
  'ko',
  'lt',
  'lv',
  'mk',
  'ms',
  'mt',
  'nb',
  'nl',
  'nn',
  'pl',
  'pt',
  'ro',
  'ru',
  'sk',
  'sl',
  'sq',
  'sr',
  'sv',
  'sw',
  'ta',
  'th',
  'tr',
  'uk',
  'ur',
  'uz',
  'vi',
  'zh',
  'zh_Hant',
] as const

/** Each locale with its name in the language the app speaks: "Turkish (tr)". */
export function collationLocales(
  uiLocale: string,
  simpleLabel: string,
): Array<{ value: string; label: string }> {
  let names: Intl.DisplayNames | null = null
  try {
    names = new Intl.DisplayNames([uiLocale], { type: 'language' })
  } catch {
    names = null
  }
  return COLLATION_LOCALES.map((code) => {
    if (code === 'simple') return { value: code, label: simpleLabel }
    const [tag, variant] = code.split('@')
    let name: string
    try {
      name = names?.of(tag!.replace(/_/g, '-')) ?? ''
    } catch {
      name = ''
    }
    const suffix = variant ? `, ${variant.split('=')[1]}` : ''
    return { value: code, label: name && name !== tag ? `${name}${suffix} (${code})` : code }
  })
}
