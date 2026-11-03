import { z } from 'zod'

/**
 * The app's languages (user request 2026-10-29): English first, Turkish second, then the others by
 * how many MongoDB developers read them. Two letters each: Chinese is Simplified Chinese, Portuguese
 * is Brazilian Portuguese.
 */
export const UI_LANGUAGES = ['en', 'tr', 'zh', 'ja', 'es', 'pt', 'ko', 'de', 'fr', 'ru'] as const
export type UiLanguage = (typeof UI_LANGUAGES)[number]
export const UiLanguageSchema = z.enum(UI_LANGUAGES)

/** Each language's name in English: what a prompt asks a model to write in. */
export const UI_LANGUAGE_ENGLISH_NAMES: Record<UiLanguage, string> = {
  en: 'English',
  tr: 'Turkish',
  zh: 'Simplified Chinese',
  ja: 'Japanese',
  es: 'Spanish',
  pt: 'Brazilian Portuguese',
  ko: 'Korean',
  de: 'German',
  fr: 'French',
  ru: 'Russian',
}

/**
 * Each language's tag, for a page's lang attribute and Intl: what picks Chinese and Japanese glyphs
 * and the right number and date formats (review of the languages, minor 5: the one table of them).
 */
export const UI_LANGUAGE_TAGS: Record<UiLanguage, string> = {
  en: 'en',
  tr: 'tr',
  zh: 'zh-CN',
  ja: 'ja',
  es: 'es',
  pt: 'pt-BR',
  ko: 'ko',
  de: 'de',
  fr: 'fr',
  ru: 'ru',
}

/** A language this app has, from any string (English otherwise). */
export const uiLanguageOf = (value: unknown): UiLanguage =>
  typeof value === 'string' && (UI_LANGUAGES as readonly string[]).includes(value)
    ? (value as UiLanguage)
    : 'en'

/** Chinese is Simplified Chinese here: plain zh, the Hans script, or a region that writes it. */
function simplifiedChinese(parts: string[]): boolean {
  if (parts.length === 1) return true
  if (parts.includes('hant')) return false
  if (parts.includes('hans')) return true
  return parts.length === 2 && ['cn', 'sg', 'my'].includes(parts[1]!)
}

/**
 * Review of the languages (minor 3): the first of a reader's languages (BCP 47 tags, most wanted
 * first) that the app offers; null when it offers none of them. The same rule in the browser and on
 * the server.
 */
export function uiLanguageFromTags(
  tags: readonly string[],
  offered: readonly UiLanguage[] = UI_LANGUAGES,
): UiLanguage | null {
  for (const tag of tags) {
    const parts = tag.trim().toLowerCase().split('-').filter(Boolean)
    const base = parts[0]
    if (!base) continue
    if (base === 'zh' && !simplifiedChinese(parts)) continue
    if ((offered as readonly string[]).includes(base)) return base as UiLanguage
  }
  return null
}

/** An Accept-Language header's tags, most wanted first; a tag weighted 0 is refused, so left out. */
export function parseAcceptLanguage(header: string | undefined): string[] {
  const out: { tag: string; q: number; at: number }[] = []
  for (const [at, part] of (header ?? '').split(',').entries()) {
    const [tag, ...params] = part.split(';').map((s) => s.trim())
    if (!tag) continue
    const qParam = params.find((p) => p.toLowerCase().startsWith('q='))
    const q = qParam === undefined ? 1 : Number(qParam.slice(2))
    if (!Number.isFinite(q) || q <= 0 || q > 1) {
      if (qParam !== undefined && !Number.isFinite(q)) out.push({ tag, q: 0.001, at })
      continue
    }
    out.push({ tag, q, at })
  }
  return out.sort((a, b) => b.q - a.q || a.at - b.at).map((t) => t.tag)
}
