// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import type { Accent, PluginClient, PluginContext } from '../../kit/src/client'
import { AskError } from '../../kit/src/client'
import { pick, shown } from '../../kit/src/ui'
import { TEXT, mount, type Text } from '../src/view'
import { HEAD, uuidAnswer } from '../src/renderer'
import { parseUuid, stored } from '../src/uuid'
import { answerOf, apiLog } from '../../kit/test/fakeClient'

const LANGS = ['tr', 'zh', 'ja', 'es', 'pt', 'ko', 'de', 'fr', 'ru'] as const
const T: Record<'en' | (typeof LANGS)[number], Text> = TEXT
const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0))
}

type Params = { pipeline?: unknown[]; filter?: unknown; text?: string }
type Handler = (params: Params) => unknown

function fakeClient(place: PluginContext['place'], handlers: Record<string, Handler>) {
  const calls: Array<{ method: string; params: Params }> = []
  let ready: (() => void) | null = null
  const contexts: Array<(l: string, t: 'light' | 'dark', a: Accent) => void> = []
  const client: PluginClient = {
    contribution: { kind: 'collectionTab', id: 'uuids' },
    ask: async <T>(method: string, params?: unknown) => {
      calls.push({ method, params: params as Params })
      if (method === 'context.get')
        return {
          plugin: { id: 'legacy-uuid', version: '1' },
          contribution: { kind: 'collectionTab', id: 'uuids' },
          locale: 'en',
          theme: 'light',
          accent: 'violet',
          place,
          settings: {},
        } as T
      return (await handlers[method]!(params as Params)) as T
    },
    onReady: (fn) => (ready = fn),
    onContext: (fn) => contexts.push(fn),
    onCells: () => {},
  }
  return { client, calls, greet: () => ready!(), contexts }
}

const PLACE = { connectionId: 'c', connectionName: 'Shop', db: 'shop', coll: 'orders', documentId: null }
const UUID = '00112233-4455-6677-8899-aabbccddeeff'
const A = parseUuid('3b241101-e2bb-4255-8caf-4136c566a962')!
const B = parseUuid('9f4c2a7e-1d3b-4f6a-b0c8-2e5d7a9b1c3f')!
const DOCS = [
  { _id: { $numberInt: '1' }, customerId: stored(A, 'java'), ref: stored(A, 'standard') },
  { _id: { $numberInt: '2' }, customerId: stored(B, 'java') },
]

const app = () => document.getElementById('app')!
const input = (id: string) => document.getElementById(id) as HTMLInputElement
const type = (id: string, value: string) => {
  input(id).value = value
  input(id).dispatchEvent(new Event('input'))
}

beforeEach(() => {
  document.body.replaceChildren(Object.assign(document.createElement('div'), { id: 'app' }))
})

describe('a legacy UUID cell', () => {
  it('says the UUID in each driver’s order, and nothing for other binary values', () => {
    const head = { $binaryHead: { base64: 'd2ZVRDMiEQD/7t3Mu6qZiA==', subType: '03', length: 16 } }
    expect(uuidAnswer(head, 'en')).toEqual({
      text: `Legacy UUID · Java ${UUID} · C# 44556677-2233-0011-ffee-ddccbbaa9988 · Python 77665544-3322-1100-ffee-ddccbbaa9988`,
      tone: 'info',
    })
    expect(uuidAnswer(head, 'tr')!.text.startsWith('Eski UUID · Java')).toBe(true)
    // The app shows a tooltip's 200 characters: all three readings fit.
    expect(uuidAnswer(head, 'en')!.text.length).toBeLessThanOrEqual(200)
    expect(uuidAnswer({ $binaryHead: { base64: 'AAAA', subType: '00', length: 3 } }, 'en')).toBeNull()
    // A standard UUID is shown by the app as one already.
    expect(
      uuidAnswer({ $binaryHead: { base64: 'ABEiM0RVZneImaq7zN3u/w==', subType: '04', length: 16 } }, 'en'),
    ).toBeNull()
    expect(
      uuidAnswer({ $binaryHead: { base64: 'd2ZVRDMiEQD/7t3Mu6qZiA==', subType: '03', length: 40 } }, 'en'),
    ).toBeNull()
  })
})

