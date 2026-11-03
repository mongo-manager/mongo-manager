import { describe, expect, it } from 'vitest'
import { LANGUAGES, langTag, pick, shown } from '../../kit/src/ui'
import { TEXT, textFor, wordsLanguage, type Text } from '../src/text'
import { distanceText } from '../src/area'

/** Every key path of a text block; a function counts as one leaf. */
function keys(value: unknown, prefix = ''): string[] {
  if (value && typeof value === 'object')
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
      keys(v, prefix ? `${prefix}.${k}` : k),
    )
  return [`${prefix}:${typeof value}`]
}

describe('the plugin’s words', () => {
  const added = ['tr', 'zh', 'ja', 'es', 'pt', 'ko', 'de', 'fr', 'ru'] as const
  const sorted = (v: unknown) => keys(v).sort()

  it('has every language block with exactly the keys of English', () => {
    for (const lang of added) expect(sorted(TEXT[lang]), lang).toEqual(sorted(TEXT.en))
  })

  it('only holds languages the kit knows', () => {
    for (const lang of Object.keys(TEXT)) expect(LANGUAGES as readonly string[]).toContain(lang)
  })

  it('leaves no string empty and no function answering an empty string', () => {
    for (const lang of added) {
      const t = TEXT[lang]!
      expect(t.description('c').length).toBeGreaterThan(0)
      expect(t.shapes(2, 3, lang).length).toBeGreaterThan(0)
      expect(t.cluster('5')).toContain('5')
      expect(t.inField('Point', 'loc')).toContain('loc')
      expect(t.drawCannot('loc')).toContain('loc')
      expect(t.filtered('loc')).toContain('loc')
      for (const [k, v] of Object.entries(t))
        if (typeof v === 'string') expect(v.length, `${lang}.${k}`).toBeGreaterThan(0)
    }
  })

  it('shows the title and main labels in each new language', () => {
    expect(textFor('zh').title).toBe('地图')
    expect(textFor('zh').fit).toBe('适应形状')
    expect(textFor('ja').title).toBe('マップ')
    expect(textFor('ja').allFields).toBe('すべてのフィールド')
    expect(textFor('es').fit).toBe('Ajustar a las formas')
    expect(textFor('pt').locate).toBe('Mostrar no mapa')
    expect(textFor('ko').title).toBe('지도')
    expect(textFor('ko').fit).toBe('도형에 맞추기')
    expect(textFor('de').title).toBe('Karte')
    expect(textFor('de').fit).toBe('An Formen anpassen')
    expect(textFor('fr').title).toBe('Carte')
    expect(textFor('fr').locate).toBe('Afficher sur la carte')
    expect(textFor('ru').title).toBe('Карта')
    expect(textFor('ru').locate).toBe('Показать на карте')
    expect(textFor('es').shapes(1, 1, 'es')).toBe('1 forma en 1 documento')
    expect(textFor('pt').shapes(2, 3, 'pt')).toBe('3 formas em 2 documentos')
    expect(textFor('zh').shapes(2, 3, 'zh')).toBe('2 个文档中有 3 个形状')
  })

  it('reads English for an unknown locale', () => {
    expect(textFor('xx')).toBe(TEXT.en)
    expect(textFor('')).toBe(TEXT.en)
    expect(textFor('ko')).toBe(TEXT.ko)
    expect(textFor('ko')).not.toBe(TEXT.en)
  })

  it('falls back to English, and to English numbers, for a language a table lacks', () => {
    const partial = { en: TEXT.en, tr: TEXT.tr }
    const language = shown(partial, 'ko')
    expect(language).toBe('en')
    const text = pick<Text>(partial, 'ko')
    expect(text).toBe(TEXT.en)
    expect(text.shapes(1234, 12_345, language)).toBe('12,345 shapes in 1,234 documents')
    expect(text.moreRows(12_345)).toBe('+12,345 more')
    expect(pick<Text>(partial, 'tr')).toBe(TEXT.tr)
    expect(shown(partial, 'tr')).toBe('tr')
  })

  it('tags the page and formats distances by language', () => {
    expect(langTag('zh')).toBe('zh-CN')
    expect(langTag('pt')).toBe('pt-BR')
    expect(distanceText(12_345, 'es')).toBe(
      `${new Intl.NumberFormat('es', { maximumFractionDigits: 1 }).format(12.345)} km`,
    )
    expect(distanceText(850, 'xx')).toBe('850 m')
    expect(wordsLanguage('xx')).toBe('en')
    expect(wordsLanguage('ru')).toBe('ru')
    expect(langTag(wordsLanguage('xx'))).toBe('en')
  })

  it('gives every language its singular and plural counts', () => {
    const cases: Record<string, [number, string][]> = {
      en: [
        [0, '0 shapes in 0 documents'],
        [1, '1 shape in 1 document'],
        [2, '2 shapes in 2 documents'],
        [11, '11 shapes in 11 documents'],
      ],
      de: [
        [0, '0 Formen in 0 Dokumenten'],
        [1, '1 Form in 1 Dokument'],
        [2, '2 Formen in 2 Dokumenten'],
      ],
      es: [
        [0, '0 formas en 0 documentos'],
        [1, '1 forma en 1 documento'],
        [2, '2 formas en 2 documentos'],
      ],
      pt: [
        [1, '1 forma em 1 documento'],
        [2, '2 formas em 2 documentos'],
        [11, '11 formas em 11 documentos'],
      ],
      fr: [
        [0, '0 forme dans 0 document'],
        [1, '1 forme dans 1 document'],
        [2, '2 formes dans 2 documents'],
        [11, '11 formes dans 11 documents'],
      ],
      ru: [
        [0, '0 фигур в 0 документах'],
        [1, '1 фигура в 1 документе'],
        [2, '2 фигуры в 2 документах'],
        [5, '5 фигур в 5 документах'],
        [11, '11 фигур в 11 документах'],
        [21, '21 фигура в 21 документе'],
        [22, '22 фигуры в 22 документах'],
      ],
    }
    for (const [lang, rows] of Object.entries(cases))
      for (const [n, expected] of rows)
        expect(textFor(lang).shapes(n, n, lang), `${lang} ${n}`).toBe(expected)
    expect(textFor('ru').shapes(5, 11, 'ru')).toBe('11 фигур в 5 документах')
    expect(textFor('en').here(1)).toBe('1 place at this spot')
    expect(textFor('en').here(2)).toBe('2 places at this spot')
    expect(textFor('de').here(1)).toBe('1 Ort an dieser Stelle')
    expect(textFor('de').here(2)).toBe('2 Orte an dieser Stelle')
    expect(textFor('es').here(1)).toBe('1 lugar en este punto')
    expect(textFor('es').here(5)).toBe('5 lugares en este punto')
    expect(textFor('pt').here(1)).toBe('1 lugar neste ponto')
    expect(textFor('pt').here(2)).toBe('2 lugares neste ponto')
    expect(textFor('fr').here(0)).toBe('0 lieu à cet endroit')
    expect(textFor('fr').here(2)).toBe('2 lieux à cet endroit')
    for (const [n, word] of [
      [1, 'место'],
      [2, 'места'],
      [5, 'мест'],
      [11, 'мест'],
      [21, 'место'],
      [22, 'места'],
    ] as const)
      expect(textFor('ru').here(n), String(n)).toBe(`В этой точке: ${n} ${word}`)
    for (const [n, word] of [
      [1, 'документа'],
      [2, 'документов'],
      [11, 'документов'],
      [21, 'документа'],
    ] as const)
      expect(textFor('ru').more(n), String(n)).toBe(`из первых ${n} ${word}`)
    for (const [n, word] of [
      [1, 'документе'],
      [2, 'документах'],
      [21, 'документе'],
      [22, 'документах'],
    ] as const)
      expect(textFor('ru').noneHint(n), String(n)).toContain(`в ${n} ${word}.`)
    for (const [n, word] of [
      [1, 'фигуры'],
      [2, 'фигур'],
      [21, 'фигуры'],
      [22, 'фигур'],
    ] as const)
      expect(textFor('ru').firstRows(1, n), String(n)).toBe(`Показано 1 из ${n} ${word}.`)
    expect(textFor('en').firstRows(1, 1)).toBe('The first 1 of 1 shape.')
    expect(textFor('de').firstRows(1, 2)).toBe('1 von 2 Formen angezeigt.')
    expect(textFor('fr').noneHint(0)).toContain('0 document.')
    expect(textFor('fr').noneHint(2)).toContain('2 documents.')
    expect(textFor('en').noneHint(1)).toContain('1 document.')
    expect(textFor('en').noneHint(1500)).toContain('1,500 documents.')
  })
})
