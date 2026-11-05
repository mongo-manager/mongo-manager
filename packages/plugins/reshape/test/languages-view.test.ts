// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { fakeClient, flush } from '../../kit/test/fakeClient'
import { pick, shown } from '../../kit/src/ui'
import { TEXT, mount } from '../src/view'

/** Every language of the app: the tab speaks it, with the same entries as English. */
const PLACE = {
  connectionId: 'c',
  connectionName: 'Shop',
  db: 'shop',
  coll: 'people',
  documentId: null,
  hidden: [] as string[][],
}
const PEOPLE = [{ _id: { $oid: '65a1b2c3d4e5f60718293a01' }, fullName: 'Ada' }]

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>'
})
const app = () => document.getElementById('app')!

async function opened(locale: string) {
  const fake = fakeClient(
    { place: PLACE, locale },
    { 'documents.find': () => ({ documents: PEOPLE }), 'documents.aggregate': () => ({ documents: PEOPLE }) },
  )
  mount(app(), fake.client)
  fake.greet()
  await flush()
}

/** The keys of a value, deep for objects; a function counts as a leaf. */
function shapeOf(v: unknown): unknown {
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, x]) => [k, shapeOf(x)]),
    )
  }
  return typeof v === 'function' ? 'function' : 'string'
}

const BLOCKS: Record<string, typeof TEXT.en> = TEXT

describe('languages', () => {
  const cases: Array<[string, string, string]> = [
    ['zh', '重塑', 'zh-CN'],
    ['ja', 'リシェイプ', 'ja'],
    ['es', 'Remodelar', 'es'],
    ['pt', 'Remodelar', 'pt-BR'],
    ['tr', 'Yeniden şekillendir', 'tr'],
    ['ko', '재구성', 'ko'],
    ['de', 'Umformen', 'de'],
    ['fr', 'Remodeler', 'fr'],
    ['ru', 'Реструктуризация', 'ru'],
  ]
  for (const [locale, title, lang] of cases) {
    it(`shows its title and labels in ${locale}`, async () => {
      await opened(locale)
      expect(app().querySelector('h1')!.textContent).toContain(title)
      expect(app().textContent).toContain(BLOCKS[locale]!.steps)
      expect(app().textContent).toContain(BLOCKS[locale]!.none)
      expect(document.documentElement.lang).toBe(lang)
    })
  }

  it('every language has exactly the keys of English', () => {
    for (const [lang, block] of Object.entries(TEXT)) {
      expect(shapeOf(block), lang).toEqual(shapeOf(TEXT.en))
    }
  })

  it('functions give text in every language', () => {
    for (const [lang, block] of Object.entries(TEXT)) {
      const b: typeof TEXT.en = block
      for (const s of [
        b.description('c'),
        b.remove(2, 'k'),
        b.picked(1, 2),
        b.clash('x'),
        b.each('x'),
        b.leftOut(1),
        b.leftOut(3),
        b.incomplete(1),
        b.incomplete(3),
        b.tooMany(60),
      ]) {
        expect(s.length, lang).toBeGreaterThan(0)
      }
    }
  })

  it('says only what each of the new languages says', async () => {
    const expected: Array<[string, string]> = [
      ['ko', '단계 추가'],
      ['de', 'Schritt hinzufügen'],
      ['fr', 'Ajouter une opération'],
      ['ru', 'Добавить шаг'],
    ]
    for (const [locale, add] of expected) {
      document.body.innerHTML = '<div id="app"></div>'
      await opened(locale)
      expect(app().textContent, locale).toContain(add)
      expect(app().textContent, locale).not.toContain('Add step')
    }
  })

  it('gives every language its singular for one step', () => {
    expect(TEXT.en.leftOut(1)).toContain('1 step ')
    expect(TEXT.de.leftOut(1)).toContain('1 Schritt ')
    expect(TEXT.de.incomplete(1)).toContain('1 Schritt ')
    expect(TEXT.de.incomplete(2)).toContain('2 Schritte')
    expect(TEXT.fr.leftOut(0)).toContain('0 opération avec')
    expect(TEXT.fr.leftOut(1)).toContain('1 opération avec')
    expect(TEXT.fr.leftOut(2)).toContain('2 opérations')
    expect(TEXT.fr.incomplete(0)).toContain('0 opération n’est')
    expect(TEXT.fr.incomplete(3)).toContain('3 opérations')
    expect(TEXT.es.leftOut(1)).toContain('1 paso')
    expect(TEXT.pt.incomplete(1)).toContain('1 etapa')
  })

  it('gives Russian its three plural forms', () => {
    const forms = (n: number) => TEXT.ru.incomplete(n)
    for (const n of [1, 21, 101]) expect(forms(n), String(n)).toContain(`${n} шаг еще`)
    for (const n of [2, 3, 4, 22, 24]) expect(forms(n), String(n)).toContain(`${n} шага еще`)
    for (const n of [0, 5, 11, 12, 14, 20, 25, 111]) expect(forms(n), String(n)).toContain(`${n} шагов еще`)
    expect(TEXT.ru.leftOut(1)).toContain('1 шаг с проблемой')
    expect(TEXT.ru.leftOut(3)).toContain('3 шага с проблемой')
    expect(TEXT.ru.leftOut(7)).toContain('7 шагов с проблемой')
    expect(TEXT.ru.tooMany(51)).toContain('51 стадию')
    expect(TEXT.ru.tooMany(52)).toContain('52 стадии')
    expect(TEXT.ru.tooMany(60)).toContain('60 стадий')
  })

  it('a language the table lacks falls back to English', () => {
    const partial = { en: TEXT.en, tr: TEXT.tr }
    expect(pick(partial, 'ja')).toBe(TEXT.en)
    expect(shown(partial, 'ja')).toBe('en')
    expect(pick(partial, 'tr')).toBe(TEXT.tr)
  })

  it('French and Russian counts follow the plural rules for 0, 1, 2, 5, 11, 21, 22', () => {
    expect(TEXT.fr.incomplete(0)).toContain('0 opération n’est')
    expect(TEXT.fr.incomplete(1)).toContain('1 opération n’est')
    expect(TEXT.fr.incomplete(2)).toContain('2 opérations ne')
    for (const [n, form] of [
      [21, 'шаг'],
      [22, 'шага'],
      [11, 'шагов'],
      [5, 'шагов'],
      [2, 'шага'],
      [0, 'шагов'],
    ] as const)
      expect(TEXT.ru.incomplete(n), String(n)).toContain(`${n} ${form} еще`)
  })

  it('an unknown locale falls back to English', async () => {
    await opened('xx')
    expect(app().querySelector('h1')!.textContent).toContain('Reshape')
    expect(document.documentElement.lang).toBe('en')
    expect(app().textContent).toContain(TEXT.en.add)
  })
})
