import { pluralOf, type Language } from '../../kit/src/i18n'

/**
 * A count for the texts of a page: the number (for the plural rules) and the text the reader sees
 * for it ("1,234" or "1 234", by the language shown).
 */
export interface Count {
  n: number
  s: string
}

/** Whether a language says a number in its singular form: Intl's "one" (French: 0 and 1 too). */
export const isOne = (n: number, language: Language): boolean => pluralOf(n, language) === 'one'

/** Russian: the form for one (1, 21…), few (2–4, 22…) or many (0, 5–20…), by Intl's own rules. */
export function ru(n: number, one: string, few: string, many: string): string {
  const category = pluralOf(n, 'ru')
  return category === 'one' ? one : category === 'few' ? few : many
}
