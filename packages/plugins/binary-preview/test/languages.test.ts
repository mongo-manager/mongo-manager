// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { fakeClient, flush } from '../../kit/test/fakeClient'
import { langTag, shown } from '../../kit/src/i18n'
import { binaryAnswer, NAMES, sizeText } from '../src/sniff'
import { mount, TEXT } from '../src/view'

/** Languages (2026-10-29): all ten of the app's; an unknown locale reads English. */
const NEW = ['tr', 'zh', 'ja', 'es', 'pt', 'ko', 'de', 'fr', 'ru'] as const
const PLACE = { connectionId: 'c', connectionName: 'Shop', db: 'shop', coll: 'people', documentId: null }

/** The shape of a value: object keys deep, functions as a marker (their parameters are checked by tsc). */
function shape(v: unknown): unknown {
  if (typeof v === 'function') return 'fn'
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.entries(v)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, x]) => [k, shape(x)]),
    )
  return typeof v
}

describe('every language has the same words as English', () => {
  it('has the same keys in the page text', () => {
    for (const l of NEW) expect(shape(TEXT[l]), l).toEqual(shape(TEXT.en))
  })
  it('has the same keys in the kind names', () => {
    for (const l of NEW) expect(shape(NAMES[l]), l).toEqual(shape(NAMES.en))
  })
  it('keeps every interpolated value in the template functions', () => {
    for (const l of NEW) {
      const t = TEXT[l]!
      expect(t.description('people')).toContain('people')
      expect(t.noneHint(7, true)).toContain('7')
      expect(t.more(12)).toContain('12')
      expect(t.shown(3)).toContain('3')
      expect(t.tooLarge(2)).toContain('2')
      expect(t.imageOf('avatar', 'id1')).toContain('avatar')
      expect(t.imageOf('avatar', 'id1')).toContain('id1')
      expect(t.noneHint(7, true)).not.toBe(t.noneHint(7, false))
      expect(t.empty(true)).not.toBe(t.empty(false))
    }
  })
})

describe("a cell says what it holds in the reader's language", () => {
  const png = btoa(
    String.fromCharCode(
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a,
      0,
      0,
      0,
      13,
      73,
      72,
      68,
      82,
      0,
      0,
      1,
      64,
      0,
      0,
      0,
      200,
      8,
    ),
  )
  const head = (base64: string, subType = '00') => ({ $binaryHead: { base64, subType, length: 5 } })
  it('names a PNG', () => {
    expect(binaryAnswer(head(png), 'zh')!.text).toBe('PNG 图片 · 320 × 200 · 5 字节')
    expect(binaryAnswer(head(png), 'ja')!.text).toBe('PNG 画像 · 320 × 200 · 5 バイト')
    expect(binaryAnswer(head(png), 'es')!.text).toBe('Imagen PNG · 320 × 200 · 5 bytes')
    expect(binaryAnswer(head(png), 'pt')!.text).toBe('Imagem PNG · 320 × 200 · 5 bytes')
    expect(binaryAnswer(head(png), 'ko')!.text).toBe('PNG 이미지 · 320 × 200 · 5 바이트')
    expect(binaryAnswer(head(png), 'de')!.text).toBe('PNG-Bild · 320 × 200 · 5 Bytes')
    expect(binaryAnswer(head(png), 'fr')!.text).toBe('Image PNG · 320 × 200 · 5 octets')
    expect(binaryAnswer(head(png), 'ru')!.text).toBe('Изображение PNG · 320 × 200 · 5 байтов')
  })
  it("says an unknown value's subtype", () => {
    const hello = btoa('hello')
    expect(binaryAnswer(head(hello, '80'), 'zh')!.text).toBe('二进制 · 子类型 80 · 5 字节')
    expect(binaryAnswer(head(hello, '80'), 'ja')!.text).toBe('バイナリ · サブタイプ 80 · 5 バイト')
    expect(binaryAnswer(head(hello, '80'), 'es')!.text).toBe('Binario · subtipo 80 · 5 bytes')
    expect(binaryAnswer(head(hello, '80'), 'pt')!.text).toBe('Binário · subtipo 80 · 5 bytes')
    expect(binaryAnswer(head(hello, '80'), 'ko')!.text).toBe('바이너리 · 서브타입 80 · 5 바이트')
    expect(binaryAnswer(head(hello, '80'), 'de')!.text).toBe('Binärdaten · Subtyp 80 · 5 Bytes')
    expect(binaryAnswer(head(hello, '80'), 'fr')!.text).toBe('Binaire · sous-type 80 · 5 octets')
    expect(binaryAnswer(head(hello, '80'), 'ru')!.text).toBe('Двоичные данные · подтип 80 · 5 байтов')
  })
  it("writes sizes with the language's numbers", () => {
    expect(sizeText(1, 'es')).toBe('1 byte')
    expect(sizeText(1, 'pt')).toBe('1 byte')
    expect(sizeText(1.5 * 1024 * 1024, 'es')).toBe('1,5 MB')
    expect(sizeText(1.5 * 1024 * 1024, 'pt')).toBe('1,5 MB')
    expect(sizeText(1.5 * 1024 * 1024, 'zh')).toBe('1.5 MB')
  })
  it('formats sizes with Intl for each language, and writes the byte word in its forms', () => {
    for (const l of [...NEW, 'en'] as const) {
      const tag = l === 'zh' ? 'zh-CN' : l === 'pt' ? 'pt-BR' : l
      const number = new Intl.NumberFormat(tag, { maximumFractionDigits: 1 }).format(1.5)
      expect(sizeText(1.5 * 1024 * 1024, l), l).toBe(`${number} MB`)
    }
    expect(sizeText(1, 'de')).toBe('1 Byte')
    expect(sizeText(0, 'fr')).toBe('0 octet')
    expect(sizeText(1, 'fr')).toBe('1 octet')
    expect(sizeText(2, 'fr')).toBe('2 octets')
    expect(sizeText(1, 'ru')).toBe('1 байт')
    expect(sizeText(3, 'ru')).toBe('3 байта')
    expect(sizeText(11, 'ru')).toBe('11 байтов')
    expect(sizeText(21, 'ru')).toBe('21 байт')
  })
  it('writes Russian byte counts in the right form', () => {
    const word = (n: number) => sizeText(n, 'ru').split(' ')[1]
    for (const n of [1, 21]) expect(word(n), String(n)).toBe('байт')
    for (const n of [2, 22]) expect(word(n), String(n)).toBe('байта')
    for (const n of [0, 5, 11]) expect(word(n), String(n)).toBe('байтов')
  })
  it('reads English for a locale a text table lacks', () => {
    const partial = { en: 'English', tr: 'Türkçe' }
    expect(shown(partial, 'de')).toBe('en')
    expect(shown(partial, 'ru')).toBe('en')
    expect(shown(partial, 'tr')).toBe('tr')
    expect(langTag(shown(partial, 'de'))).toBe('en')
  })
  it('reads English for an unknown locale', () => {
    expect(binaryAnswer(head(png), 'xx')!.text).toBe('PNG image · 320 × 200 · 5 bytes')
    expect(sizeText(1, 'xx')).toBe('1 byte')
    const big = 12345 * 1024 ** 4
    const english = new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(12345)
    expect(english).toContain(',')
    expect(sizeText(big, 'xx')).toBe(`${english} TB`)
    expect(sizeText(big, 'de')).toBe(
      `${new Intl.NumberFormat('de', { maximumFractionDigits: 1 }).format(12345)} TB`,
    )
    expect(sizeText(big, 'de')).not.toBe(sizeText(big, 'xx'))
  })
})

