// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import {
  findPersonalData,
  isCard,
  isEmail,
  isIban,
  isIp,
  isNationalId,
  isPhone,
  isSecret,
  kindOfName,
  kindOfValue,
  luhn,
  masked,
  plainKey,
  wordsOf,
} from '../src/detect'

// Published test numbers only (card networks' test cards, the IBAN registry's examples): no one's.
describe('values', () => {
  it('tells a card number by its network’s range, its length and the Luhn check', () => {
    expect(luhn('4111111111111111')).toBe(true)
    expect(luhn('4111111111111112')).toBe(false)
    for (const card of [
      '4111111111111111',
      '4111 1111 1111 1111',
      '5555-5555-5555-4444',
      '2223003122003222',
      '378282246310005',
      '6011111111111117',
      '3530111333300000',
      '9792000000000003',
    ])
      expect(isCard(card), card).toBe(true)
    // Luhn alone is no card: one in ten numbers passes it.
    for (const other of [
      '4111111111111112',
      '1234567812345670',
      '0000000000000000',
      '4111-1111',
      '41111111111111111111',
      '41111111111114',
    ])
      expect(isCard(other), other).toBe(false)
  })

  it('tells an IBAN by mod 97, Turkey’s by its length too', () => {
    expect(isIban('GB82WEST12345698765432')).toBe(true)
    expect(isIban('gb82 west 1234 5698 7654 32')).toBe(true)
    expect(isIban('TR330006100519786457841326')).toBe(true)
    expect(isIban('DE89370400440532013000')).toBe(true)
    expect(isIban('GB82WEST12345698765433')).toBe(false)
    expect(isIban('TR3300061005197864578413')).toBe(false)
    // Mod 97 right, but a Turkish IBAN is 26 long.
    expect(isIban('TR360006100519786457841')).toBe(false)
    expect(isIban('NOT-AN-IBAN')).toBe(false)
  })

  it('tells a Turkish identity number by its check digits, and a US social security number as written', () => {
    expect(isNationalId('10000000146')).toBe(true)
    expect(isNationalId('12345678950')).toBe(true)
    expect(isNationalId('10000000147')).toBe(false)
    // Its eleventh digit right, its tenth not; and one starting with 0, whose digits add up.
    expect(isNationalId('10000000157')).toBe(false)
    expect(isNationalId('01234567840')).toBe(false)
    expect(isNationalId('01234567890')).toBe(false)
    expect(isNationalId('123-45-6789')).toBe(true)
    for (const no of ['000-12-3456', '666-12-3456', '912-12-3456', '123-00-4567', '123-45-0000', '123456789'])
      expect(isNationalId(no), no).toBe(false)
  })

  it('tells e-mail and IP addresses, never a time or a version', () => {
    expect(isEmail('ada@example.com')).toBe(true)
    expect(isEmail('ada.lovelace+news@mail.example.co.uk')).toBe(true)
    for (const no of ['ada@example', '@example.com', 'ada example.com', 'a@b.c', 'x'.repeat(250) + '@e.com'])
      expect(isEmail(no), no).toBe(false)
    for (const ip of ['192.168.1.20', '8.8.8.8', '2001:db8::1', 'fe80::1ff:fe23:4567:890a', '::1'])
      expect(isIp(ip), ip).toBe(true)
    for (const no of ['256.1.1.1', '1.2.3', '12:30:45', '1:2:3', 'abc', '1.2.3.4.5', '2001:db8::1::2'])
      expect(isIp(no), no).toBe(false)
  })

  it('tells a phone number written as one; a bare number only where its name says so', () => {
    for (const phone of [
      '+90 532 123 45 67',
      '0532 123 4567',
      '05321234567',
      '(212) 555-0147',
      '0044 20 7946 0958',
    ])
      expect(isPhone(phone, false), phone).toBe(true)
    expect(isPhone('5321234567', false)).toBe(false)
    expect(isPhone('5321234567', true)).toBe(true)
    for (const no of ['12345', '1111111111', '+90 532', '2026-10-28', '12.50'])
      expect(isPhone(no, true), no).toBe(false)
  })
})

