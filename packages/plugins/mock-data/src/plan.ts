// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { mainType, typeOfEjson, type FieldShape } from '../../kit/src/shape'
import { EN } from './data/lists'
import { rand } from './prng'
import { TEMPLATES, templateOf } from './templates'

/**
 * Plugins wave 3 (spec §3): which test values each field gets — chosen by its name, else by its
 * type, and changed by the user. A field hidden from the user is listed with no type guessed: its
 * template is "sentence" (text) until the user picks one. `_id` is left to the server.
 */
export interface FieldPlan {
  /** As the shape names it: `items[].qty`. */
  path: string
  include: boolean
  template: string
  hidden: boolean
  /** The type seen, for the list ("hidden" for a hidden field). */
  seen: string
  /** Its sampled values, for "one of the existing values" (few, repeated, not hidden). */
  existing?: string[]
  /** For "this text". */
  constant?: string
}

/**
 * A key's words, lower case, joined by `_`: `dateOfBirth` → `date_of_birth`, `IPAddress` →
 * `ip_address`, `email2` → `email_2`. Rules match whole words (wave 3 review: `tel` matched
 * `hotelName`; second review: a number after a word hid it, `email2` read as an unknown word).
 */
export const wordsOf = (key: string): string =>
  key
    .replace(/\[\]$/, '')
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1_$2')
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, '$1_$2')
    .replace(/(\p{L})(\p{N})/gu, '$1_$2')
    .replace(/(\p{N})(\p{L})/gu, '$1_$2')
    .toLowerCase()
    // A dotted capital I lowered (`İ`) keeps a combining dot: dropped, so `İl` reads `il`.
    .replace(/̇/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '')

/** Any of these words, anywhere among the key's. */
const anyWords = (alts: string) => new RegExp(`(?:^|_)(?:${alts})(?:_|$)`)
/** The key's last words. */
const lastWords = (alts: string) => new RegExp(`(?:^|_)(?:${alts})$`)
/** The key's words, all of them. */
const whole = (alts: string) => new RegExp(`^(?:${alts})$`)

