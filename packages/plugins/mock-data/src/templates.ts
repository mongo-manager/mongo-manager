// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { Lists } from './data/lists'
import type { Rand } from './prng'
import { EXTRA_LABELS } from './data/labels'
import type { Language } from '../../kit/src/ui'

/**
 * Plugins wave 3 (spec §3, NoSQLBooster's "Test Data Generator" has 100+ templates): what a field's
 * test values are made of. Each makes canonical Extended JSON, so the Import wizard keeps its type.
 * E-mails and web addresses use reserved example domains; phone numbers a range no line has.
 */
export interface Gen {
  r: Rand
  lists: Lists
  /** The document's place in the set, from 0 (for sequences). */
  index: number
  /** "One of the existing values": the field's sampled values. */
  existing?: readonly string[]
  /** A constant the user typed. */
  constant?: string
  /** "Now" for dates (wave 3 review: the time the tab opened, not a fixed day); NOW when absent. */
  now?: number
}

export const GROUPS = [
  'person',
  'internet',
  'location',
  'company',
  'commerce',
  'finance',
  'date',
  'number',
  'text',
  'identifier',
  'boolean',
  'other',
] as const
export type Group = (typeof GROUPS)[number]

export interface Template {
  id: string
  group: Group
  label: Record<Language, string>
  make(g: Gen): unknown
}

const DAY = 86_400_000
/** Avatars as PNG files (32 × 32, one colour each): what an image field of bytes is made of. */
const AVATARS = [
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAYklEQVR42u3UsREAEAyF4beBTZVWM4izj55DDkkU7y71/xUSCCmqDggQMANyLd28BMa63MBxXWjgpi4xCHwPqG+RxR1YXDJ/U+c3UFxTyZVtGdzX1wae1BeGB3BWnxkE/IEG5Q5opGwhzU8AAAAASUVORK5CYII=',
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAYklEQVR42u3UMQ4AEAyF4Xcsu6NLDC7jCnaCBm0NL+n8f4MWYiiqAwIEzICcajcvgbEuN3BcFxq4qUsMAt8D6ltkcQcWl8zf1PkNFNdUcmVbBvf1tYEn9YXhAZzVZwYBf6ABzglwIVpuH2YAAAAASUVORK5CYII=',
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAY0lEQVR42mOosXpLU8QwasGoBXSz4Prhn2iImhZgmk68HQxkm06kHQyUmE6MHaMWDHoLaJ6K6JEP6JGTR0vTAY4DGiZTYnIZQWsYKDcdvx0MVDEdjx0DYQF5puOyY9SCgbcAAJw+nEoE3kNyAAAAAElFTkSuQmCC',
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAYklEQVR42u3UwQ0AEAyF4Rez28gQdjCEGdwJGrR1eEnP/3fQQohZdUCAgBmQSu3mJTDW5QaO60IDN3WJQeB7QH2LLO7A4pL5mzq/geKaSq5sy+C+vjbwpL4wPICz+swg4A80GRiKd+szzKMAAAAASUVORK5CYII=',
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAY0lEQVR42mN4KOtBU8QwasGoBXSz4NvuE2iImhZgmk68HQxkm06kHQyUmE6MHaMWDHoLaJ6K6JEP6JGTR0vTAY4DGiZTYnIZQWsYKDcdvx0MVDEdjx0DYQF5puOyY9SCgbcAAKv7dCHCbk9rAAAAAElFTkSuQmCC',
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAYklEQVR42u3UwQ0AEAyF4XeyssXMIjGHBdwJGrR1eEnP/3fQQolBdUCAgBlQc+rmJTDW5QaO60IDN3WJQeB7QH2LLO7A4pL5mzq/geKaSq5sy+C+vjbwpL4wPICz+swg4A80vY2miew2h3kAAAAASUVORK5CYII=',
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAYklEQVR42u3UsREAEAyF4bedCQxhUo3KRHoOOSRRvLvU/1dIIMSkOiBAwAzIpXbzEhjrcgPHdaGBm7rEIPA9oL5FFndgccn8TZ3fQHFNJVe2ZXBfXxt4Ul8YHsBZfWYQ8AcaghmjDMN5n/4AAAAASUVORK5CYII=',
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAY0lEQVR42mNgnZZJU8QwasGoBXSzYMv9S2iImhZgmk68HQxkm06kHQyUmE6MHaMWDHoLaJ6K6JEP6JGTR0vTAY4DGiZTYnIZQWsYKDcdvx0MVDEdjx0DYQF5puOyY9SCgbcAANMVoC7B0qrvAAAAAElFTkSuQmCC',
]
/** "Now" for dates where none is given (tests): fixed, so a seed gives the same documents. */
export const NOW = Date.UTC(2026, 9, 26, 12, 0, 0)
const now = (g: Gen) => g.now ?? NOW

