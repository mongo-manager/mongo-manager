// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { LANGUAGES, languageOf, pick, shown } from '../../kit/src/ui'
import { TEXT } from '../src/text'

/** Languages (2026-10-29): every language block has the very keys of English. */
const shape = (v: unknown): unknown =>
  typeof v === 'function'
    ? 'function'
    : v && typeof v === 'object'
      ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x)]))
      : typeof v

describe('the words per language', () => {
  const have = Object.keys(TEXT) as Array<keyof typeof TEXT>
  it('has all ten languages of the app', () => {
    expect([...have].sort()).toEqual([...LANGUAGES].sort())
  })
  for (const lang of LANGUAGES.filter((l) => l !== 'en'))
    it(`${lang} has exactly the keys of English`, () => {
      expect(shape(TEXT[lang])).toEqual(shape(TEXT.en))
    })
  it('reads a few strings in each new language', () => {
    expect(TEXT.zh.title).toBe('数据匿名化')
    expect(TEXT.ja.techniques.shuffle).toBe('シャッフル')
    expect(TEXT.es.save).toBe('Guardar configuración')
    expect(TEXT.pt.prepare).toBe('Criar a cópia')
    expect(TEXT.ko.title).toBe('익명화')
    expect(TEXT.ko.techniques.shuffle).toBe('셔플')
    expect(TEXT.de.title).toBe('Anonymisierer')
    expect(TEXT.de.save).toBe('Einstellungen speichern')
    expect(TEXT.fr.title).toBe('Anonymiseur')
    expect(TEXT.fr.techniques.hash).toBe('Hachage cohérent')
    expect(TEXT.ru.title).toBe('Анонимизатор')
    expect(TEXT.ru.techniques.shuffle).toBe('Перемешать')
    for (const lang of LANGUAGES) {
      expect(TEXT[lang].description('people')).toContain('people')
      expect(TEXT[lang].prepared(3, '1 KB')).toContain('3')
      expect(TEXT[lang].loaded(2)).toContain('2')
    }
  })
  it('gives each language its singular for one, and Russian its three forms', () => {
    expect(TEXT.en.prepared(1, 'x')).toContain('1 document,')
    expect(TEXT.en.prepared(2, 'x')).toContain('2 documents,')
    expect(TEXT.en.loaded(1)).toContain('1 of their fields is not')
    expect(TEXT.es.prepared(1, 'x')).toContain('1 documento,')
    expect(TEXT.pt.cut(1)).toContain('1 documento:')
    expect(TEXT.es.loaded(1)).toContain('no está')
    expect(TEXT.pt.loaded(1)).toContain('não está')
    expect(TEXT.de.prepared(1, 'x')).toContain('1 Dokument,')
    expect(TEXT.de.prepared(2, 'x')).toContain('2 Dokumente,')
    expect(TEXT.de.loaded(1)).toContain('ihrer Felder ist')
    expect(TEXT.de.loaded(3)).toContain('ihrer Felder sind')
    expect(TEXT.fr.prepared(1, 'x')).toContain('1 document,')
    expect(TEXT.fr.prepared(2, 'x')).toContain('2 documents,')
    expect(TEXT.fr.loaded(1)).toContain('n’est pas')
    expect(TEXT.fr.loaded(2)).toContain('ne sont pas')
    expect(TEXT.ru.prepared(1, 'x')).toContain('1 документ,')
    expect(TEXT.ru.prepared(3, 'x')).toContain('3 документа,')
    expect(TEXT.ru.prepared(5, 'x')).toContain('5 документов,')
    expect(TEXT.ru.prepared(21, 'x')).toContain('21 документ,')
    expect(TEXT.ru.loaded(2)).toContain('2 поля')
    expect(TEXT.ru.loaded(11)).toContain('11 полей')
    expect(TEXT.ru.cut(1)).toContain('до 1 документа')
    expect(TEXT.ru.cut(2)).toContain('до 2 документов')
    // Every count text reads right at 0, 1, 2, 5, 11, 21 and 22.
    expect(
      [0, 1, 2, 5, 11, 21, 22].map((n) => TEXT.ru.prepared(n, 'x').split(': ')[1]!.split(',')[0]),
    ).toEqual([
      '0 документов',
      '1 документ',
      '2 документа',
      '5 документов',
      '11 документов',
      '21 документ',
      '22 документа',
    ])
    expect(TEXT.ru.loaded(21)).toContain('21 поле')
    expect(TEXT.ru.cut(21)).toContain('до 21 документа')
    expect(TEXT.fr.prepared(0, 'x')).toContain('0 document,')
    expect(TEXT.en.prepared(0, 'x')).toContain('0 documents,')
  })
  it('names the size unit of the app, MB, in every language', () => {
    for (const lang of LANGUAGES) expect(TEXT[lang].cut(5), lang).toContain('1 MB')
  })
  it('reads English for a locale it has no words for', () => {
    expect(pick(TEXT, 'xx')).toBe(TEXT.en)
    expect(shown(TEXT, 'xx')).toBe('en')
    expect(languageOf('xx')).toBe('en')
    for (const lang of LANGUAGES) expect(shown(TEXT, lang)).toBe(lang)
    // A table that really lacks a language reads English.
    const partial = { en: TEXT.en, tr: TEXT.tr }
    expect(pick(partial, 'de')).toBe(TEXT.en)
    expect(shown(partial, 'de')).toBe('en')
    expect(shown(partial, 'tr')).toBe('tr')
  })
})