/** A field's name read for what it holds (its last key's words), first match wins. */
export const RULES: Array<[RegExp, string]> = [
  [anyWords('e_?mail|eposta|e_?posta'), 'email'],
  [whole('first_?name|given_?name|fname|ad|adi|isim'), 'firstName'],
  [anyWords('last_?name|surname|family_?name|lname|soyad|soyadi'), 'lastName'],
  [whole('name|full_?name|display_?name|ad_?soyad|adsoyad'), 'fullName'],
  [lastWords('user_?name|login|handle'), 'username'],
  [anyWords('phone|tel|gsm|mobile|telefon|cep'), 'phone'],
  [whole('city|town|sehir|şehir|il'), 'city'],
  [whole('country|ulke|ülke'), 'country'],
  [anyWords('country_?code'), 'countryCode'],
  [whole('region|state|province|bolge|bölge'), 'region'],
  // Before addresses: `ip_address` is an IP.
  [whole('ip|ip_?addr|ip_?address|ipv_?4|ip_?v_?4'), 'ipv4'],
  [anyWords('street_?address|address|adres|adresi'), 'streetAddress'],
  [whole('street|sokak|cadde'), 'street'],
  [anyWords('zip|zip_?code|postal|postal_?code|post_?code|posta_?kodu'), 'postalCode'],
  [whole('lat|latitude|enlem'), 'latitude'],
  [whole('lng|lon|long|longitude|boylam'), 'longitude'],
  [lastWords('location|geo|konum|coordinates|coords|loc'), 'geoPoint'],
  [lastWords('time_?zone|tz'), 'timeZone'],
  [lastWords('url|website|web_?site|link|homepage'), 'url'],
  [lastWords('avatar|avatar_?url|photo_?url|image_?url'), 'avatarUrl'],
  [anyWords('user_?agent'), 'userAgent'],
  [anyWords('company|firma|sirket|şirket|employer'), 'companyName'],
  [anyWords('department|departman|bolum|bölüm'), 'department'],
  [anyWords('job|job_?title|position|unvan|ünvan'), 'jobTitle'],
  [anyWords('industry|sektor|sektör'), 'industry'],
  [whole('product|product_?name|urun|ürün'), 'productName'],
  [anyWords('category|categories|kategori'), 'category'],
  [anyWords('price|cost|fiyat|unit_?price'), 'price'],
  [anyWords('amount|total|tutar|toplam|balance|bakiye'), 'amount'],
  [anyWords('currency|para_?birimi'), 'currency'],
  [lastWords('qty|quantity|adet|stock|count'), 'quantity'],
  [whole('sku|stok_?kodu'), 'sku'],
  [lastWords('rating|score|puan|stars'), 'rating'],
  [anyWords('discount|indirim'), 'discount'],
  [lastWords('status|state|durum'), 'orderStatus'],
  [anyWords('birth|birth_?date|birthday|dob|dogum|doğum'), 'birthDate'],
  [whole('age|yas|yaş'), 'age'],
  [anyWords('gender|sex|cinsiyet'), 'gender'],
  [
    lastWords(
      '(?:created|updated|modified|deleted|last_?seen|last_?login|olusturma|oluşturma)(?:_?(?:at|on|date|time))?',
    ),
    'pastDate',
  ],
  [lastWords('(?:expires?|due|deadline|scheduled|son_?tarih)(?:_?(?:at|on|date))?'), 'futureDate'],
  [lastWords('date|tarih|time|zaman'), 'pastDate'],
  [lastWords('uuid|guid'), 'uuidString'],
  [lastWords('code|kod|kodu'), 'code'],
  [lastWords('iban'), 'iban'],
  [whole('title|baslik|başlık|subject|konu'), 'title'],
  [lastWords('description|desc|aciklama|açıklama|summary|ozet|özet'), 'sentence'],
  [lastWords('note|notes|comment|comments|bio|about|not|yorum'), 'sentence'],
  [lastWords('body|content|text|icerik|içerik'), 'paragraph'],
  [lastWords('tags|labels|etiketler|keywords'), 'tags'],
  [lastWords('color|colour|renk'), 'colorName'],
  [/^(?:is|has|can)_./, 'boolean'],
  [whole('active|enabled|verified|deleted|aktif|onayli|onaylı'), 'boolean'],
  [lastWords('slug'), 'slug'],
  [anyWords('password|parola|sifre|şifre'), 'password'],
]

/** By type, where the name says nothing. */
const BY_TYPE: Record<string, string> = {
  string: 'words',
  int32: 'int1000',
  long: 'long',
  double: 'double',
  decimal128: 'decimal',
  boolean: 'boolean',
  date: 'pastDate',
  objectId: 'objectId',
  uuid: 'uuid',
  array: 'tags',
  null: 'null',
  binary: 'bytes',
  object: 'emptyObject',
  timestamp: 'timestamp',
}

/** A kind of value: numbers of any width are one kind. */
const kindOf = (type: string) => (['int32', 'long', 'double', 'decimal128'].includes(type) ? 'number' : type)
/** Each template's type, from one value it makes. */
const TYPES = new Map(
  TEMPLATES.map((x) => [x.id, typeOfEjson(x.make({ r: rand(1), lists: EN, index: 0 }))] as const),
)
/** Groups whose templates write one thing in different kinds (a date as a date, text or a number). */
const SAME_MEANING = new Set(['date', 'identifier'])
/** A field of bytes named for a picture. */
const IMAGE = anyWords(
  'avatar|photo|photos|image|images|picture|thumbnail|thumb|logo|icon|resim|foto|fotograf|fotoğraf|gorsel|görsel',
)
const lastKey = (path: string) => path.split('.').pop() ?? ''