const int = (n: number) => ({ $numberInt: String(Math.trunc(n)) })
const long = (n: number | bigint) => ({ $numberLong: String(n) })
const double = (n: number) => {
  const s = String(Math.round(n * 100) / 100)
  return { $numberDouble: /[.eE]/.test(s) ? s : `${s}.0` }
}
const decimal = (s: string) => ({ $numberDecimal: s })
const date = (ms: number) => ({ $date: { $numberLong: String(Math.trunc(ms)) } })
const hex = (r: Rand, n: number) => Array.from({ length: n }, () => r.int(0, 15).toString(16)).join('')
const digits = (r: Rand, format: string) => format.replace(/#/g, () => String(r.int(0, 9)))
const ascii = (s: string) =>
  s
    .toLocaleLowerCase('en')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ı/g, 'i')
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.|\.$/g, '')
/**
 * A name or word in Latin letters for an e-mail, a user name, a slug or a domain: the languages not
 * written in Latin letters give a spelling beside each (`lists.latin`).
 */
const latin = (g: Gen, s: string) => ascii(g.lists.latin?.[s] ?? s) || hex(g.r, 4)
const fullNameOf = (g: Gen) => {
  const a = first(g)
  const b = last(g)
  return g.lists.familyFirst ? `${b}${a}` : `${a} ${b}`
}
const initialOf = (g: Gen, s: string) => (g.lists.latin?.[s] ?? s).charAt(0).toLocaleUpperCase()
const streetOf = (g: Gen) => {
  const name = g.r.pick(g.lists.streets)
  const kind = g.r.pick(g.lists.streetKinds)
  return g.lists.streetText ? g.lists.streetText(name, kind) : `${name} ${kind}`
}
const addressOf = (g: Gen) => {
  const name = g.r.pick(g.lists.streets)
  const kind = g.r.pick(g.lists.streetKinds)
  const n = g.r.int(1, 250)
  return g.lists.addressText ? g.lists.addressText(name, kind, n) : `${name} ${kind} ${n}`
}
const cap = (s: string) => s.charAt(0).toLocaleUpperCase() + s.slice(1)
const words = (g: Gen, n: number) => Array.from({ length: n }, () => g.r.pick(g.lists.words))
const joinOf = (g: Gen) => g.lists.joiner ?? ' '
const sentence = (g: Gen, min = 6, max = 12) =>
  `${cap(words(g, g.r.int(min, max)).join(joinOf(g)))}${g.lists.sentenceEnd ?? '.'}`
