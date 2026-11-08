// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { shapeOf } from '../../kit/src/shape'
import { EN, TR } from '../src/data/lists'
import { generate, previewDocs, PREVIEW, toNdjson } from '../src/generate'
import { RULES, plansOf, templateFor, wordsOf, type FieldPlan } from '../src/plan'
import { rand } from '../src/prng'
import { shellText } from '../../kit/src/shell'
import { GROUPS, TEMPLATES, templateOf } from '../src/templates'

/** Plugins wave 3 (spec §3): test documents shaped like a collection's, from 100+ templates. */
describe('the random source', () => {
  it('gives the same numbers for the same seed, and others for another', () => {
    const a = rand(42)
    const b = rand(42)
    const seq = (r: ReturnType<typeof rand>) => Array.from({ length: 5 }, () => r.int(0, 1000))
    expect(seq(a)).toEqual(seq(b))
    expect(seq(rand(42))).not.toEqual(seq(rand(43)))
    const r = rand(1)
    for (let i = 0; i < 1000; i++) {
      const n = r.int(3, 7)
      expect(n).toBeGreaterThanOrEqual(3)
      expect(n).toBeLessThanOrEqual(7)
    }
  })
})

describe('the templates', () => {
  it('are more than 100, each named in both languages, each in a known group, ids unique', () => {
    expect(TEMPLATES.length).toBeGreaterThanOrEqual(100)
    expect(new Set(TEMPLATES.map((x) => x.id)).size).toBe(TEMPLATES.length)
    for (const x of TEMPLATES) {
      expect(x.label.en.length, x.id).toBeGreaterThan(0)
      expect(x.label.tr.length, x.id).toBeGreaterThan(0)
      expect(GROUPS).toContain(x.group)
    }
  })

  it('each make a value that is JSON, in either language, for many seeds', () => {
    for (const lists of [EN, TR])
      for (let seed = 1; seed <= 25; seed++)
        for (const x of TEMPLATES) {
          const value = x.make({ r: rand(seed), lists, index: seed, existing: ['a'], constant: 'c' })
          expect(() => JSON.parse(JSON.stringify(value)), x.id).not.toThrow()
          expect(value, x.id).not.toBeUndefined()
        }
  })

  it('never makes an address that reaches anyone: reserved domains, documentation ranges, no real line', () => {
    const make = (id: string, seed: number, lists = EN) =>
      templateOf(id)!.make({ r: rand(seed), lists, index: 0 })
    for (let seed = 1; seed <= 200; seed++) {
      expect(make('email', seed)).toMatch(/@(example\.(com|org|net)|mail\.test|shop\.test)$/)
      expect(make('url', seed)).toMatch(/^https:\/\/(example\.(com|org|net)|mail\.test|shop\.test)\//)
      expect(make('domain', seed)).toMatch(/\.test$/)
      expect(make('ipv4', seed)).toMatch(/^(192\.0\.2|198\.51\.100|203\.0\.113)\.\d+$/)
      expect(make('ipv6', seed)).toMatch(/^2001:db8:/)
      expect(make('phone', seed)).toMatch(/^\+1 [2-9]\d\d-555-01\d\d$/)
      expect(make('phone', seed, TR)).toMatch(/^\+90 000 /)
      expect(make('iban', seed)).toMatch(/^XX00 TEST /)
    }
    // Turkish letters folded for the part before @.
    expect(make('email', 3, TR)).toMatch(/^[a-z0-9.]+@/)
  })

  it('writes typed values as canonical Extended JSON', () => {
    const make = (id: string) => templateOf(id)!.make({ r: rand(7), lists: EN, index: 4 })
    expect(make('age')).toEqual({ $numberInt: expect.stringMatching(/^\d+$/) })
    expect(make('price')).toEqual({ $numberDouble: expect.stringMatching(/^\d+(\.\d+)?$/) })
    expect(make('pastDate')).toEqual({ $date: { $numberLong: expect.stringMatching(/^\d+$/) } })
    expect(make('long')).toEqual({ $numberLong: expect.stringMatching(/^\d+$/) })
    expect(make('amountDecimal')).toEqual({ $numberDecimal: expect.stringMatching(/^\d+\.\d\d$/) })
    expect(make('objectId')).toEqual({ $oid: expect.stringMatching(/^[0-9a-f]{24}$/) })
    expect(make('uuid')).toEqual({ $binary: { base64: expect.any(String), subType: '04' } })
    expect(make('sequence')).toEqual({ $numberInt: '5' })
    expect(make('geoPoint')).toMatchObject({
      type: 'Point',
      coordinates: [{ $numberDouble: expect.any(String) }, expect.any(Object)],
    })
  })
})

describe('which template a field gets', () => {
  it('by its name, in English or Turkish, else by its type', () => {
    const f = (path: string, type = 'string', hidden = false) =>
      templateFor({ path, types: [{ type, count: 1 }], hidden })
    expect(f('email')).toBe('email')
    expect(f('contact.eposta')).toBe('email')
    expect(f('soyad')).toBe('lastName')
    expect(f('createdAt', 'date')).toBe('pastDate')
    expect(f('price', 'double')).toBe('price')
    expect(f('isActive', 'boolean')).toBe('boolean')
    expect(f('items[].qty', 'int32')).toBe('quantity')
    expect(f('mystery', 'int32')).toBe('int1000')
    expect(f('mystery', 'date')).toBe('pastDate')
    expect(f('mystery', 'objectId')).toBe('objectId')
    // A hidden field: no type is guessed.
    expect(templateFor({ path: 'secret', types: [], hidden: true })).toBe('sentence')
  })

  // Wave 3 review (e2e 2026-10-26): avatars of bytes got web addresses, and the collection's type
  // changed. A name never changes a field's kind of value; it picks the closest one of that kind.
  it('keeps the type the field has, by a template of the same kind the name calls for', () => {
    const f = (path: string, type: string) =>
      templateFor({ path, types: [{ type, count: 1 }], hidden: false })
    expect(f('avatar', 'binary')).toBe('pngImage')
    expect(f('photo', 'binary')).toBe('pngImage')
    expect(f('payload', 'binary')).toBe('bytes')
    expect(f('createdAt', 'string')).toBe('dateString')
    expect(f('createdOn', 'int32')).toBe('unixSecondsInt')
    expect(f('updatedAt', 'long')).toBe('unixSeconds')
    expect(f('price', 'string')).toBe('words')
    // Numbers of another width are numbers still.
    expect(f('price', 'int32')).toBe('price')
    expect(f('items[].qty', 'double')).toBe('quantity')
    expect(f('id', 'uuid')).toBe('uuid')
    // An image made is a PNG the Binary preview draws; bytes are bytes.
    const g = { r: rand(1), lists: EN, index: 0 }
    const image = templateOf('pngImage')!.make(g) as { $binary: { base64: string; subType: string } }
    expect(image.$binary.subType).toBe('00')
    expect(atob(image.$binary.base64).slice(0, 8)).toBe('\x89PNG\r\n\x1a\n')
    const bytes = templateOf('bytes')!.make(g) as { $binary: { base64: string; subType: string } }
    expect(bytes.$binary.subType).toBe('00')
    expect(atob(bytes.$binary.base64).length).toBeGreaterThanOrEqual(16)
  })

  it('names only templates there are', () => {
    for (const [, id] of RULES) expect(templateOf(id), id).toBeDefined()
  })
})

describe('the plans of a collection', () => {
  const docs = [
    {
      _id: { $oid: '65a1b2c3d4e5f60718293a01' },
      name: 'Ada',
      status: 'paid',
      card: '***',
      items: [{ sku: 'A', qty: { $numberInt: '2' } }],
      address: { city: 'Izmir' },
    },
    { _id: { $oid: '65a1b2c3d4e5f60718293a02' }, name: 'Grace', status: 'shipped', card: '***' },
    // Each status seen twice: a few values repeated are offered (wave 3 review).
    { _id: { $oid: '65a1b2c3d4e5f60718293a03' }, name: 'Linus', status: 'paid', card: '***' },
    { _id: { $oid: '65a1b2c3d4e5f60718293a04' }, name: 'Ken', status: 'shipped', card: '***' },
  ]
  const plans = plansOf(shapeOf(docs, [['card']]), docs)
  const plan = (path: string) => plans.find((p) => p.path === path)

  it('leaves _id to the server and makes a field holding others by its fields', () => {
    expect(plans.map((p) => p.path)).toEqual([
      'name',
      'status',
      'card',
      'items[].sku',
      'items[].qty',
      'address.city',
    ])
  })

  it('offers the existing values of a field with few, and nothing of a hidden one', () => {
    expect(plan('status')).toMatchObject({ template: 'existing', existing: ['paid', 'shipped'] })
    // A name is made, never copied from the collection, however few names it holds.
    expect(plan('name')).toMatchObject({ template: 'fullName' })
    expect(plan('card')).toMatchObject({ hidden: true, seen: 'hidden', template: 'sentence' })
    expect(plan('card')!.existing).toBeUndefined()
  })
})

describe('the documents made', () => {
  const plans: FieldPlan[] = [
    { path: 'name', include: true, template: 'fullName', hidden: false, seen: 'string' },
    {
      path: 'status',
      include: true,
      template: 'existing',
      hidden: false,
      seen: 'string',
      existing: ['a', 'b'],
    },
    { path: 'items[].qty', include: true, template: 'quantity', hidden: false, seen: 'int32' },
    { path: 'address.city', include: true, template: 'city', hidden: false, seen: 'string' },
    { path: 'skipped', include: false, template: 'word', hidden: false, seen: 'string' },
    { path: 'note', include: true, template: 'constant', hidden: false, seen: 'string', constant: 'hello' },
    { path: '__proto__.polluted', include: true, template: 'word', hidden: false, seen: 'string' },
  ]
  const settings = { count: 50, blankShare: 0, lang: 'en' as const, seed: 9 }

  it('are as many as asked, shaped by the plans, nested and in arrays, never past 5,000', () => {
    const docs = generate(plans, settings)
    expect(docs).toHaveLength(50)
    for (const d of docs) {
      expect(Object.keys(d)).toEqual(['name', 'status', 'items', 'address', 'note'])
      expect(['a', 'b']).toContain(d.status)
      expect(d.note).toBe('hello')
      const items = d.items as Array<{ qty: unknown }>
      expect(items.length).toBeGreaterThanOrEqual(1)
      expect(items.length).toBeLessThanOrEqual(3)
      for (const item of items) expect(item.qty).toEqual({ $numberInt: expect.any(String) })
      expect(typeof (d.address as { city: unknown }).city).toBe('string')
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(generate(plans, { ...settings, count: 100_000 })).toHaveLength(5000)
  })

  it('are the same for the same seed, and leave out about the share of fields asked', () => {
    expect(generate(plans, settings)).toEqual(generate(plans, settings))
    expect(generate(plans, { ...settings, seed: 10 })).not.toEqual(generate(plans, settings))
    const sparse = generate(plans, { ...settings, count: 400, blankShare: 0.5 })
    const kept = sparse.reduce((n, d) => n + Object.keys(d).length, 0) / (400 * 5)
    expect(kept).toBeGreaterThan(0.4)
    expect(kept).toBeLessThan(0.6)
    // At most 90% is left out, whatever is asked: a document is never all blank.
    const most = generate(plans, { ...settings, count: 200, blankShare: 1 })
    expect(most.reduce((n, d) => n + Object.keys(d).length, 0)).toBeGreaterThan(0)
  })

  it('are one JSON document a line', () => {
    const text = toNdjson(generate(plans, { ...settings, count: 3 }))
    const lines = text.trim().split('\n')
    expect(lines).toHaveLength(3)
    for (const line of lines) expect(JSON.parse(line)).toMatchObject({ note: 'hello' })
  })
})

/** Wave 3 review (opus, 2026-10-26): what the review found in the test data plugin. */
describe('the wave 3 review', () => {
  const f = (path: string, type = 'string') =>
    templateFor({ path, types: [{ type, count: 1 }], hidden: false })

  it('reads a name by its words: no rule matches inside another word', () => {
    expect(f('hotelName')).toBe('words')
    expect(f('adobeId')).toBe('words')
    expect(f('issue')).toBe('words')
    expect(f('hash')).toBe('words')
    expect(f('isActive', 'boolean')).toBe('boolean')
    expect(f('has_children', 'boolean')).toBe('boolean')
    expect(f('phoneNumber')).toBe('phone')
    expect(f('mobile_phone')).toBe('phone')
    expect(f('ipAddress')).toBe('ipv4')
    expect(f('dateOfBirth', 'date')).toBe('birthDate')
    expect(f('firstName')).toBe('firstName')
    expect(f('lastName')).toBe('lastName')
    expect(f('emailAddress')).toBe('email')
    expect(f('loginCount', 'int32')).toBe('quantity')
  })

  it('gives a hidden field text, whatever its name', () => {
    expect(templateFor({ path: 'email', types: [], hidden: true })).toBe('sentence')
    expect(templateFor({ path: 'createdAt', types: [], hidden: true })).toBe('sentence')
  })

  it('has a template of the same type for objects, timestamps and dates kept as int32', () => {
    expect(f('meta', 'object')).toBe('emptyObject')
    expect(f('ts', 'timestamp')).toBe('timestamp')
    expect(f('createdOn', 'int32')).toBe('unixSecondsInt')
    expect(f('createdOn', 'long')).toBe('unixSeconds')
    const g = { r: rand(3), lists: EN, index: 0 }
    expect(templateOf('unixSecondsInt')!.make(g)).toEqual({ $numberInt: expect.stringMatching(/^\d+$/) })
    expect(templateOf('timestamp')!.make(g)).toEqual({
      $timestamp: { t: expect.any(Number), i: expect.any(Number) },
    })
  })

  it('makes thousands of distinct phone numbers, all in the range kept for fiction', () => {
    const r = rand(5)
    const phones = new Set<string>()
    for (let i = 0; i < 3000; i++) {
      const phone = templateOf('phone')!.make({ r, lists: EN, index: i }) as string
      expect(phone).toMatch(/^\+1 [2-9]\d\d-555-01\d\d$/)
      phones.add(phone)
    }
    expect(phones.size).toBeGreaterThan(2000)
  })

  it('names no real company', () => {
    const real = ['Anadolu', 'Yıldız', 'Uludağ', 'Marmara', 'Boğaziçi', 'Zirve', 'Lider', 'Atlas', 'Akdeniz']
    const realEn = ['Prestige', 'Sterling', 'Monarch']
    for (const name of TR.companies) expect(real, name).not.toContain(name)
    for (const name of EN.companies) expect(realEn, name).not.toContain(name)
  })

  it('never makes a document with no field, whatever share is left out', () => {
    const five: FieldPlan[] = ['a', 'b', 'c', 'd', 'e'].map((path) => ({
      path,
      include: true,
      template: 'word',
      hidden: false,
      seen: 'string',
    }))
    const docs = generate(five, { count: 500, blankShare: 0.9, lang: 'en', seed: 4 })
    for (const d of docs) expect(Object.keys(d).length).toBeGreaterThan(0)
  })

  it('never copies a real identifier, nor offers the values of a person, place or address', () => {
    const docs = [
      {
        tckn: '10000000146',
        accountNo: 'QX-7701',
        passportNo: 'U12345678',
        nickname: 'Qace7Z',
        status: 'a',
        country: 'TR',
        name: 'Ada',
      },
      {
        tckn: '10000000278',
        accountNo: 'QX-7701',
        passportNo: 'U22345678',
        nickname: 'Qbee8Z',
        status: 'a',
        country: 'TR',
        name: 'Ada',
      },
      {
        tckn: '10000000390',
        accountNo: 'QY-8802',
        passportNo: 'U32345678',
        nickname: 'Qcat9Z',
        status: 'b',
        country: 'DE',
        name: 'Ada',
      },
      {
        tckn: '10000000412',
        accountNo: 'QY-8802',
        passportNo: 'U42345678',
        nickname: 'Qdog0Z',
        status: 'b',
        country: 'DE',
        name: 'Ada',
      },
      {
        tckn: '10000000524',
        accountNo: 'QX-7701',
        passportNo: 'U52345678',
        nickname: 'Qeel1Z',
        status: 'a',
        country: 'TR',
        name: 'Ada',
      },
    ]
    const plans = plansOf(shapeOf(docs, []), docs)
    const plan = (path: string) => plans.find((p) => p.path === path)!
    // Unique values are never offered: a sample of ids, names or codes is never copied.
    for (const path of ['tckn', 'passportNo', 'nickname']) {
      expect(plan(path).existing, path).toBeUndefined()
      expect(plan(path).template, path).not.toBe('existing')
    }
    // A name repeated is still a name: made, never copied or offered.
    expect(plan('name').existing).toBeUndefined()
    // An identifier repeated (two documents of one account) is still an identifier.
    expect(plan('accountNo').existing).toBeUndefined()
    expect(plan('accountNo').template).not.toBe('existing')
    // A few values each seen again and again: a status, a country.
    expect(plan('status')).toMatchObject({ template: 'existing', existing: ['a', 'b'] })
    expect(plan('country')).toMatchObject({ template: 'existing', existing: ['TR', 'DE'] })
    const made = JSON.stringify(generate(plans, { count: 300, blankShare: 0, lang: 'en', seed: 2 }))
    for (const d of docs)
      for (const value of [d.tckn, d.passportNo, d.nickname, d.accountNo]) expect(made).not.toContain(value)
  })

  it('makes a GeoJSON point as one field, and a pair of coordinates as a pair', () => {
    const docs = [
      { location: { type: 'Point', coordinates: [27.1, 38.4] }, coordinates: [27.1, 38.4] },
      { location: { type: 'Point', coordinates: [32.8, 39.9] }, coordinates: [32.8, 39.9] },
    ]
    const plans = plansOf(shapeOf(docs, []), docs)
    expect(plans.map((p) => [p.path, p.template])).toEqual([
      ['location', 'geoPoint'],
      ['coordinates', 'lngLatPair'],
    ])
    const [doc] = generate(plans, { count: 1, blankShare: 0, lang: 'en', seed: 1 })
    expect(doc!.location).toMatchObject({
      type: 'Point',
      coordinates: [expect.any(Object), expect.any(Object)],
    })
    expect(doc!.coordinates).toEqual([
      { $numberDouble: expect.any(String) },
      { $numberDouble: expect.any(String) },
    ])
  })

  it('dates from the time the tab opened, and previews only what it shows', () => {
    const plans: FieldPlan[] = [
      { path: 'at', include: true, template: 'pastDate', hidden: false, seen: 'date' },
    ]
    const now = Date.UTC(2031, 5, 1)
    const docs = generate(plans, { count: 50, blankShare: 0, lang: 'en', seed: 3, now })
    for (const d of docs) {
      const ms = Number((d.at as { $date: { $numberLong: string } }).$date.$numberLong)
      expect(ms).toBeLessThanOrEqual(now)
      expect(ms).toBeGreaterThan(now - 366 * 86_400_000)
    }
    const settings = { count: 5000, blankShare: 0.3, lang: 'en' as const, seed: 8, now }
    const shown = previewDocs(plans, settings)
    expect(shown).toHaveLength(PREVIEW)
    expect(shown).toEqual(generate(plans, settings).slice(0, PREVIEW))
    expect(previewDocs(plans, { ...settings, count: 2 })).toHaveLength(2)
    // Only the documents shown are made: the template runs five times, not 5,000.
    const template = templateOf('pastDate')!
    const make = template.make
    let made = 0
    template.make = (g) => {
      made++
      return make(g)
    }
    try {
      previewDocs(plans, { ...settings, blankShare: 0 })
    } finally {
      template.make = make
    }
    expect(made).toBe(PREVIEW)
  })
})

describe('a document as the shell writes it', () => {
  it('reads as the shell would', () => {
    expect(
      shellText({
        _id: { $oid: '65a1b2c3d4e5f60718293a01' },
        at: { $date: { $numberLong: String(Date.UTC(2026, 0, 2)) } },
        n: { $numberInt: '3' },
        big: { $numberLong: '9' },
        d: { $numberDecimal: '1.50' },
        'odd key': "it's",
        tags: ['a'],
        empty: {},
      }),
    ).toBe(
      [
        '{',
        "  _id: ObjectId('65a1b2c3d4e5f60718293a01'),",
        "  at: ISODate('2026-01-02T00:00:00.000Z'),",
        '  n: 3,',
        "  big: NumberLong('9'),",
        "  d: NumberDecimal('1.50'),",
        "  'odd key': 'it\\'s',",
        '  tags: [',
        "    'a'",
        '  ],',
        '  empty: {}',
        '}',
      ].join('\n'),
    )
  })
})

/** The second review of wave 3 (opus, 2026-10-26): what the first round of fixes left. */
describe('the wave 3 second review', () => {
  const f = (path: string, type = 'string') =>
    templateFor({ path, types: [{ type, count: 1 }], hidden: false })

  it('reads a name with a number in it by its words: email2 is an e-mail', () => {
    expect(wordsOf('email2')).toBe('email_2')
    expect(wordsOf('phone1')).toBe('phone_1')
    expect(wordsOf('address1Line')).toBe('address_1_line')
    expect(f('email2')).toBe('email')
    expect(f('phone1')).toBe('phone')
    expect(f('address1')).toBe('streetAddress')
    expect(f('adres2')).toBe('streetAddress')
  })

  it('never offers the values of email2, phone1 or address1, however often they come back', () => {
    const docs = Array.from({ length: 8 }, (_, i) => ({
      email2: ['ada@corp.example', 'grace@corp.example'][i % 2],
      phone1: ['+90 555 000 11 22', '+90 555 000 33 44'][i % 2],
      address1: ['Kordon 1', 'Alsancak 2'][i % 2],
      adres2: ['Bornova 3', 'Konak 4'][i % 2],
    }))
    const plans = plansOf(shapeOf(docs, []), docs)
    for (const p of plans) {
      expect(p.existing, p.path).toBeUndefined()
      expect(p.template, p.path).not.toBe('existing')
    }
    const made = JSON.stringify(generate(plans, { count: 200, blankShare: 0, lang: 'en', seed: 7 }))
    for (const d of docs) for (const v of Object.values(d)) expect(made).not.toContain(v)
  })

  it('offers values only when every one of them comes back, never one seen once', () => {
    // One value seen 13 times and seven seen once: an average of 2.5 a value, yet seven are unique.
    const tiers = [
      ...Array.from({ length: 13 }, () => 'gold'),
      'Qa1',
      'Qb2',
      'Qc3',
      'Qd4',
      'Qe5',
      'Qf6',
      'Qg7',
    ]
    const docs = tiers.map((tier) => ({ tier }))
    const plans = plansOf(shapeOf(docs, []), docs)
    expect(plans[0]!.existing).toBeUndefined()
    expect(plans[0]!.template).not.toBe('existing')
    const made = JSON.stringify(generate(plans, { count: 300, blankShare: 0, lang: 'en', seed: 9 }))
    for (const once of tiers.slice(13)) expect(made).not.toContain(once)
    // Each value at least twice: offered.
    const twice = ['a', 'a', 'b', 'b', 'c', 'c'].map((tier) => ({ tier }))
    expect(plansOf(shapeOf(twice, []), twice)[0]).toMatchObject({
      template: 'existing',
      existing: ['a', 'b', 'c'],
    })
  })

  it('never offers the values of a field named for a person', () => {
    const names = [
      'owner',
      'author',
      'customer',
      'client',
      'createdBy',
      'assignee',
      'müşteri',
      'musteri',
      'sahibi',
      'yazar',
      'kullanıcı',
      'üye',
      'personel',
      'çalışan',
      'patient',
      'student',
      'buyer',
      'seller',
      'recipient',
      'sender',
      'member',
      'employee',
      'contact',
      'manager',
      'user',
    ]
    for (const name of names) {
      const docs = ['Ada', 'Ada', 'Grace', 'Grace'].map((v) => ({ [name]: v }))
      const plan = plansOf(shapeOf(docs, []), docs)[0]!
      expect(plan.existing, name).toBeUndefined()
      expect(plan.template, name).not.toBe('existing')
    }
  })

  it('offers no existing values when it is not given the documents to count them in', () => {
    const docs = ['a', 'a', 'b', 'b'].map((status) => ({ status }))
    expect(plansOf(shapeOf(docs, []))[0]!.existing).toBeUndefined()
  })

  it('gives a birth date kept as text dates as text', () => {
    expect(f('birthDate')).toBe('dateString')
    expect(f('dogumTarihi')).toBe('dateString')
    expect(f('birthDate', 'date')).toBe('birthDate')
  })

  it('names no company a reader would take for a real one', () => {
    const real = [
      'Apple',
      'Google',
      'Microsoft',
      'Amazon',
      'Meta',
      'Tesla',
      'IBM',
      'Oracle',
      'Samsung',
      'Sony',
      'Intel',
      'Siemens',
      'Bosch',
      'Toyota',
      'Nestle',
      'Unilever',
      'Koç',
      'Sabancı',
      'Turkcell',
      'Arçelik',
      'Vestel',
      'Migros',
      'Akbank',
      'Garanti',
      'Türk Telekom',
      'Ülker',
      'Eczacıbaşı',
      'Aselsan',
      'Anadolu',
      'Yıldız',
      'Zorlu',
      'Doğan',
      'Borusan',
    ].map((x) => x.toLocaleLowerCase('tr'))
    for (const lists of [EN, TR])
      for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
        const name = (
          templateOf('companyName')!.make({ r: rand(seed), lists, index: 0 }) as string
        ).toLocaleLowerCase('tr')
        for (const firm of real) expect(name.split(/\s+/), name).not.toContain(firm)
      }
    for (const company of [...EN.companies, ...TR.companies])
      expect(real, company).not.toContain(company.toLocaleLowerCase('tr'))
  })
})