/** The template a field's name calls for, if any. */
export function namedTemplate(path: string): string | null {
  const words = wordsOf(lastKey(path))
  return RULES.find(([re]) => re.test(words))?.[1] ?? null
}

/**
 * The template a field gets: by its name, else its type ("sentence" for one hidden or unknown). A
 * name never changes the kind of value a field holds (wave 3 review: avatars of bytes were given web
 * addresses): a date kept as text gets dates as text, a picture of bytes PNG bytes, a date kept as
 * an int32 Unix time an int32.
 */
export function templateFor(field: Pick<FieldShape, 'path' | 'types' | 'hidden'>): string {
  // Hidden: no type is guessed, not even from its name (spec §3).
  if (field.hidden) return 'sentence'
  const named = namedTemplate(field.path)
  const type = field.types[0]?.type
  if (named && (!type || type === 'null' || kindOf(TYPES.get(named) ?? '') === kindOf(type))) return named
  if (!type) return 'sentence'
  const kind = kindOf(type)
  if (kind === 'binary' && IMAGE.test(wordsOf(lastKey(field.path)))) return 'pngImage'
  if (named === 'geoPoint' && kind === 'array') return 'lngLatPair'
  // A template that makes a date writes a date, whatever its group: a birth date kept as text gets
  // dates as text (second review).
  const group = named ? (TYPES.get(named) === 'date' ? 'date' : templateOf(named)?.group) : undefined
  const inGroup = group && SAME_MEANING.has(group) ? TEMPLATES.filter((x) => x.group === group) : []
  const near =
    inGroup.find((x) => TYPES.get(x.id) === type) ??
    inGroup.find((x) => kindOf(TYPES.get(x.id) ?? '') === kind)
  return near?.id ?? BY_TYPE[type] ?? 'sentence'
}

/**
 * Templates whose field is better made from its own few values (a status, a category): a person's
 * name, e-mail, phone or address never is — real values are never copied into test data for those.
 */
const CATEGORICAL = new Set([
  'orderStatus',
  'category',
  'gender',
  'currency',
  'country',
  'countryCode',
  'region',
  'department',
  'industry',
  'colorName',
  'timeZone',
  'transactionType',
])

/**
 * Words of what tells one person or thing apart, and of a person (second review: an owner's or a
 * customer's name came back twice and was copied): their values are never copied, however few.
 */
const IDENTIFYING = anyWords(
  [
    'id|ids|no|nr|num|number|code|kod|kodu|tc|tckn|kimlik|passport|pasaport|ssn|sin|nin|iban|card|kart',
    'account|hesap|token|key|secret|serial|seri|plate|plaka|vin|license|licence|ehliyet|tax|vergi',
    'uuid|guid|hash|password|parola|sifre|şifre',
    'person|people|owner|owners|author|authors|customer|customers|client|clients|user|users|member',
    'members|employee|employees|contact|contacts|manager|managers|buyer|seller|recipient|sender',
    'patient|student|teacher|doctor|driver|assignee|assigned|reporter|reviewer|by|kisi|kişi|musteri',
    'müşteri|sahip|sahibi|yazar|kullanici|kullanıcı|uye|üye|personel|calisan|çalışan|alici|alıcı',
    'gonderen|gönderen|hasta|ogrenci|öğrenci|ogretmen|öğretmen|doktor|surucu|sürücü|yonetici|yönetici',
  ].join('|'),
)

/** How many times each short text value was seen at each path, as the kit's shape walks documents. */
export type ValueCounts = Map<string, Map<string, number>>
const COUNT_DEPTH = 4