describe('names', () => {
  it('splits a key into folded words', () => {
    expect(wordsOf('phoneNumber2')).toEqual(['phone', 'number'])
    expect(wordsOf('doğum_tarihi')).toEqual(['dogum', 'tarihi'])
    expect(wordsOf('IBANCode')).toEqual(['iban', 'code'])
    expect(wordsOf('e-posta')).toEqual(['e', 'posta'])
  })

  it('says what a field holds by its name, and nothing for a name about the data (emailVerified)', () => {
    const cases: Array<[string[], string | null]> = [
      [['email'], 'email'],
      [['contactEmail'], 'email'],
      [['emailAddress'], 'email'],
      [['eposta'], 'email'],
      [['phone'], 'phone'],
      [['mobilePhoneNumber'], 'phone'],
      [['cepTelefon'], 'phone'],
      [['iban'], 'iban'],
      [['cardNumber'], 'card'],
      [['creditCard'], 'card'],
      [['pan'], 'card'],
      [['tckn'], 'nationalId'],
      [['tcKimlikNo'], 'nationalId'],
      [['ssn'], 'nationalId'],
      [['passportNumber'], 'nationalId'],
      [['lastLoginIp'], 'ip'],
      [['ipAddress'], 'ip'],
      [['firstName'], 'name'],
      [['soyad'], 'name'],
      [['customer', 'name'], 'name'],
      [['billingAddress'], 'address'],
      [['address', 'street'], 'address'],
      [['postalCode'], 'address'],
      [['birthDate'], 'birthDate'],
      [['dateOfBirth'], 'birthDate'],
      [['dogumTarihi'], 'birthDate'],
      [['password'], 'secret'],
      [['passwordHash'], 'secret'],
      [['apiKey'], 'secret'],
      [['resetToken'], 'secret'],
      [['sifre'], 'secret'],
      // About the data, not the data.
      [['emailVerified'], null],
      [['phoneType'], null],
      [['passwordChangedAt'], null],
      [['isMobile'], null],
      [['hasEmail'], null],
      [['emailCount'], null],
      // Not personal.
      [['name'], null],
      [['product', 'name'], null],
      [['macAddress'], null],
      [['zipFile'], null],
      [['timespan'], null],
      [['card'], null],
      [['company'], null],
      [['status'], null],
    ]
    for (const [segments, kind] of cases) expect(kindOfName(segments), segments.join('.')).toBe(kind)
  })
})

describe('masked examples', () => {
  it('say what a value is, never whose', () => {
    expect(masked('email', 'ada@example.com')).toBe('a•••@e•••.com')
    expect(masked('phone', '+90 532 123 45 67')).toBe('+•• ••• ••• •• 67')
    expect(masked('card', '4111 1111 1111 1111')).toBe('•••• •••• •••• ••11')
    expect(masked('iban', 'TR330006100519786457841326')).toBe('TR••••••••••••••••••••••26')
    expect(masked('nationalId', '10000000146')).toBe('•••••••••46')
    expect(masked('ip', '192.168.1.20')).toBe('192.•••.•••.•••')
    expect(masked('ip', '2001:db8::1')).toBe('2001:•••')
    expect(masked('name', 'Ada Lovelace')).toBe('A••• L•••')
    expect(masked('address', '12 Baker Street')).toBe('1••• B••• S•••')
    expect(masked('birthDate', '1815-12-10')).toBe('••••-••-••')
    expect(masked('secret', 'hunter2')).toBe('••••••••')
  })
})

const docs = (n: number, make: (i: number) => Record<string, unknown>) =>
  Array.from({ length: n }, (_, i) => make(i))