const uuidBytes = (r: Rand) => {
  const b = Array.from({ length: 16 }, () => r.int(0, 255))
  b[6] = (b[6]! & 0x0f) | 0x40
  b[8] = (b[8]! & 0x3f) | 0x80
  return b
}
const uuidText = (b: number[]) => {
  const h = b.map((x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}
const first = (g: Gen) => g.r.pick(g.lists.firstNames)
const last = (g: Gen) => g.r.pick(g.lists.lastNames)
const LOREM =
  'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua'.split(
    ' ',
  )
const CURRENCIES = ['USD', 'EUR', 'GBP', 'TRY', 'JPY', 'CHF', 'CAD', 'AUD', 'SEK', 'NOK']
const ZONES = ['Europe/Istanbul', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'Asia/Tokyo', 'UTC']
const AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
]
const TRANSACTIONS = ['deposit', 'withdrawal', 'payment', 'refund', 'transfer', 'fee']
const HTTP = [200, 201, 204, 301, 302, 400, 401, 403, 404, 409, 429, 500, 502, 503]
/** Reserved for documentation and testing (RFC 2606, RFC 6761): no mail or page reaches anyone. */
const DOMAINS = ['example.com', 'example.org', 'example.net', 'mail.test', 'shop.test']

const labelsOf = (id: string) => {
  const found = EXTRA_LABELS[id]
  if (!found) throw new Error(`No label in every language for the template ${id}`)
  return found
}

const t = (id: string, group: Group, en: string, tr: string, make: (g: Gen) => unknown): Template => ({
  id,
  group,
  label: { en, tr, ...labelsOf(id) },
  make,
})

export const TEMPLATES: Template[] = [
  // person
  t('firstName', 'person', 'First name', 'Ad', first),
  t('lastName', 'person', 'Last name', 'Soyad', last),
  t('fullName', 'person', 'Full name', 'Ad soyad', fullNameOf),
  t('gender', 'person', 'Gender', 'Cinsiyet', (g) => g.r.pick(g.lists.genders)),
  t('age', 'person', 'Age (18–90)', 'Yaş (18–90)', (g) => int(g.r.int(18, 90))),
  t('birthDate', 'person', 'Birth date', 'Doğum tarihi', (g) =>
    date(now(g) - g.r.int(18 * 365, 85 * 365) * DAY),
  ),
  t('jobTitle', 'person', 'Job title', 'Unvan', (g) => g.r.pick(g.lists.jobTitles)),
  t('username', 'person', 'Username', 'Kullanıcı adı', (g) => `${latin(g, first(g))}${g.r.int(1, 999)}`),
  t(
    'initials',
    'person',
    'Initials',
    'Baş harfler',
    (g) => `${initialOf(g, first(g))}${initialOf(g, last(g))}`,
  ),
  t('bio', 'person', 'Short bio', 'Kısa biyografi', (g) => sentence(g, 10, 18)),
  t(
    'avatarUrl',
    'person',
    'Avatar address',
    'Avatar adresi',
    (g) => `https://example.com/avatars/${g.r.int(1, 9999)}.png`,
  ),
  t('nickname', 'person', 'Nickname', 'Takma ad', (g) => `${cap(g.r.pick(g.lists.words))}${g.r.int(10, 99)}`),
  t('phone', 'person', 'Phone (a range no line has)', 'Telefon (hiçbir hattın olmadığı aralık)', (g) =>
    digits(g.r, g.lists.phoneFormat),
  ),
  // internet
  t(
    'email',
    'internet',
    'E-mail (example domains)',
    'E-posta (örnek alan adları)',
    (g) => `${latin(g, first(g))}.${latin(g, last(g))}${g.r.int(1, 99)}@${g.r.pick(DOMAINS)}`,
  ),
  t(
    'url',
    'internet',
    'Web address (example domains)',
    'Web adresi (örnek alan adları)',
    (g) => `https://${g.r.pick(DOMAINS)}/${latin(g, g.r.pick(g.lists.words))}/${g.r.int(1, 9999)}`,
  ),
  t(
    'domain',
    'internet',
    'Domain (reserved)',
    'Alan adı (ayrılmış)',
    (g) => `${latin(g, g.r.pick(g.lists.words))}.test`,
  ),
  t(
    'ipv4',
    'internet',
    'IPv4 (documentation range)',
    'IPv4 (belgeleme aralığı)',
    (g) => `${g.r.pick(['192.0.2', '198.51.100', '203.0.113'])}.${g.r.int(1, 254)}`,
  ),
  t(
    'ipv6',
    'internet',
    'IPv6 (documentation range)',
    'IPv6 (belgeleme aralığı)',
    (g) => `2001:db8:${hex(g.r, 4)}:${hex(g.r, 4)}::${hex(g.r, 4)}`,
  ),
  t('port', 'internet', 'Port', 'Port', (g) => int(g.r.int(1024, 65535))),
  t('macAddress', 'internet', 'MAC address', 'MAC adresi', (g) =>
    Array.from({ length: 6 }, (_, i) => (i === 0 ? '02' : hex(g.r, 2))).join(':'),
  ),
  t('userAgent', 'internet', 'User agent', 'Tarayıcı kimliği', (g) => g.r.pick(AGENTS)),
  t('slug', 'internet', 'Slug', 'Kısa ad (slug)', (g) =>
    words(g, 3)
      .map((x) => latin(g, x))
      .join('-'),
  ),
  t('hexColor', 'internet', 'Colour (hex)', 'Renk (onaltılık)', (g) => `#${hex(g.r, 6)}`),
  t('httpStatus', 'internet', 'HTTP status', 'HTTP durumu', (g) => int(g.r.pick(HTTP))),
  t('password', 'internet', 'Password hash (fake)', 'Parola özeti (sahte)', (g) => `$2b$10$${hex(g.r, 53)}`),
  // location
  t('country', 'location', 'Country', 'Ülke', (g) => g.r.pick(g.lists.countries)[1]),
  t('countryCode', 'location', 'Country code', 'Ülke kodu', (g) => g.r.pick(g.lists.countries)[0]),
  t('city', 'location', 'City', 'Şehir', (g) => g.r.pick(g.lists.cities)),
  t('region', 'location', 'Region', 'Bölge', (g) => g.r.pick(g.lists.regions)),
  t('street', 'location', 'Street', 'Sokak', (g) => streetOf(g)),
  t('streetAddress', 'location', 'Street address', 'Açık adres', (g) => addressOf(g)),
  t('buildingNumber', 'location', 'Building number', 'Bina numarası', (g) => String(g.r.int(1, 250))),
  t('postalCode', 'location', 'Postal code', 'Posta kodu', (g) => digits(g.r, g.lists.postalFormat)),
  t('latitude', 'location', 'Latitude', 'Enlem', (g) => double(g.r.next() * 180 - 90)),
  t('longitude', 'location', 'Longitude', 'Boylam', (g) => double(g.r.next() * 360 - 180)),
  t('geoPoint', 'location', 'GeoJSON point', 'GeoJSON noktası', (g) => ({
    type: 'Point',
    coordinates: [double(g.r.next() * 360 - 180), double(g.r.next() * 180 - 90)],
  })),
  t('lngLatPair', 'location', 'Longitude and latitude (pair)', 'Boylam ve enlem (çift)', (g) => [
    double(g.r.next() * 360 - 180),
    double(g.r.next() * 180 - 90),
  ]),
  t('timeZone', 'location', 'Time zone', 'Saat dilimi', (g) => g.r.pick(ZONES)),
  // company
  t(
    'companyName',
    'company',
    'Company',
    'Şirket',
    (g) => `${g.r.pick(g.lists.companies)}${joinOf(g)}${g.r.pick(g.lists.companySuffixes)}`,
  ),
  t('department', 'company', 'Department', 'Departman', (g) => g.r.pick(g.lists.departments)),
  t('industry', 'company', 'Industry', 'Sektör', (g) => g.r.pick(g.lists.industries)),
  t('employeeCount', 'company', 'Employees', 'Çalışan sayısı', (g) => int(g.r.int(1, 5000))),
  t('foundedYear', 'company', 'Founded (year)', 'Kuruluş yılı', (g) => int(g.r.int(1950, 2025))),
  t('taxId', 'company', 'Tax number (fake)', 'Vergi numarası (sahte)', (g) => `000${digits(g.r, '#######')}`),
  // commerce
  t('productName', 'commerce', 'Product', 'Ürün', (g) => {
    const adjective = g.r.pick(g.lists.productAdjectives)
    const product = g.r.pick(g.lists.products)
    if (g.lists.productText) return g.lists.productText(adjective, product)
    return g.lists.adjectiveAfter ? `${product} ${adjective}` : `${adjective}${joinOf(g)}${product}`
  }),
  t('productAdjective', 'commerce', 'Product adjective', 'Ürün sıfatı', (g) =>
    g.r.pick(g.lists.productAdjectives),
  ),
  t('category', 'commerce', 'Category', 'Kategori', (g) => g.r.pick(g.lists.categories)),
  t('price', 'commerce', 'Price (double)', 'Fiyat (double)', (g) => double(g.r.int(100, 99_999) / 100)),
  t('currency', 'commerce', 'Currency code', 'Para birimi kodu', (g) => g.r.pick(CURRENCIES)),
  t('sku', 'commerce', 'SKU', 'Stok kodu', (g) => `${hex(g.r, 3).toUpperCase()}-${g.r.int(1000, 9999)}`),
  t('quantity', 'commerce', 'Quantity (1–20)', 'Adet (1–20)', (g) => int(g.r.int(1, 20))),
  t('rating', 'commerce', 'Rating (1–5)', 'Puan (1–5)', (g) => int(g.r.int(1, 5))),
  t('discount', 'commerce', 'Discount (%)', 'İndirim (%)', (g) =>
    int(g.r.pick([0, 5, 10, 15, 20, 25, 30, 50])),
  ),
  t('orderStatus', 'commerce', 'Order status', 'Sipariş durumu', (g) => g.r.pick(g.lists.statuses)),
  // finance
  t('amount', 'finance', 'Amount (double)', 'Tutar (double)', (g) => double(g.r.int(1, 1_000_000) / 100)),
  t('amountDecimal', 'finance', 'Amount (Decimal128)', 'Tutar (Decimal128)', (g) =>
    decimal((g.r.int(1, 1_000_000) / 100).toFixed(2)),
  ),
  t('balance', 'finance', 'Balance (may be negative)', 'Bakiye (eksi olabilir)', (g) =>
    double(g.r.int(-500_000, 5_000_000) / 100),
  ),
  t(
    'iban',
    'finance',
    'IBAN-like (fake)',
    'IBAN benzeri (sahte)',
    (g) => `XX00 TEST ${digits(g.r, '#### #### #### ####')}`,
  ),
  t(
    'accountNumber',
    'finance',
    'Account number (fake)',
    'Hesap numarası (sahte)',
    (g) => `000-${digits(g.r, '########')}`,
  ),
  t('transactionType', 'finance', 'Transaction type', 'İşlem türü', (g) => g.r.pick(TRANSACTIONS)),
  t('creditScore', 'finance', 'Credit score (300–850)', 'Kredi notu (300–850)', (g) =>
    int(g.r.int(300, 850)),
  ),
  t('exchangeRate', 'finance', 'Exchange rate', 'Döviz kuru', (g) => double(g.r.int(50, 5000) / 100)),
  // date
  t('pastDate', 'date', 'Date in the past year', 'Geçen yıl içinde bir tarih', (g) =>
    date(now(g) - g.r.next() * 365 * DAY),
  ),
  t('recentDate', 'date', 'Date in the past week', 'Geçen hafta içinde bir tarih', (g) =>
    date(now(g) - g.r.next() * 7 * DAY),
  ),
  t('futureDate', 'date', 'Date in the next year', 'Gelecek yıl içinde bir tarih', (g) =>
    date(now(g) + g.r.next() * 365 * DAY),
  ),
  t('soonDate', 'date', 'Date in the next week', 'Gelecek hafta içinde bir tarih', (g) =>
    date(now(g) + g.r.next() * 7 * DAY),
  ),
  t('anyDate', 'date', 'Date (2000–2030)', 'Tarih (2000–2030)', (g) =>
    date(Date.UTC(2000, 0, 1) + g.r.next() * (Date.UTC(2030, 0, 1) - Date.UTC(2000, 0, 1))),
  ),
  t('dateString', 'date', 'Date as text (YYYY-MM-DD)', 'Metin tarih (YYYY-AA-GG)', (g) =>
    new Date(now(g) - g.r.next() * 365 * DAY).toISOString().slice(0, 10),
  ),
  t('isoString', 'date', 'Date and time as ISO text', 'ISO metin tarih ve saat', (g) =>
    new Date(Math.trunc(now(g) - g.r.next() * 365 * DAY)).toISOString(),
  ),
  t('unixSeconds', 'date', 'Unix time (seconds)', 'Unix zamanı (saniye)', (g) =>
    long(Math.trunc((now(g) - g.r.next() * 365 * DAY) / 1000)),
  ),
  t('unixSecondsInt', 'date', 'Unix time (seconds, int32)', 'Unix zamanı (saniye, int32)', (g) =>
    int(Math.trunc((now(g) - g.r.next() * 365 * DAY) / 1000)),
  ),
  t('unixMillis', 'date', 'Unix time (milliseconds)', 'Unix zamanı (milisaniye)', (g) =>
    long(Math.trunc(now(g) - g.r.next() * 365 * DAY)),
  ),
  t(
    'time',
    'date',
    'Time (HH:MM)',
    'Saat (SS:DD)',
    (g) => `${String(g.r.int(0, 23)).padStart(2, '0')}:${String(g.r.int(0, 59)).padStart(2, '0')}`,
  ),
  t('timestamp', 'date', 'Timestamp (BSON)', 'Zaman damgası (BSON)', (g) => ({
    $timestamp: { t: Math.trunc((now(g) - g.r.next() * 365 * DAY) / 1000), i: g.r.int(1, 100) },
  })),
  t('weekday', 'date', 'Weekday', 'Haftanın günü', (g) => g.r.pick(g.lists.weekdays)),
  t('month', 'date', 'Month', 'Ay', (g) => g.r.pick(g.lists.months)),
  t('year', 'date', 'Year', 'Yıl', (g) => int(g.r.int(2000, 2030))),
  // number
  t('smallInt', 'number', 'Integer (0–10)', 'Tam sayı (0–10)', (g) => int(g.r.int(0, 10))),
  t('int', 'number', 'Integer (0–100)', 'Tam sayı (0–100)', (g) => int(g.r.int(0, 100))),
  t('int1000', 'number', 'Integer (0–1,000)', 'Tam sayı (0–1.000)', (g) => int(g.r.int(0, 1000))),
  t('bigInt', 'number', 'Integer (0–1,000,000)', 'Tam sayı (0–1.000.000)', (g) => int(g.r.int(0, 1_000_000))),
  t('negativeInt', 'number', 'Integer (−100–100)', 'Tam sayı (−100–100)', (g) => int(g.r.int(-100, 100))),
  t('long', 'number', 'Long', 'Long', (g) =>
    long(BigInt(g.r.int(0, 2 ** 30)) * 4096n + BigInt(g.r.int(0, 4095))),
  ),
  t('float', 'number', 'Number (0–1)', 'Sayı (0–1)', (g) => double(g.r.next())),
  t('double', 'number', 'Number (0–1,000)', 'Sayı (0–1.000)', (g) => double(g.r.next() * 1000)),
  t('decimal', 'number', 'Decimal128 (0–1,000)', 'Decimal128 (0–1.000)', (g) =>
    decimal((g.r.next() * 1000).toFixed(4)),
  ),
  t('percent', 'number', 'Percent (0–100)', 'Yüzde (0–100)', (g) => double(g.r.next() * 100)),
  // text
  t('word', 'text', 'Word', 'Sözcük', (g) => g.r.pick(g.lists.words)),
  t('words', 'text', 'A few words', 'Birkaç sözcük', (g) => words(g, g.r.int(2, 4)).join(joinOf(g))),
  t('sentence', 'text', 'Sentence', 'Cümle', (g) => sentence(g)),
  t('paragraph', 'text', 'Paragraph', 'Paragraf', (g) =>
    Array.from({ length: g.r.int(3, 5) }, () => sentence(g)).join(joinOf(g)),
  ),
  t('title', 'text', 'Title', 'Başlık', (g) => words(g, g.r.int(2, 5)).map(cap).join(joinOf(g))),
  t(
    'lorem',
    'text',
    'Lorem ipsum',
    'Lorem ipsum',
    (g) => `${cap(Array.from({ length: g.r.int(6, 12) }, () => g.r.pick(LOREM)).join(' '))}.`,
  ),
  t('tags', 'text', 'Tags (list)', 'Etiketler (liste)', (g) => [...new Set(words(g, g.r.int(1, 4)))]),
  t('colorName', 'text', 'Colour name', 'Renk adı', (g) => g.r.pick(g.lists.colors)),
  // identifier
  t('objectId', 'identifier', 'ObjectId', 'ObjectId', (g) => ({
    $oid: `${Math.trunc((now(g) - g.r.next() * 365 * DAY) / 1000)
      .toString(16)
      .padStart(8, '0')}${hex(g.r, 16)}`,
  })),
  t('uuid', 'identifier', 'UUID', 'UUID', (g) => {
    const b = uuidBytes(g.r)
    return { $binary: { base64: btoa(String.fromCharCode(...b)), subType: '04' } }
  }),
  t('uuidString', 'identifier', 'UUID as text', 'Metin UUID', (g) => uuidText(uuidBytes(g.r))),
  t('shortId', 'identifier', 'Short id (8 characters)', 'Kısa kimlik (8 karakter)', (g) => hex(g.r, 8)),
  t('sequence', 'identifier', 'Sequence (1, 2, 3…)', 'Sıra (1, 2, 3…)', (g) => int(g.index + 1)),
  t(
    'code',
    'identifier',
    'Code (ABC-1234)',
    'Kod (ABC-1234)',
    (g) =>
      `${Array.from({ length: 3 }, () => String.fromCharCode(65 + g.r.int(0, 25))).join('')}-${g.r.int(1000, 9999)}`,
  ),
  t('hexId', 'identifier', 'Hex id (24 characters)', 'Onaltılık kimlik (24 karakter)', (g) => hex(g.r, 24)),
  t(
    'trackingNumber',
    'identifier',
    'Tracking number (fake)',
    'Takip numarası (sahte)',
    (g) => `TEST${digits(g.r, '############')}`,
  ),
  // boolean
  t('boolean', 'boolean', 'True or false', 'Doğru ya da yanlış', (g) => g.r.chance(0.5)),
  t('mostlyTrue', 'boolean', 'Mostly true (90%)', 'Çoğunlukla doğru (%90)', (g) => g.r.chance(0.9)),
  t('mostlyFalse', 'boolean', 'Mostly false (10% true)', 'Çoğunlukla yanlış (%10 doğru)', (g) =>
    g.r.chance(0.1),
  ),
  // other
  t('pngImage', 'other', 'PNG avatar (bytes)', 'PNG avatar (bayt)', (g) => ({
    $binary: { base64: g.r.pick(AVATARS), subType: '00' },
  })),
  t('bytes', 'other', 'Random bytes', 'Rastgele baytlar', (g) => {
    const b = Array.from({ length: g.r.int(16, 64) }, () => g.r.int(0, 255))
    return { $binary: { base64: btoa(String.fromCharCode(...b)), subType: '00' } }
  }),
  t('existing', 'other', 'One of the existing values', 'Var olan değerlerden biri', (g) =>
    g.existing?.length ? g.r.pick(g.existing) : null,
  ),
  t('constant', 'other', 'This text', 'Bu metin', (g) => g.constant ?? ''),
  t('null', 'other', 'null', 'null', () => null),
  t('emptyString', 'other', 'Empty text', 'Boş metin', () => ''),
  t('emptyArray', 'other', 'Empty list', 'Boş liste', () => []),
  t('emptyObject', 'other', 'Empty object', 'Boş nesne', () => ({})),
]

export const templateOf = (id: string): Template | undefined => TEMPLATES.find((x) => x.id === id)
