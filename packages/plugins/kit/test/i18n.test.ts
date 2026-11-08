// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { UI_LANGUAGES, UI_LANGUAGE_TAGS } from '../../../shared/src/languages'
import { LANGUAGES, langTag, languageOf, pick, pluralOf, shown } from '../src/i18n'
import { ASK_CODES, AskError, askMessage } from '../src/client'
import { describeValue, formatNumber } from '../src/ui'

/**
 * Languages (2026-10-29; review of the languages I3, minors 5 and 12): the kit speaks the app's ten
 * languages, and a plugin's page is marked, and its numbers written, in the language its words are
 * really in — English when it has none in the reader's.
 */
describe('the kit’s languages', () => {
  it('are the app’s, with the app’s tags', () => {
    expect(LANGUAGES).toEqual(UI_LANGUAGES)
    for (const l of LANGUAGES) expect(langTag(l), l).toBe(UI_LANGUAGE_TAGS[l])
    expect(languageOf('xx')).toBe('en')
    expect(langTag('xx')).toBe('en')
  })

  it('pick the reader’s words, and say which language they are in', () => {
    const texts = { en: 'Map', tr: 'Harita', ja: '地図' }
    expect(pick(texts, 'ja')).toBe('地図')
    expect(shown(texts, 'ja')).toBe('ja')
    expect(pick(texts, 'de')).toBe('Map')
    expect(shown(texts, 'de')).toBe('en')
    expect(shown(texts, 'xx')).toBe('en')
    expect(langTag(shown(texts, 'de'))).toBe('en')
  })

  it('put a count in the language’s plural category', () => {
    expect([1, 2, 5, 11, 12, 14, 21, 22, 25, 111, 112, 0].map((n) => pluralOf(n, 'ru'))).toEqual([
      'one',
      'few',
      'many',
      'many',
      'many',
      'many',
      'one',
      'few',
      'many',
      'many',
      'many',
      'many',
    ])
    expect([0, 1, 2].map((n) => pluralOf(n, 'fr'))).toEqual(['one', 'one', 'other'])
    expect([0, 1, 2].map((n) => pluralOf(n, 'de'))).toEqual(['other', 'one', 'other'])
    expect([1, 2].map((n) => pluralOf(n, 'ko'))).toEqual(['other', 'other'])
    expect(pluralOf(1, 'xx')).toBe('one')
  })

  it('say every refusal in every language', () => {
    for (const l of LANGUAGES)
      for (const code of ASK_CODES) {
        const words = askMessage(new AskError(code, 'RAW'), l)
        expect(words, `${l} ${code}`).not.toBe('RAW')
        expect(words.trim(), `${l} ${code}`).not.toBe('')
      }
    expect(askMessage(new AskError('constructor', 'As the app said'), 'ja')).toBe('As the app said')
    expect(askMessage(new AskError('busy', 'x'), 'ko')).toMatch(/[가-힯]/)
  })

  it('write numbers and a value’s field count in the page’s language', () => {
    expect(formatNumber(12345.5, 'de')).toBe(
      new Intl.NumberFormat('de', { maximumFractionDigits: 2 }).format(12345.5),
    )
    expect(formatNumber(12345.5, 'xx')).toBe('12,345.5')
    const fields = (lang: string, n: number) => {
      document.documentElement.lang = lang
      return describeValue(Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}`, i]))).text
    }
    expect(fields('en', 1)).toBe('{ 1 field }')
    expect(fields('en', 3)).toBe('{ 3 fields }')
    expect(fields('tr', 3)).toBe('{ 3 alan }')
    expect(fields('zh-CN', 3)).toBe('{ 3 个字段 }')
    expect(fields('ja', 3)).toBe('{ 3 個のフィールド }')
    expect(fields('ko', 3)).toBe('{ 필드 3개 }')
    expect(fields('es', 1)).toBe('{ 1 campo }')
    expect(fields('pt-BR', 2)).toBe('{ 2 campos }')
    expect(fields('de', 2)).toBe('{ 2 Felder }')
    expect(fields('fr', 0)).toBe('{ 0 champ }')
    expect([1, 2, 5, 21].map((n) => fields('ru', n))).toEqual([
      '{ 1 поле }',
      '{ 2 поля }',
      '{ 5 полей }',
      '{ 21 поле }',
    ])
  })
})