describe('the Images tab speaks each language', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="app"></div>'
  })
  const cases = [
    { locale: 'zh', lang: 'zh-CN', title: '图片', none: '未找到图片' },
    { locale: 'ja', lang: 'ja', title: '画像', none: '画像が見つかりません' },
    { locale: 'es', lang: 'es', title: 'Imágenes', none: 'No se encontró ninguna imagen' },
    { locale: 'pt', lang: 'pt-BR', title: 'Imagens', none: 'Nenhuma imagem encontrada' },
    { locale: 'ko', lang: 'ko', title: '이미지', none: '이미지를 찾을 수 없습니다' },
    { locale: 'de', lang: 'de', title: 'Bilder', none: 'Kein Bild gefunden' },
    { locale: 'fr', lang: 'fr', title: 'Images', none: 'Aucune image trouvée' },
    { locale: 'ru', lang: 'ru', title: 'Изображения', none: 'Изображения не найдены' },
    { locale: 'xx', lang: 'en', title: 'Images', none: 'No image found' },
  ]
  for (const c of cases)
    it(`shows ${c.locale}`, async () => {
      const { client, greet } = fakeClient(
        { place: PLACE, locale: c.locale },
        { 'documents.find': () => ({ documents: [{ _id: { $oid: '0'.repeat(24) }, note: 'x' }] }) },
      )
      mount(document.getElementById('app')!, client)
      greet()
      await flush()
      const app = document.getElementById('app')!
      expect(app.textContent).toContain(c.title)
      expect(app.textContent).toContain(c.none)
      expect(document.documentElement.lang).toBe(c.lang)
    })
})

describe('counts take the right form in each language', () => {
  it('writes the singular for one', () => {
    expect(TEXT.en.shown(1)).toBe('1 image')
    expect(TEXT.de.shown(1)).toBe('1 Bild')
    expect(TEXT.de.shown(2)).toBe('2 Bilder')
    expect(TEXT.fr.shown(0)).toBe('0 image')
    expect(TEXT.fr.shown(1)).toBe('1 image')
    expect(TEXT.fr.shown(2)).toBe('2 images')
    expect(TEXT.ru.shown(1)).toBe('1 изображение')
    expect(TEXT.ru.shown(2)).toBe('2 изображения')
    expect(TEXT.ru.shown(5)).toBe('5 изображений')
    expect(TEXT.ru.shown(21)).toBe('21 изображение')
    expect(TEXT.de.tooLarge(1)).toContain('1 Dokument ist')
    expect(TEXT.de.tooLarge(2)).toContain('2 Dokumente sind')
    expect(TEXT.fr.tooLarge(1)).toContain('1 document est')
    expect(TEXT.fr.tooLarge(2)).toContain('2 documents sont')
    expect(TEXT.ru.tooLarge(1)).toContain('1 документ слишком велик ')
    expect(TEXT.ru.tooLarge(3)).toContain('3 документа')
    expect(TEXT.ru.tooLarge(7)).toContain('7 документов')
    expect(TEXT.de.noneHint(1, false)).toContain('des ersten Dokuments')
    expect(TEXT.fr.noneHint(1, true)).toContain('premier document retenu ')
  })
})