describe('the findings', () => {
  it('finds fields by their values and their names, the likeliest first, values masked', () => {
    const sample = docs(10, (i) => ({
      _id: { $oid: `65a1b2c3d4e5f6071829${String(1000 + i)}` },
      title: `Order ${i}`,
      contact: { mail: `user${i}@example.com`, tel: i < 9 ? '+90 532 123 45 67' : '' },
      cards: [{ number: '4111111111111111' }],
      notes: i % 2 ? 'Card 4111111111111111' : 'none',
      nickname: 'x',
      password: { $binary: { base64: 'AA==', subType: '00' } },
      firstName: 'Ada',
      ip: '10.0.0.1',
      createdAt: { $date: { $numberLong: '0' } },
      score: { $numberInt: String(i) },
    }))
    const { findings, sampled } = findPersonalData(sample, [])
    expect(sampled).toBe(10)
    const by = Object.fromEntries(findings.map((f) => [f.field, f]))
    expect(by['contact.mail']).toMatchObject({
      kind: 'email',
      confidence: 'high',
      values: 10,
      matched: 10,
      named: true,
    })
    expect(by['contact.mail']!.examples).toEqual(['u•••@e•••.com'])
    expect(by['contact.tel']).toMatchObject({ kind: 'phone', confidence: 'high', values: 9, matched: 9 })
    // Arrays are transparent, as a rule names a field.
    expect(by['cards.number']).toMatchObject({
      kind: 'card',
      confidence: 'high',
      segments: ['cards', 'number'],
    })
    expect(by['firstName']).toMatchObject({
      kind: 'name',
      confidence: 'medium',
      named: true,
      examples: ['A•••'],
    })
    expect(by['password']).toMatchObject({ kind: 'secret', confidence: 'high', examples: [] })
    expect(by['ip']).toMatchObject({ kind: 'ip', confidence: 'high' })
    for (const plain of ['title', 'notes', 'nickname', 'createdAt', 'score', '_id'])
      expect(by[plain], plain).toBeUndefined()
    expect(findings.map((f) => f.confidence)).toEqual(
      [...findings.map((f) => f.confidence)].sort(
        (a, b) => ['high', 'medium', 'low'].indexOf(a) - ['high', 'medium', 'low'].indexOf(b),
      ),
    )
    // No value appears but masked.
    const shown = JSON.stringify(findings)
    for (const raw of ['user1@example.com', '532 123 45 67', '4111111111111111', 'Ada', '10.0.0.1'])
      expect(shown, raw).not.toContain(raw)
  })

  it('says how sure: values that do not look like the name’s kind make it low', () => {
    const sample = docs(10, (i) => ({
      phone: `call me ${i}`,
      mail: i < 3 ? `a${i}@example.com` : 'n/a',
      ref: i < 3 ? '+90 532 123 45 67' : 'x',
    }))
    const by = Object.fromEntries(findPersonalData(sample, []).findings.map((f) => [f.field, f]))
    expect(by['phone']).toMatchObject({ kind: 'phone', confidence: 'low', named: true, matched: 0 })
    expect(by['mail']).toMatchObject({ kind: 'email', confidence: 'medium', matched: 3 })
    // Most values agree with its name: high, though not four in five.
    const agree = docs(10, (i) => ({
      email: i < 6 ? `a${i}@example.com` : 'n/a',
      other: i < 6 ? `a${i}@example.com` : 'n/a',
    }))
    const both = Object.fromEntries(findPersonalData(agree, []).findings.map((f) => [f.field, f]))
    expect(both['email']).toMatchObject({ kind: 'email', confidence: 'high', named: true })
    expect(both['other']).toMatchObject({ kind: 'email', confidence: 'medium', named: false })
    // Unnamed, some values: low.
    expect(by['ref']).toMatchObject({ kind: 'phone', confidence: 'low', named: false, matched: 3 })
  })

  it('reads no hidden field’s values, and names it as hidden from the user', () => {
    const sample = docs(5, () => ({ email: '***', contact: { phone: '***' }, other: 'a@example.com' }))
    const scan = findPersonalData(sample, [['email'], ['contact', '**']])
    expect(scan.hidden).toEqual(['email', 'contact.phone'])
    expect(scan.findings.map((f) => f.field)).toEqual(['other'])
  })

  it('marks a field no rule can name (a key with a dot or a $)', () => {
    const sample = docs(3, () => ({
      'a.b': 'ada@example.com',
      $weird: 'ada@example.com',
      ok: 'ada@example.com',
    }))
    const by = Object.fromEntries(findPersonalData(sample, []).findings.map((f) => [f.field, f]))
    expect(by['a.b']!.nameable).toBe(false)
    expect(by['$weird']!.nameable).toBe(false)
    expect(by['ok']!.nameable).toBe(true)
  })

  it('follows six levels deep at most, 200 values a field, 50 elements an array', () => {
    const deep = {
      a: { b: { c: { d: { e: { f: { g: 'ada@example.com' } } } } } },
      f6: { a: { b: { c: { d: { e: 'ada@example.com' } } } } },
    }
    const fields = findPersonalData([deep], []).findings.map((f) => f.field)
    expect(fields).toEqual(['f6.a.b.c.d.e'])
    const many = docs(300, (i) => ({ email: `u${i}@example.com` }))
    expect(findPersonalData(many, []).findings[0]!.values).toBe(200)
    const long = [{ emails: Array.from({ length: 80 }, (_, i) => `u${i}@example.com`) }]
    expect(findPersonalData(long, []).findings[0]!.values).toBe(50)
  })
})

