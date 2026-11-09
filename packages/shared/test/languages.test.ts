// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import {
  UI_LANGUAGES,
  UI_LANGUAGE_TAGS,
  parseAcceptLanguage,
  uiLanguageFromTags,
  uiLanguageOf,
} from '../src/index'

/**
 * Languages (2026-10-29; review of the languages, minors 3 and 5): one rule, in the browser and on
 * the server, for which of a reader's languages the app speaks, and one table of their tags.
 */
describe('the app’s languages', () => {
  it('have a tag each: what picks Chinese and Japanese glyphs', () => {
    expect(Object.keys(UI_LANGUAGE_TAGS)).toEqual([...UI_LANGUAGES])
    expect(UI_LANGUAGE_TAGS.zh).toBe('zh-CN')
    expect(UI_LANGUAGE_TAGS.pt).toBe('pt-BR')
    expect(uiLanguageOf('xx')).toBe('en')
  })

  it('take the first of the reader’s languages they have, Simplified Chinese only where it is written', () => {
    expect(uiLanguageFromTags(['zh-CN', 'en'])).toBe('zh')
    expect(uiLanguageFromTags(['zh'])).toBe('zh')
    expect(uiLanguageFromTags(['zh-Hans-HK'])).toBe('zh')
    expect(uiLanguageFromTags(['zh-SG'])).toBe('zh')
    expect(uiLanguageFromTags(['zh-MY'])).toBe('zh')
    for (const tag of ['zh-TW', 'zh-HK', 'zh-MO', 'zh-Hant', 'zh-Hant-CN', 'zh-yue', 'yue'])
      expect(uiLanguageFromTags([tag]), tag).toBeNull()
    expect(uiLanguageFromTags(['zh-TW', 'ja-JP'])).toBe('ja')
    expect(uiLanguageFromTags(['pt-PT'])).toBe('pt')
    expect(uiLanguageFromTags(['nl-NL', 'de-AT'])).toBe('de')
    expect(uiLanguageFromTags(['nl-NL', 'de-AT'], ['en', 'tr'])).toBeNull()
    expect(uiLanguageFromTags(['', 'EN-gb'])).toBe('en')
    expect(uiLanguageFromTags([])).toBeNull()
  })

  it('read an Accept-Language header by its weights, leaving out what is refused', () => {
    expect(parseAcceptLanguage('fr;q=0, de-DE;q=0.5, ja;q=0.9, *')).toEqual(['*', 'ja', 'de-DE'])
    expect(parseAcceptLanguage('zh-CN,zh;q=0.9,en;q=0.8')).toEqual(['zh-CN', 'zh', 'en'])
    expect(parseAcceptLanguage('es;q=abc, ko')).toEqual(['ko', 'es'])
    expect(parseAcceptLanguage(undefined)).toEqual([])
    expect(parseAcceptLanguage('')).toEqual([])
    expect(uiLanguageFromTags(parseAcceptLanguage('fr;q=0, ru;q=0.5'))).toBe('ru')
  })
})