/** Each text value of the sampled documents, counted per path (`items[].sku` for arrays of objects). */
export function valueCounts(documents: readonly unknown[]): ValueCounts {
  const out: ValueCounts = new Map()
  const add = (path: string, value: string) => {
    let m = out.get(path)
    if (!m) out.set(path, (m = new Map()))
    m.set(value, (m.get(value) ?? 0) + 1)
  }
  const walk = (o: Record<string, unknown>, base: string, depth: number): void => {
    if (depth >= COUNT_DEPTH) return
    for (const [key, value] of Object.entries(o)) {
      const path = base ? `${base}.${key}` : key
      const type = typeOfEjson(value)
      if (type === 'string') add(path, value as string)
      else if (type === 'object') walk(value as Record<string, unknown>, path, depth + 1)
      else if (type === 'array')
        for (const item of value as unknown[])
          if (typeOfEjson(item) === 'object') walk(item as Record<string, unknown>, `${path}[]`, depth + 1)
    }
  }
  for (const doc of documents)
    if (doc && typeof doc === 'object' && !Array.isArray(doc)) walk(doc as Record<string, unknown>, '', 0)
  return out
}

/**
 * Whether "one of the existing values" is offered for a field (wave 3 review: real ids were
 * copied): only a field named for a category, or named for nothing and not for an identifier or a
 * person, whose sampled values each come back — every one of them at least twice (second review: an
 * average let values seen once through). Without the documents to count in, never.
 */
function offersExisting(f: FieldShape, counts: ValueCounts | null): f is FieldShape & { examples: string[] } {
  if (f.hidden || !f.examples?.length || !counts) return false
  const named = namedTemplate(f.path)
  if (named && !CATEGORICAL.has(named)) return false
  if (IDENTIFYING.test(wordsOf(lastKey(f.path)))) return false
  const seen = counts.get(f.path)
  return f.examples.every((v) => (seen?.get(v) ?? 0) >= 2)
}

/** A field's first template: its own few values where that fits, else by its name or type. */
function firstTemplate(f: FieldShape, counts: ValueCounts | null): string {
  if (offersExisting(f, counts) && f.examples.length <= 8) return 'existing'
  return templateFor(f)
}

/** Whether `path` lies below `parent` (in it, or in its array of objects). */
const below = (path: string, parent: string) =>
  path.startsWith(`${parent}.`) || path.startsWith(`${parent}[].`)

const GEO_TYPES = new Set(['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon'])
/**
 * GeoJSON objects (`{ type: 'Point', coordinates: [...] }`): made whole as one point, never as a
 * word and a list of tags (wave 3 review: a 2dsphere index refused every document).
 */
function geoJsonPaths(shape: readonly FieldShape[]): Set<string> {
  const out = new Set<string>()
  for (const f of shape) {
    if (f.hidden || mainType(f) !== 'object') continue
    const children = shape.filter((c) => below(c.path, f.path))
    const type = children.find((c) => c.path === `${f.path}.type`)
    const coordinates = children.find((c) => c.path === `${f.path}.coordinates`)
    if (
      type?.examples?.length &&
      type.examples.every((v) => GEO_TYPES.has(v)) &&
      coordinates &&
      mainType(coordinates) === 'array' &&
      children.every((c) => c === type || c === coordinates || c.path === `${f.path}.bbox`)
    )
      out.add(f.path)
  }
  return out
}

/**
 * The fields a test document is made of, from the collection's shape — and the sampled documents,
 * to count how often each value comes back (without them, no existing value is offered).
 */
export function plansOf(shape: readonly FieldShape[], documents?: readonly unknown[]): FieldPlan[] {
  const counts = documents ? valueCounts(documents) : null
  const geo = geoJsonPaths(shape)
  return (
    shape
      .filter((f) => f.path !== '_id' && !f.path.startsWith('_id.'))
      .filter((f) => ![...geo].some((g) => below(f.path, g)))
      // A field holding others is made by its fields, a GeoJSON object whole.
      .filter((f) => geo.has(f.path) || !shape.some((c) => below(c.path, f.path)))
      .map((f) => ({
        path: f.path,
        include: true,
        template: geo.has(f.path) ? 'geoPoint' : firstTemplate(f, counts),
        hidden: f.hidden,
        seen: mainType(f),
        ...(offersExisting(f, counts) ? { existing: f.examples } : {}),
      }))
  )
}