describe('the review of 2026-10-29', () => {
  it('takes no plain number for a phone number: a coordinate, an amount, a time, a ZIP+4 code', () => {
    for (const [text, numeric] of [
      ['37.7749295', true],
      ['-122.4194155', true],
      ['1730123456.789', true],
      ['37.7749295', false],
      ['-122.4194155', false],
      ['12345-6789', false],
    ] as const)
      expect(kindOfValue(text, false, numeric), text).not.toBe('phone')
    // A whole number in a field named a phone is one; not a fraction.
    expect(isPhone('5321234567', true, true)).toBe(true)
    expect(isPhone('5321234567.5', true, true)).toBe(false)
    expect(isPhone('0532.123.45.67', false)).toBe(true)
    // Not where the name says phone either: a decimal, written as text.
    expect(isPhone('37.7749295', true)).toBe(false)
    // Coordinates in a GeoJSON field are no phones.
    const geo = Array.from({ length: 5 }, () => ({
      location: {
        type: 'Point',
        coordinates: [{ $numberDouble: '37.7749295' }, { $numberDouble: '-122.4194155' }],
      },
    }))
    expect(findPersonalData(geo, []).findings).toEqual([])
  })

  it('tells more card networks, and passwords and keys by their values', () => {
    for (const card of ['6200000000000005', '36000000000008', '30000000000004', '2200000000000004'])
      expect(isCard(card), card).toBe(true)
    const bcrypt = `$2b$10$${'a'.repeat(53)}`
    for (const secret of [
      bcrypt,
      '$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA',
      'eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.',
      'AKIAIOSFODNN7EXAMPLE',
      '-----BEGIN RSA PRIVATE KEY-----',
    ])
      expect(isSecret(secret), secret).toBe(true)
    for (const no of ['$2b$10$short', 'eyJ.not', 'AKIA123', 'hello']) expect(isSecret(no), no).toBe(false)
    const hashes = Array.from({ length: 4 }, () => ({ credential: bcrypt }))
    expect(findPersonalData(hashes, []).findings[0]).toMatchObject({
      kind: 'secret',
      confidence: 'high',
      examples: ['••••••••'],
    })
  })

  it('tells IP addresses from MAC addresses and short hex', () => {
    expect(isIp('::ffff:192.168.1.1')).toBe(true)
    expect(isIp('2001:db8:0:0:0:0:0:1')).toBe(true)
    for (const no of ['00:1a:2b:3c:4d:5e', 'cafe:babe:1', ':::', '1:2:3:4:5:6:7:8:9', '::ffff:300.1.1.1'])
      expect(isIp(no), no).toBe(false)
  })

  it('masks a long e-mail address and an odd top-level part without showing them', () => {
    const long = `${'christopher.alexander.montgomery-smithson'}@example.com`
    expect(masked('email', long)).toBe('c•••@e•••.com')
    expect(masked('email', 'x@corp.smithfamily')).toBe('x•••@c•••.•••')
    expect(masked('email', `${String.fromCodePoint(0x1f600)}x@example.org`)).toBe(
      `${String.fromCodePoint(0x1f600)}•••@e•••.org`,
    )
    expect(masked('name', `${String.fromCodePoint(0x1f600)} Ada`)).toBe(
      `${String.fromCodePoint(0x1f600)}••• A•••`,
    )
  })

  it('reads more English and Turkish names, and no product’s name', () => {
    const cases: Array<[string[], string | null]> = [
      [['customerName'], 'name'],
      [['patientName'], 'name'],
      [['cardHolderName'], 'name'],
      [['musteri', 'adi'], 'name'],
      [['kullanıcıAdı'], 'name'],
      [['soyisim'], 'name'],
      [['isimSoyisim'], 'name'],
      [['urun', 'adi'], null],
      [['kategori', 'isim'], null],
      [['adi'], null],
      [['cepTelefonu'], 'phone'],
      [['evTelefonu'], 'phone'],
      [['ePosta'], 'email'],
      [['e_posta'], 'email'],
      [['epostaAdresi'], 'email'],
      [['kimlikNumarasi'], 'nationalId'],
      [['tcKimlikNumarasi'], 'nationalId'],
      [['vergiNumarasi'], 'nationalId'],
      [['pasaportNo'], 'nationalId'],
      [['customerSsn'], 'nationalId'],
      [['Şifre'], 'secret'],
      [['ŞİFRE'], 'secret'],
      [['DOĞUM_TARİHİ'], 'birthDate'],
      [['ipv4Address'], 'ip'],
      [['birthPlace'], 'address'],
      [['dogumYeri'], 'address'],
      [['birthdayReminderSent'], null],
      [['nextPageToken'], null],
      [['resumeToken'], null],
      [['csrfToken'], null],
      [['pinCode'], null],
      [['gzip'], null],
      [['zip'], 'address'],
      [['cardValue'], null],
      [['cabin'], null],
    ]
    for (const [segments, kind] of cases) expect(kindOfName(segments), segments.join('.')).toBe(kind)
  })

  it('shows a field its name says is a password as one, whatever its values look like', () => {
    const sample = docs(4, (i) => ({ password: `user${i}@example.com` }))
    expect(findPersonalData(sample, []).findings[0]).toMatchObject({ kind: 'secret', examples: ['••••••••'] })
    expect(JSON.stringify(findPersonalData(sample, []))).not.toContain('example.com')
  })

  it('takes a field whose values are *** in every document for hidden, rules told or not', () => {
    const sample = docs(3, () => ({ email: '***', other: 'a@example.com' }))
    const scan = findPersonalData(sample, [])
    expect(scan.hidden).toEqual(['email'])
    expect(scan.findings.map((f) => f.field)).toEqual(['other'])
  })

  it('counts 200 values a field, of every kind, and reads fields beside a $ key', () => {
    const mixed = docs(300, (i) => ({ when: i % 2 ? { $date: { $numberLong: '0' } } : `u${i}@example.com` }))
    expect(findPersonalData(mixed, []).findings[0]!.values).toBe(200)
    const odd = docs(3, () => ({ meta: { $x: 1, email: 'ada@example.com' } }))
    expect(findPersonalData(odd, []).findings.map((f) => f.field)).toEqual(['meta.email'])
  })

  it('names nothing a rule cannot hold: a hidden character, spaces around, too long', () => {
    expect(plainKey('email')).toBe(true)
    for (const no of [
      `email${String.fromCharCode(0x200b)}`,
      'email ',
      ' email',
      'x'.repeat(129),
      '$x',
      'a.b',
      '*',
    ])
      expect(plainKey(no), JSON.stringify(no)).toBe(false)
    const long = 'f'.repeat(120)
    const deep = docs(3, () => ({ [long]: { [long]: { [long]: { [long]: { [long]: 'a@example.com' } } } } }))
    expect(findPersonalData(deep, [], { db: 'crm', coll: 'users' }).findings[0]!.nameable).toBe(false)
    expect(findPersonalData(deep, []).findings[0]!.nameable).toBe(true)
  })
})