describe('the words of a count', () => {
  it('has a singular for one, in every language', () => {
    const one = Object.fromEntries((['en', ...LANGS] as const).map((l) => [l, T[l].sampled('1', 1)]))
    const many = Object.fromEntries((['en', ...LANGS] as const).map((l) => [l, T[l].sampled('3', 3)]))
    expect(one.en).toBe('1 document sampled')
    expect(one.es).toBe('1 documento en la muestra')
    expect(one.pt).toBe('1 documento na amostra')
    expect(one.de).toBe('1 Dokument in der Stichprobe')
    expect(one.fr).toBe('1 document échantillonné')
    expect(one.ru).toBe('1 документ в выборке')
    expect(many.ru).toBe('3 документа в выборке')
    for (const l of ['en', 'es', 'pt', 'de'] as const) expect(one[l], l).not.toBe(many[l]!.replace('3', '1'))
    expect(T.en.noneHint('1', 1)).not.toMatch(/None of the/)
    expect(T.es.noneHint('1', 1)).not.toMatch(/Ninguno de los/)
    expect(T.pt.noneHint('1', 1)).not.toMatch(/Nenhum dos/)
    expect(T.tr.noneHint('1', 1)).not.toMatch(/hiçbiri/)
    expect(T.en.counts('1', '1', 1, 1)).toBe('1 legacy · 1 standard')
    expect(T.es.counts('1', '2', 1, 2)).toBe('1 heredado · 2 estándar')
    expect(T.es.counts('2', '0', 2, 0)).toBe('2 heredados')
    expect(T.pt.counts('1', '0', 1, 0)).toBe('1 legado')
    expect(T.fr.counts('0', '0', 0, 0)).toBe('')
    expect(T.fr.counts('1', '1', 1, 1)).toBe('1 hérité · 1 standard')
    expect(T.fr.counts('2', '1', 2, 1)).toBe('2 hérités · 1 standard')
    expect(T.fr.sampled('0', 0)).toBe('0 document échantillonné')
  })

  it('has the three Russian forms', () => {
    const said = (n: number) => T.ru.sampled(String(n), n)
    expect([1, 21, 101].map(said)).toEqual([
      '1 документ в выборке',
      '21 документ в выборке',
      '101 документ в выборке',
    ])
    expect([2, 4, 22, 104].map(said).every((t) => t.includes(' документа '))).toBe(true)
    expect([0, 5, 11, 12, 14, 20, 25, 111].map(said).every((t) => t.includes(' документов '))).toBe(true)
    expect(T.ru.counts('1', '3', 1, 3)).toBe('1 устаревший · 3 стандартных')
    expect(T.ru.counts('21', '2', 21, 2)).toBe('21 устаревший · 2 стандартных')
    expect(T.ru.noneHint('1', 1)).toContain('из 1 документа')
    expect(T.ru.noneHint('5', 5)).toContain('из 5 документов')
  })
})

