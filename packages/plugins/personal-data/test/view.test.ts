// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import type { Accent, PluginClient, PluginContext } from '../../kit/src/client'
import { AskError } from '../../kit/src/client'
import { formatNumber, langTag, pick, shown } from '../../kit/src/ui'
import { MAX_SUGGEST, mount, SAMPLE, TEXT } from '../src/view'

const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0))
}
type Params = {
  pipeline?: Array<Record<string, { size: number }>>
  limit?: number
  fields?: string[]
  text?: string
}
type Handler = (params: Params) => unknown

function fakeClient(place: PluginContext['place'], handlers: Record<string, Handler>) {
  const calls: Array<{ method: string; params: Params }> = []
  let ready: (() => void) | null = null
  const contexts: Array<(l: string, t: 'light' | 'dark', a: Accent) => void> = []
  const client: PluginClient = {
    contribution: { kind: 'collectionTab', id: 'find' },
    ask: async <T>(method: string, params?: unknown) => {
      calls.push({ method, params: params as Params })
      if (method === 'context.get')
        return {
          plugin: { id: 'personal-data', version: '1' },
          contribution: { kind: 'collectionTab', id: 'find' },
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

const PLACE = {
  connectionId: 'c',
  connectionName: 'Shop',
  db: 'crm',
  coll: 'users',
  documentId: null,
  hidden: [] as string[][],
}
/** Ten customers: an e-mail and a phone each, a name, a token, a note that is none of these. */
const USERS = Array.from({ length: 10 }, (_, i) => ({
  _id: i,
  email: `user${i}@example.com`,
  phone: '+90 532 123 45 67',
  firstName: 'Ada',
  apiToken: 'tok_abcdef',
  note: 'likes tea',
  ref: i < 3 ? '+90 532 123 45 67' : 'x',
  'a.b': 'user@example.com',
}))
const sampling = (documents: unknown[]) => ({ 'documents.aggregate': () => ({ documents }) })
const app = () => document.getElementById('app')!
const rows = () => [...document.querySelectorAll<HTMLTableRowElement>('[data-finding]')]
const row = (field: string) => document.querySelector<HTMLTableRowElement>(`[data-finding="${field}"]`)!
const box = (field: string) => row(field).querySelector<HTMLInputElement>('input[type="checkbox"]')!
const notes = () => document.getElementById('notes')!.textContent!
const click = (id: string) => document.getElementById(id)!.click()

beforeEach(() => {
  document.body.replaceChildren(Object.assign(document.createElement('div'), { id: 'app' }))
})

async function mounted(handlers: Record<string, Handler>, place: PluginContext['place'] = PLACE) {
  const f = fakeClient(place, { 'ui.suggestPersonalData': () => true, 'ui.copy': () => true, ...handlers })
  mount(app(), f.client)
  f.greet()
  await flush()
  return f
}

describe('the Find personal data tab', () => {
  it('samples random documents on opening and lists what holds personal data, masked, the likely ones chosen', async () => {
    const { calls } = await mounted(sampling(USERS))
    const read = calls.find((c) => c.method === 'documents.aggregate')!
    expect(read.params).toEqual({ pipeline: [{ $sample: { size: SAMPLE } }], limit: SAMPLE })
    expect(rows().map((r) => r.dataset.finding)).toEqual([
      'email',
      'phone',
      'apiToken',
      'a.b',
      'firstName',
      'ref',
    ])
    expect(row('email').textContent).toContain('E-mail address')
    expect(row('email').textContent).toContain('High')
    expect(row('email').textContent).toContain('10 of 10 values; its name says so')
    expect(row('email').textContent).toContain('u•••@e•••.com')
    expect(row('firstName').textContent).toContain('Its name says so')
    expect(row('ref').textContent).toContain('Low')
    expect(document.getElementById('status')!.textContent).toBe(
      '6 fields look like personal data in 10 documents',
    )
    // High and medium chosen; low not; a key no rule can name never.
    expect(rows().map((r) => box(r.dataset.finding!).checked)).toEqual([true, true, true, false, true, false])
    expect(box('a.b').disabled).toBe(true)
    expect(box('a.b').title).toContain('No rule can name this field')
    // Said on the page too, not only in a title.
    expect(row('a.b').textContent).toContain('No rule can name this field')
    // A token: a word on how to keep it.
    expect(notes()).toContain('Passwords belong hashed, and keys in a secrets store, never as they are')
    // No value is on the page but masked.
    for (const raw of ['user1@example.com', '532 123 45 67', 'Ada', 'tok_abcdef', 'likes tea'])
      expect(app().textContent, raw).not.toContain(raw)
    expect(app().textContent).toContain('none is shown but masked')
  })

  it('suggests the fields chosen as rules, and says when only an administrator may add them', async () => {
    const { calls } = await mounted(sampling(USERS))
    box('apiToken').click()
    box('ref').click()
    click('suggest')
    await flush()
    expect(calls.find((c) => c.method === 'ui.suggestPersonalData')!.params).toEqual({
      fields: ['email', 'phone', 'firstName', 'ref'],
    })
    expect(notes()).toContain('The Personal data section lists 4 fields to add')
    document.body.replaceChildren(Object.assign(document.createElement('div'), { id: 'app' }))
    await mounted({
      ...sampling(USERS),
      'ui.suggestPersonalData': () => {
        throw new AskError(
          'not_permitted',
          'Only an administrator of this connection names its personal data',
        )
      },
    })
    click('suggest')
    await flush()
    expect(notes()).toContain('Only an administrator of this connection adds personal data rules')
    expect(notes()).toContain('Copy the list and send it to one.')
    document.body.replaceChildren(Object.assign(document.createElement('div'), { id: 'app' }))
    await mounted({
      ...sampling(USERS),
      'ui.suggestPersonalData': () => {
        throw new AskError('no_activation', 'Only right after the user clicks or types in the plugin')
      },
    })
    click('suggest')
    await flush()
    expect(notes()).toContain('Could not open the Personal data section: Click the button again')
  })

  it('suggests 50 fields at once at most, and says how many more are chosen', async () => {
    const wide = Array.from({ length: 5 }, () =>
      Object.fromEntries(Array.from({ length: 55 }, (_, i) => [`email${i}`, `u${i}@example.com`])),
    )
    const { calls } = await mounted(sampling(wide))
    // Said before Suggest: the Personal data section takes the page after it.
    expect(notes()).toContain(
      '55 fields are chosen: the first 50 are suggested at once, the others once these are added.',
    )
    // Kept open meanwhile, so the scan is there for the next ones.
    expect(calls.some((c) => c.method === 'ui.keepOpen')).toBe(true)
    click('suggest')
    await flush()
    expect(calls.find((c) => c.method === 'ui.suggestPersonalData')!.params.fields).toHaveLength(MAX_SUGGEST)
    expect(notes()).toContain('The Personal data section lists 50 fields to add')
    expect(notes()).toContain('5 more chosen: suggest them once these are added.')
    // The next Suggest sends the 5 left, not the same 50 again.
    click('suggest')
    await flush()
    const sentNow = calls.filter((c) => c.method === 'ui.suggestPersonalData')
    expect(sentNow).toHaveLength(2)
    expect(sentNow[1]!.params.fields).toEqual(['email50', 'email51', 'email52', 'email53', 'email54'])
  })

  it('copies the fields chosen, one a line, and offers neither with none chosen', async () => {
    const { calls } = await mounted(sampling(USERS))
    for (const f of ['phone', 'apiToken', 'firstName']) box(f).click()
    click('copy')
    await flush()
    expect(calls.find((c) => c.method === 'ui.copy')!.params.text).toBe(
      'crm.users.email\tE-mail address\tHigh\n',
    )
    expect(notes()).toContain('The list is on the clipboard.')
    box('email').click()
    expect((document.getElementById('copy') as HTMLButtonElement).disabled).toBe(true)
    expect((document.getElementById('suggest') as HTMLButtonElement).disabled).toBe(true)
  })

  it('reads fewer documents when as many do not fit in one answer', async () => {
    const sizes: number[] = []
    await mounted({
      'documents.aggregate': (p) => {
        sizes.push(p.limit!)
        if (p.limit === SAMPLE) throw new AskError('too_large', 'The answer is over 1 MB')
        return { documents: USERS }
      },
    })
    expect(sizes).toEqual([SAMPLE, 60])
    expect(rows().length).toBeGreaterThan(0)
  })

  it('names the fields hidden from the user, never reading theirs, and says when it could not tell', async () => {
    const masked = USERS.map((u) => ({ ...u, email: '***' }))
    await mounted(sampling(masked), { ...PLACE, hidden: [['email']] })
    expect(rows().map((r) => r.dataset.finding)).not.toContain('email')
    expect(notes()).toContain('A field is hidden from you already')
    expect(notes()).toContain('email')
    document.body.replaceChildren(Object.assign(document.createElement('div'), { id: 'app' }))
    await mounted(sampling(USERS), { ...PLACE, hidden: null })
    expect(notes()).toContain('Which fields are hidden from you could not be told in time')
  })

  it('suggests nothing on a view: its data is its source’s', async () => {
    const { calls } = await mounted(sampling(USERS), { ...PLACE, view: true })
    expect((document.getElementById('suggest') as HTMLButtonElement).disabled).toBe(true)
    expect(notes()).toContain('A view’s data is its source’s')
    click('suggest')
    await flush()
    expect(calls.some((c) => c.method === 'ui.suggestPersonalData')).toBe(false)
  })

  it('says when there is nothing, no documents, no collection, or the documents could not be read', async () => {
    await mounted(sampling([{ _id: 1, note: 'tea', count: 3 }]))
    expect(app().textContent).toContain('No personal data found in the sample')
    document.body.replaceChildren(Object.assign(document.createElement('div'), { id: 'app' }))
    await mounted(sampling([]))
    expect(app().textContent).toContain('This collection has no documents')
    document.body.replaceChildren(Object.assign(document.createElement('div'), { id: 'app' }))
    await mounted(sampling([]), null)
    expect(app().textContent).toContain('Open a collection to look for personal data in it.')
    document.body.replaceChildren(Object.assign(document.createElement('div'), { id: 'app' }))
    const failing = await mounted({
      'documents.aggregate': () => {
        throw new AskError('failed', 'MongoDB denied this operation')
      },
    })
    expect(app().textContent).toContain('The documents could not be read')
    expect(app().textContent).toContain('MongoDB denied this operation')
    ;[...document.querySelectorAll('button')].find((b) => b.textContent === 'Try again')!.click()
    await flush()
    expect(failing.calls.filter((c) => c.method === 'documents.aggregate')).toHaveLength(2)
  })

  it('says it in Turkish', async () => {
    const f = await mounted(sampling(USERS))
    for (const fn of f.contexts) fn('tr', 'light', 'violet')
    expect(app().textContent).toContain('Kişisel veri bul')
    expect(row('email').textContent).toContain('E-posta adresi')
    expect(row('email').textContent).toContain('10 değerden 10 tanesi; adı da bunu söylüyor')
    expect(document.getElementById('status')!.textContent).toBe('10 belgede 6 alan kişisel veriye benziyor')
    expect(box('email').getAttribute('aria-label')).toBe('email alanını kişisel veri olarak öner')
  })

  it.each([
    ['zh', '查找个人数据', '电子邮件地址', '建议将 email 作为个人数据', 'zh-CN'],
    ['ja', '個人データを検索', 'メールアドレス', 'email を個人データとして提案', 'ja'],
    ['es', 'Buscar datos personales', 'Dirección de correo', 'Sugerir email como dato personal', 'es'],
    ['pt', 'Encontrar dados pessoais', 'Endereço de e-mail', 'Sugerir email como dado pessoal', 'pt-BR'],
    ['ko', '개인 데이터 찾기', '이메일 주소', 'email 필드를 개인 데이터로 제안', 'ko'],
    [
      'de',
      'Personenbezogene Daten finden',
      'E-Mail-Adresse',
      'email als personenbezogene Daten vorschlagen',
      'de',
    ],
    [
      'fr',
      'Rechercher les données personnelles',
      'Adresse e-mail',
      'Suggérer email comme donnée personnelle',
      'fr',
    ],
    [
      'ru',
      'Поиск персональных данных',
      'Адрес электронной почты',
      'Предложить поле email как персональные данные',
      'ru',
    ],
  ])('says it in %s', async (lang, title, email, label, tag) => {
    const f = await mounted(sampling(USERS))
    for (const fn of f.contexts) fn(lang, 'light', 'violet')
    expect(app().textContent).toContain(title)
    expect(row('email').textContent).toContain(email)
    expect(box('email').getAttribute('aria-label')).toBe(label)
    expect(document.documentElement.lang).toBe(tag)
  })

  it('falls back to English for an unknown locale', async () => {
    const f = await mounted(sampling(USERS))
    for (const fn of f.contexts) fn('xx', 'light', 'violet')
    expect(app().textContent).toContain('Find personal data')
    expect(row('email').textContent).toContain('E-mail address')
    expect(document.documentElement.lang).toBe('en')
  })

  it('falls back to English, numbers too, for a language a table really lacks', () => {
    // A table without Korean or German, as a plugin's would be that lacks them.
    const partial = { en: TEXT.en, tr: TEXT.tr }
    const en = new Intl.NumberFormat('en')
    for (const lang of ['ko', 'de']) {
      const text = pick(partial, lang)
      expect(text, lang).toBe(TEXT.en)
      expect(langTag(shown(partial, lang)), lang).toBe('en')
      expect(text.found(12345, 23456)).toBe(
        `${en.format(12345)} fields look like personal data in ${en.format(23456)} documents`,
      )
      expect(text.found(12345, 23456)).toContain('12,345')
      expect(formatNumber(1234567, shown(partial, lang))).toBe(en.format(1234567))
    }
    // Turkish, which the table has, stays Turkish.
    expect(pick(partial, 'tr').found(12345, 23456)).toBe(
      `${new Intl.NumberFormat('tr').format(23456)} belgede ${new Intl.NumberFormat('tr').format(12345)} alan kişisel veriye benziyor`,
    )
  })

  it('counts in the right form per language: 0, 1, 2, 5, 11, 21 and 22', () => {
    const counts = [0, 1, 2, 5, 11, 21, 22]
    expect(counts.map((n) => TEXT.en.byValues(n, n))).toEqual([
      '0 of 0 values',
      '1 of 1 value',
      '2 of 2 values',
      '5 of 5 values',
      '11 of 11 values',
      '21 of 21 values',
      '22 of 22 values',
    ])
    expect(TEXT.en.found(1, 1)).toBe('1 field looks like personal data in 1 document')
    expect(TEXT.en.noneHint(1)).toContain('In 1 document, no field')
    expect(TEXT.de.found(1, 1)).toContain('1 Feld sieht in 1 Dokument')
    expect(TEXT.de.found(2, 3)).toContain('2 Felder sehen in 3 Dokumenten')
    expect(counts.map((n) => TEXT.de.byValues(1, n))).toEqual([
      '1 von 0 Werten',
      '1 von 1 Wert',
      '1 von 2 Werten',
      '1 von 5 Werten',
      '1 von 11 Werten',
      '1 von 21 Werten',
      '1 von 22 Werten',
    ])
    expect(TEXT.es.byValues(1, 1)).toBe('1 de 1 valor')
    expect(TEXT.es.byValues(2, 21)).toBe('2 de 21 valores')
    expect(TEXT.es.suggestedMore(1)).toContain('Hay 1 campo más elegido: sugiérelo')
    expect(TEXT.es.suggestedMore(2)).toContain('Hay 2 campos más elegidos: sugiérelos')
    expect(TEXT.pt.byValues(1, 1)).toBe('1 de 1 valor')
    expect(TEXT.pt.suggestedMore(1)).toContain('Mais 1 campo escolhido: sugira-o')
    expect(TEXT.pt.suggestedMore(5)).toContain('Mais 5 campos escolhidos: sugira-os')
    // French: the singular for 0 and 1.
    expect(counts.map((n) => TEXT.fr.byValues(n, 30))).toEqual([
      '0 valeur sur 30',
      '1 valeur sur 30',
      '2 valeurs sur 30',
      '5 valeurs sur 30',
      '11 valeurs sur 30',
      '21 valeurs sur 30',
      '22 valeurs sur 30',
    ])
    expect(TEXT.fr.found(1, 1)).toContain('1 champ semble')
    expect(TEXT.fr.found(0, 2)).toContain('0 champ semble')
    expect(TEXT.fr.found(2, 2)).toContain('2 champs semblent')
    expect(TEXT.fr.hidden(1)).toContain('Un champ vous est déjà masqué')
    expect(TEXT.fr.hidden(3)).toContain('champs vous sont déjà masqués')
    expect(TEXT.fr.suggestedMore(1)).toContain('1 champ de plus est choisi : suggérez-le')
    expect(TEXT.fr.suggestedMore(21)).toContain('21 champs de plus sont choisis : suggérez-les')
    expect(TEXT.de.hidden(1)).toContain('Ein Feld ist')
    // Russian: one (1, 21), few (2, 22), many (0, 5, 11).
    expect(counts.map((n) => TEXT.ru.hidden(n))).toEqual([
      '0 полей уже скрыто от вас',
      '1 поле уже скрыто от вас',
      '2 поля уже скрыты от вас',
      '5 полей уже скрыто от вас',
      '11 полей уже скрыто от вас',
      '21 поле уже скрыто от вас',
      '22 поля уже скрыты от вас',
    ])
    expect(TEXT.ru.byValues(1, 1)).toBe('1 из 1 значения')
    expect(TEXT.ru.byValues(2, 5)).toBe('2 из 5 значений')
    expect(TEXT.ru.byValues(2, 21)).toBe('2 из 21 значения')
    expect(TEXT.ru.byValues(2, 11)).toBe('2 из 11 значений')
    // "It" for one field only, "them" for 21 as for 2.
    expect(TEXT.ru.suggestedMore(1)).toContain('1 поле: предложите его')
    expect(TEXT.ru.suggestedMore(21)).toContain('21 поле: предложите их')
    expect(TEXT.ru.suggestedMore(22)).toContain('22 поля: предложите их')
    expect(TEXT.ru.suggestedMore(5)).toContain('5 полей: предложите их')
    expect(TEXT.ko.found(1, 1)).toBe('도큐먼트 1개 중 1개 필드가 개인 데이터로 보입니다')
  })

  it('keeps the same keys in every language as in English', () => {
    const keys = (v: unknown): unknown =>
      v && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v)
              .map(([k, x]) => [k, keys(x)] as const)
              .sort(([a], [b]) => a.localeCompare(b)),
          )
        : typeof v
    for (const lang of Object.keys(TEXT) as Array<keyof typeof TEXT>)
      expect(keys(TEXT[lang]), lang).toEqual(keys(TEXT.en))
    expect(Object.keys(TEXT)).toEqual(['en', 'tr', 'zh', 'ja', 'es', 'pt', 'ko', 'de', 'fr', 'ru'])
  })
})