describe('the final review of 2026-10-29', () => {
  it('reads a whole number stored as a double as the whole number it is', () => {
    const phones = docs(5, () => ({
      phone: { $numberDouble: '5321234567.0' },
      tckn: { $numberDouble: '10000000146.0' },
    }))
    const by = Object.fromEntries(findPersonalData(phones, []).findings.map((f) => [f.field, f]))
    expect(by['phone']).toMatchObject({ kind: 'phone', matched: 5 })
    expect(by['tckn']).toMatchObject({ kind: 'nationalId', matched: 5, confidence: 'high' })
    // Not a fraction.
    expect(kindOfValue('5321234567.5', true, true)).toBeNull()
  })

  it('finds a token longer than a name, by its value', () => {
    const long = `eyJ${'a'.repeat(200)}.eyJ${'b'.repeat(300)}.${'c'.repeat(40)}`
    const sample = docs(3, () => ({ credential: long }))
    expect(findPersonalData(sample, []).findings[0]).toMatchObject({ kind: 'secret' })
  })

  it('reads more names right: an id’s, a birth place’s, flags and tails that are no number', () => {
    const cases: Array<[string[], string | null]> = [
      [['nationalId'], 'nationalId'],
      [['taxId'], 'nationalId'],
      [['placeOfBirth'], 'address'],
      [['countryOfBirth'], 'address'],
      [['taxAddress'], 'address'],
      [['vergiAdresi'], 'address'],
      [['ccAddress'], 'address'],
      [['passwordAlgorithm'], null],
      [['passwordSet'], null],
      [['ipv6Support'], null],
      [['ipv4'], 'ip'],
      [['ipv4Address'], 'ip'],
    ]
    for (const [segments, kind] of cases) expect(kindOfName(segments), segments.join('.')).toBe(kind)
  })

  it('takes a version for no phone number, and is less sure of a secret’s flag', () => {
    expect(isPhone('10.0.19045.3803', false)).toBe(false)
    expect(isPhone('0532.123.45.67', false)).toBe(true)
    const flags = docs(4, () => ({ resetPassword: true }))
    expect(findPersonalData(flags, []).findings[0]).toMatchObject({ kind: 'secret', confidence: 'low' })
  })
})