describe('the UUIDs tab', () => {
  it('lists the UUID fields of a sample, naming the order legacy ones were written in', async () => {
    const { client, greet, calls } = fakeClient(PLACE, { 'documents.aggregate': () => ({ documents: DOCS }) })
    mount(app(), client)
    greet()
    await flush()
    expect(calls.find((c) => c.method === 'documents.aggregate')!.params.pipeline).toEqual([
      { $sample: { size: { $numberInt: '1000' } } },
    ])
    const cards = [...document.querySelectorAll<HTMLElement>('[data-field]')]
    expect(cards.map((c) => c.dataset.field)).toEqual(['customerId', 'ref'])
    expect(cards[0]!.textContent).toContain('2 legacy')
    expect(cards[0]!.textContent).toContain('Stored in Java’s order')
    expect(cards[1]!.textContent).toContain('1 standard')
    expect(document.getElementById('status')!.textContent).toBe('2 documents sampled')
  })

  // User report 2026-11-07: API logs of ~60 KB a document — a sample of 1,000 is far over the 1 MB one
  // answer may be, and the scan failed.
  it('lists the UUID fields of a collection of documents too large for one answer', async () => {
    const logs = Array.from({ length: 1000 }, (_, i) => ({ ...apiLog(i), customerId: stored(A, 'java') }))
    const { client, greet, calls } = fakeClient(PLACE, {
      'documents.aggregate': (p) => answerOf(logs, p as Record<string, unknown>, 'aggregate'),
    })
    mount(app(), client)
    greet()
    await flush()
    expect(document.getElementById('status')!.textContent).toMatch(/^1\d documents sampled$/)
    expect([...document.querySelectorAll<HTMLElement>('[data-field]')].map((c) => c.dataset.field)).toEqual([
      'customerId',
    ])
    expect(calls.find((c) => c.method === 'documents.aggregate')!.params).toMatchObject({ fit: true })
  })

  it('writes a UUID as each driver stored it, and shows its documents in Documents', async () => {
    const { client, greet, calls } = fakeClient(PLACE, {
      'documents.aggregate': () => ({ documents: [] }),
      'ui.useQuery': () => true,
      'ui.copy': () => true,
    })
    mount(app(), client)
    greet()
    await flush()
    const show = document.getElementById('show') as HTMLButtonElement
    expect(show.disabled).toBe(true)
    type('uuid', `{${UUID.toUpperCase()}}`)
    expect(document.getElementById('find-hint')!.textContent).toBe('Name the field to look in.')
    // A UUID alone says where to look in nowhere: nothing to show yet.
    expect(show.disabled).toBe(true)
    type('field', 'customerId')
    expect(show.disabled).toBe(false)
    const rows = [...document.querySelectorAll<HTMLElement>('#stored [data-encoding]')]
    expect(rows.map((r) => r.querySelector('code')!.textContent)).toEqual([
      `UUID("${UUID}")`,
      'BinData(3, "d2ZVRDMiEQD/7t3Mu6qZiA==")',
      'BinData(3, "MyIRAFVEd2aImaq7zN3u/w==")',
      'BinData(3, "ABEiM0RVZneImaq7zN3u/w==")',
    ])
    const choice = document.getElementById('stored-as') as HTMLSelectElement
    choice.value = 'csharp'
    choice.dispatchEvent(new Event('change'))
    show.click()
    rows[1]!.querySelector<HTMLButtonElement>('button')!.click()
    await flush()
    expect(calls.find((c) => c.method === 'ui.useQuery')!.params.filter).toEqual({
      customerId: { $binary: { base64: 'MyIRAFVEd2aImaq7zN3u/w==', subType: '03' } },
    })
    expect(calls.find((c) => c.method === 'ui.copy')!.params.text).toBe(
      'BinData(3, "d2ZVRDMiEQD/7t3Mu6qZiA==")',
    )
    // Each copy button says which value it copies.
    expect(rows.map((r) => r.querySelector('button')!.getAttribute('aria-label'))).toEqual([
      'Copy the Standard value',
      'Copy the Java value',
      'Copy the C# value',
      'Copy the Python value',
    ])
    expect(rows[0]!.querySelector('button')!.title).toBe('Copy the standard value, as the shell writes it')
    expect(rows[1]!.querySelector('button')!.title).toBe(
      'Copy the value as the Java driver stored it, as the shell writes it',
    )
  })

  it('says a text is no UUID, and finds nothing for it', async () => {
    const { client, greet } = fakeClient(PLACE, { 'documents.aggregate': () => ({ documents: [] }) })
    mount(app(), client)
    greet()
    await flush()
    type('uuid', 'not-a-uuid')
    type('field', 'a')
    expect(document.getElementById('find-hint')!.textContent).toMatch(/Not a UUID/)
    expect((document.getElementById('show') as HTMLButtonElement).disabled).toBe(true)
    expect(input('uuid').getAttribute('aria-invalid')).toBe('true')
  })

  it('fills the finder from a field of the sample, with the order it was written in', async () => {
    const { client, greet } = fakeClient(PLACE, {
      'documents.aggregate': () => ({ documents: [...DOCS, { other: stored(B, 'standard') }] }),
    })
    mount(app(), client)
    greet()
    await flush()
    const card = document.querySelector<HTMLElement>('[data-field="customerId"]')!
    ;[...card.querySelectorAll('button')].find((b) => b.textContent === 'Find in this field')!.click()
    expect(input('field').value).toBe('customerId')
    expect((document.getElementById('stored-as') as HTMLSelectElement).value).toBe('java')
  })

  it('takes the one field of UUIDs a sample has as the one to look in', async () => {
    const { client, greet } = fakeClient(PLACE, {
      'documents.aggregate': () => ({ documents: [{ ref: stored(A, 'standard') }] }),
    })
    mount(app(), client)
    greet()
    await flush()
    expect(input('field').value).toBe('ref')
    expect((document.getElementById('stored-as') as HTMLSelectElement).value).toBe('standard')
  })

  it('says when the sample holds no UUID, the collection is empty, or the read failed', async () => {
    let answer: () => unknown = () => ({ documents: [{ a: 1 }] })
    const { client, greet } = fakeClient(PLACE, { 'documents.aggregate': () => answer() })
    mount(app(), client)
    greet()
    await flush()
    expect(app().textContent).toContain('No UUIDs in the sample')
    answer = () => ({ documents: [] })
    document.getElementById('scan')!.click()
    await flush()
    expect(app().textContent).toContain('No documents to sample')
    answer = () => {
      throw new AskError('failed', 'MongoDB is not available')
    }
    document.getElementById('scan')!.click()
    await flush()
    expect(app().textContent).toContain('The sample could not be read')
    expect(app().textContent).toContain('MongoDB is not available')
  })

  it('says it in Turkish', async () => {
    const { client, greet, contexts } = fakeClient(PLACE, {
      'documents.aggregate': () => ({ documents: DOCS }),
    })
    mount(app(), client)
    greet()
    await flush()
    for (const fn of contexts) fn('tr', 'light', 'violet')
    expect(document.querySelector('[data-field="customerId"]')!.textContent).toContain(
      'Java sırasıyla saklanmış',
    )
    expect(document.getElementById('status')!.textContent).toBe('2 belgeden örnek alındı')
  })

  it.each([
    ['zh', '按 Java 的顺序存储', '已采样 2 个文档', 'zh-CN'],
    ['ja', 'Java の順序で保存', '2 件のドキュメントをサンプリングしました', 'ja'],
    ['es', 'Almacenado en el orden de Java', '2 documentos en la muestra', 'es'],
    ['pt', 'Armazenado na ordem de Java', '2 documentos na amostra', 'pt-BR'],
    ['ko', 'Java 순서로 저장됨', '도큐먼트 2개를 샘플링했습니다', 'ko'],
    ['de', 'Gespeichert in der Reihenfolge von Java', '2 Dokumente in der Stichprobe', 'de'],
    ['fr', 'Stocké dans l’ordre de Java', '2 documents échantillonnés', 'fr'],
    ['ru', 'Хранится в порядке Java', '2 документа в выборке', 'ru'],
  ])('says it in %s', async (lang, verdict, sampled, tag) => {
    const { client, greet, contexts } = fakeClient(PLACE, {
      'documents.aggregate': () => ({ documents: DOCS }),
    })
    mount(app(), client)
    greet()
    await flush()
    for (const fn of contexts) fn(lang, 'light', 'violet')
    expect(document.querySelector('[data-field="customerId"]')!.textContent).toContain(verdict)
    expect(document.getElementById('status')!.textContent).toBe(sampled)
    expect(document.documentElement.lang).toBe(tag)
  })

  it('reads English for a language it has no words in', async () => {
    const { client, greet, contexts } = fakeClient(PLACE, {
      'documents.aggregate': () => ({ documents: DOCS }),
    })
    mount(app(), client)
    greet()
    await flush()
    for (const fn of contexts) fn('xx', 'light', 'violet')
    expect(document.getElementById('status')!.textContent).toBe('2 documents sampled')
    expect(document.documentElement.lang).toBe('en')
    expect(
      uuidAnswer({ $binaryHead: { base64: 'd2ZVRDMiEQD/7t3Mu6qZiA==', subType: '03', length: 16 } }, 'xx')!
        .text,
    ).toMatch(/^Legacy UUID · Java/)
  })

  it('falls back to English from a table that lacks the language', () => {
    const partial = { en: TEXT.en, tr: TEXT.tr }
    expect(shown(partial, 'xx')).toBe('en')
    expect(shown(partial, 'ru')).toBe('en')
    expect(pick<Text>(partial, 'ru').sampled('12,345', 12345)).toBe('12,345 documents sampled')
    expect(pick<Text>(partial, 'tr').sampled('12.345', 12345)).toBe(TEXT.tr.sampled('12.345'))
  })

  it('formats the count in English for a language it has no words in', async () => {
    const docs = Array.from({ length: 12345 }, (_, i) => ({
      _id: { $numberInt: String(i) },
      ref: stored(A, 'java'),
    }))
    const { client, greet, contexts } = fakeClient(PLACE, {
      'documents.aggregate': () => ({ documents: docs }),
    })
    mount(app(), client)
    greet()
    await flush()
    for (const fn of contexts) fn('xx', 'light', 'violet')
    expect(document.getElementById('status')!.textContent).toBe(
      `${new Intl.NumberFormat('en').format(12345)} documents sampled`,
    )
  })

  it('reads every count right in the language plural categories', () => {
    const ru = (n: number) => TEXT.ru.sampled(String(n), n)
    expect(ru(1)).toBe('1 документ в выборке')
    expect(ru(2)).toBe('2 документа в выборке')
    expect(ru(5)).toBe('5 документов в выборке')
    expect(ru(11)).toBe('11 документов в выборке')
    expect(ru(21)).toBe('21 документ в выборке')
    expect(ru(22)).toBe('22 документа в выборке')
    expect(TEXT.ru.counts('21', '2', 21, 2)).toBe('21 устаревший · 2 стандартных')
    expect(TEXT.fr.sampled('0', 0)).toBe('0 document échantillonné')
    expect(TEXT.fr.sampled('2', 2)).toBe('2 documents échantillonnés')
    expect(TEXT.fr.counts('0', '3', 0)).toBe('3 standard')
    expect(TEXT.fr.counts('1', '0', 1)).toBe('1 hérité')
    expect(TEXT.es.counts('2', '0', 2)).toBe('2 heredados')
    expect(TEXT.pt.counts('1', '0', 1)).toBe('1 legado')
    expect(TEXT.en.sampled('1', 1)).toBe('1 document sampled')
    expect(TEXT.en.sampled('0', 0)).toBe('0 documents sampled')
  })

  it('keeps the same keys in every language', () => {
    const shape = (v: unknown): unknown =>
      typeof v === 'function'
        ? 'fn'
        : v && typeof v === 'object'
          ? Object.fromEntries(
              Object.keys(v)
                .sort()
                .map((k) => [k, shape((v as Record<string, unknown>)[k])]),
            )
          : 'text'
    for (const lang of LANGS) expect(shape(TEXT[lang]), lang).toEqual(shape(TEXT.en))
    expect(Object.keys(HEAD).sort()).toEqual([...LANGS, 'en'].sort())
    for (const lang of LANGS) {
      expect(TEXT[lang].title, lang).not.toBe('')
      expect(TEXT[lang].find, lang).not.toBe(TEXT.en.find)
    }
  })

  it('answers a cell in the new languages', () => {
    const head = { $binaryHead: { base64: 'd2ZVRDMiEQD/7t3Mu6qZiA==', subType: '03', length: 16 } }
    expect(uuidAnswer(head, 'ko')!.text.startsWith('레거시 UUID · Java')).toBe(true)
    expect(uuidAnswer(head, 'de')!.text.startsWith('Legacy-UUID · Java')).toBe(true)
    expect(uuidAnswer(head, 'fr')!.text.startsWith('UUID hérité · Java')).toBe(true)
    expect(uuidAnswer(head, 'ru')!.text.startsWith('Устаревший UUID · Java')).toBe(true)
  })

  it('needs a collection', async () => {
    const { client, greet } = fakeClient(null, {})
    mount(app(), client)
    greet()
    await flush()
    expect(app().textContent).toContain('Open a collection to look at its UUIDs.')
    expect((document.getElementById('scan') as HTMLButtonElement).disabled).toBe(true)
  })
})
