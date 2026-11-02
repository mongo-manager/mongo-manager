/**
 * Personal data finder (research 2026-10-28: forum and repository requests for finding personal
 * data before it leaks, and for the masking rules that hide it): which fields of a collection hold
 * personal data, from a random sample — by their values (e-mail addresses, phone numbers, card
 * numbers in a card network's range that pass the Luhn check, IBANs that pass mod 97, identity
 * numbers that pass their checksum, IP addresses, password hashes and keys) and by their names (a
 * person's name, an address, a birth date, a password or a token). Values are read only to be told
 * apart: none is shown unmasked.
 */
import { hiddenMatch } from '../../kit/src/shape'
import { isHiddenChar } from '../../../shared/src/chars'
import * as X from './vocab'

export type Kind =
  'email' | 'phone' | 'card' | 'iban' | 'nationalId' | 'ip' | 'name' | 'address' | 'birthDate' | 'secret'
export type Confidence = 'high' | 'medium' | 'low'
export const CONFIDENCES: Confidence[] = ['high', 'medium', 'low']

/** Kinds a value shows, the strictest first (the others only a field's name tells). */
const BY_VALUE: readonly Kind[] = ['secret', 'email', 'iban', 'card', 'nationalId', 'ip', 'phone']

export interface Finding {
  /** The field as a rule names it: its keys joined by ".", arrays left out. */
  field: string
  segments: string[]
  kind: Kind
  confidence: Confidence
  /** Values sampled (empty ones left out), and of them those that look like the kind. */
  values: number
  matched: number
  /** Whether its name says so. */
  named: boolean
  /** Up to two of its values, masked. */
  examples: string[]
  /** Whether a rule may name it: every key a plain name (no dot, no $, no wildcard, nothing hidden). */
  nameable: boolean
}

export interface Scan {
  findings: Finding[]
  /** Fields personal-data rules hide from the user: their values came as ***, never read. */
  hidden: string[]
  sampled: number
}

type Doc = Record<string, unknown>
const isDoc = (v: unknown): v is Doc => v !== null && typeof v === 'object' && !Array.isArray(v)

/** How deep a field is followed, and values kept per field (of every kind, all told). */
const DEPTH = 6
export const PER_FIELD = 200
/** A value's text, at most: a token or a key is longer than a name (review 2026-10-29: a JWT). */
const MAX_TEXT = 8192

interface Text {
  text: string
  /** It came as a number (a phone number is one only where its field's name says so). */
  numeric: boolean
}
interface Sampled {
  segments: string[]
  texts: Text[]
  /** Values that are dates ($date). */
  dates: number
  /** Values of any other kind (booleans, ids, objects…): counted, never classified. */
  other: number
  /** Of them, the yes-or-no ones. */
  flags: number
}

/** A value as text to classify: a string, or a number's digits; null for anything else. */
function textOf(v: unknown): Text | null {
  if (typeof v === 'string') return { text: v.trim().slice(0, MAX_TEXT), numeric: false }
  if (typeof v === 'number') return Number.isFinite(v) ? { text: String(v), numeric: true } : null
  if (isDoc(v))
    for (const k of ['$numberInt', '$numberLong', '$numberDouble', '$numberDecimal'])
      if (typeof v[k] === 'string')
        // A whole number stored as a double comes as 5321234567.0: read as the whole number it is.
        return { text: (v[k] as string).replace(/^(-?[0-9]+)[.]0$/, '$1'), numeric: true }
  return null
}
const isDate = (v: unknown) => isDoc(v) && Object.hasOwn(v, '$date')
/** Extended JSON's own keys: a value of its type (an id, a date, a number…), not a document of fields. */
const EJSON_KEYS = new Set([
  '$oid',
  '$date',
  '$numberInt',
  '$numberLong',
  '$numberDouble',
  '$numberDecimal',
  '$binary',
  '$uuid',
  '$regularExpression',
  '$timestamp',
  '$minKey',
  '$maxKey',
  '$code',
  '$scope',
  '$symbol',
  '$dbPointer',
  '$undefined',
])
const isTyped = (v: Doc) => {
  const keys = Object.keys(v)
  return keys.length > 0 && keys.every((k) => EJSON_KEYS.has(k))
}

/** The sampled values of each field, arrays left out of its name, in the order first met. */
export function collect(docs: readonly unknown[]): Map<string, Sampled> {
  const fields = new Map<string, Sampled>()
  const slot = (segments: string[]) => {
    const key = JSON.stringify(segments)
    let s = fields.get(key)
    if (!s) fields.set(key, (s = { segments, texts: [], dates: 0, other: 0, flags: 0 }))
    return s
  }
  const value = (v: unknown, segments: string[], depth: number): void => {
    // Nothing there: no value (an empty text neither).
    if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) return
    if (Array.isArray(v)) {
      for (const x of v.slice(0, 50)) value(x, segments, depth)
      return
    }
    if (isDoc(v) && !isTyped(v)) {
      if (depth >= DEPTH) return
      for (const [k, x] of Object.entries(v)) value(x, [...segments, k], depth + 1)
      return
    }
    if (!segments.length) return
    const s = slot(segments)
    if (s.texts.length + s.dates + s.other >= PER_FIELD) return
    const text = textOf(v)
    if (text !== null) s.texts.push(text)
    else if (isDate(v)) s.dates++
    else {
      s.other++
      if (typeof v === 'boolean') s.flags++
    }
  }
  for (const d of docs)
    if (isDoc(d)) for (const [k, x] of Object.entries(d)) if (k !== '_id') value(x, [k], 1)
  return fields
}

// ---- values

const digitsOf = (s: string) => s.replace(/\D/g, '')

/** The Luhn check of a card number. */
export function luhn(digits: string): boolean {
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i])
    if (i % 2 === 1) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
  }
  return sum % 10 === 0
}

/** A card number: in a card network's range, of its length, passing the Luhn check. */
export function isCard(text: string): boolean {
  if (!/^[\d -]+$/.test(text)) return false
  const d = digitsOf(text)
  // A run of one digit in a network's range never passes Luhn: no check of its own.
  if (d.length < 13 || d.length > 19 || !luhn(d)) return false
  const n = (k: number) => Number(d.slice(0, k))
  const len = d.length
  if (d[0] === '4') return len === 13 || len === 16 || len === 19 // Visa
  if ((n(2) >= 51 && n(2) <= 55) || (n(4) >= 2221 && n(4) <= 2720)) return len === 16 // Mastercard
  if (n(4) >= 2200 && n(4) <= 2204) return len === 16 // Mir
  if (n(2) === 34 || n(2) === 37) return len === 15 // American Express
  if (n(4) === 6011 || n(2) === 65 || (n(3) >= 644 && n(3) <= 649)) return len >= 16 // Discover
  if (n(2) === 62) return len >= 16 // UnionPay
  // Diners Club.
  if ((n(3) >= 300 && n(3) <= 305) || n(2) === 36 || n(2) === 38 || n(2) === 39) return len >= 14 && len <= 16
  if (n(4) >= 3528 && n(4) <= 3589) return len >= 16 // JCB
  if (n(4) === 9792) return len === 16 // Troy
  return false
}

/** An IBAN passing its mod-97 check (and Turkey's length). */
export function isIban(text: string): boolean {
  const s = text.replace(/[ -]/g, '').toUpperCase()
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false
  if (s.startsWith('TR') && s.length !== 26) return false
  const moved = s.slice(4) + s.slice(0, 4)
  let rest = 0
  for (const c of moved) {
    const v = c >= 'A' && c <= 'Z' ? String(c.charCodeAt(0) - 55) : c
    for (const digit of v) rest = (rest * 10 + Number(digit)) % 97
  }
  return rest === 1
}

/** A Turkish identity number (its two check digits), or a US social security number as written. */
export function isNationalId(text: string): boolean {
  if (/^\d{11}$/.test(text) && text[0] !== '0') {
    const d = [...text].map(Number)
    const odd = d[0]! + d[2]! + d[4]! + d[6]! + d[8]!
    const even = d[1]! + d[3]! + d[5]! + d[7]!
    const tenth = (((odd * 7 - even) % 10) + 10) % 10
    const eleventh = d.slice(0, 10).reduce((a, b) => a + b, 0) % 10
    return d[9] === tenth && d[10] === eleventh
  }
  const ssn = /^(\d{3})-(\d{2})-(\d{4})$/.exec(text)
  return (
    !!ssn &&
    ssn[1] !== '000' &&
    ssn[1] !== '666' &&
    ssn[1]![0] !== '9' &&
    ssn[2] !== '00' &&
    ssn[3] !== '0000'
  )
}

export function isEmail(text: string): boolean {
  return text.length <= 254 && /^[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[A-Za-z]{2,}$/.test(text)
}

const V4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/
/** The groups of an IPv6 address: eight, or fewer around one "::". */
function isV6(text: string): boolean {
  if (!/^[0-9a-f:]+$/i.test(text) || text.includes(':::')) return false
  const halves = text.split('::')
  if (halves.length > 2) return false
  const groups = halves.flatMap((part) => (part ? part.split(':') : []))
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return false
  return halves.length === 2 ? groups.length <= 7 : groups.length === 8
}

/** An IPv4 or IPv6 address (IPv4 inside IPv6 too); never a MAC address (six groups) or a time. */
export function isIp(text: string): boolean {
  if (V4.test(text)) return true
  const mapped = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(text)
  if (mapped) return V4.test(mapped[2]!) && isV6(`${mapped[1]}0:0`)
  return isV6(text)
}

/**
 * A phone number: 9 to 15 digits, written as one (a +, a 00, separators, or a leading 0 before 9
 * or 10 digits). A bare number, or a number at all (a coordinate, an amount), only where its
 * field's name says so — and then a whole one (review 2026-10-28).
 */
export function isPhone(text: string, named: boolean, numeric = false): boolean {
  if (numeric) return named && /^\d{9,15}$/.test(text)
  if (!/^[+(\d][\d ().\-/]{6,23}$/.test(text)) return false
  // A decimal number (37.7749295) or a ZIP+4 code (12345-6789) is no phone number.
  if (/^\d+\.\d+$/.test(text) || /^\d{5}-\d{4}$/.test(text)) return false
  const d = digitsOf(text)
  if (d.length < 9 || d.length > 15 || /^(\d)\1+$/.test(d)) return false
  if (named) return true
  // Dots alone: groups of two to four digits (0532.123.45.67), never a version (10.0.19045.3803).
  const dotted = /^[0-9]{2,4}([.][0-9]{2,4}){2,}$/.test(text)
  return (
    text.startsWith('+') ||
    text.startsWith('00') ||
    /[ ()\-/]/.test(text) ||
    dotted ||
    /^0\d{9,10}$/.test(text)
  )
}

/** A password hash, a token or a key as what makes them writes them. */
export function isSecret(text: string): boolean {
  return (
    /^\$2[aby]?\$\d{2}\$[./A-Za-z0-9]{53}$/.test(text) || // bcrypt
    /^\$argon2(id|i|d)\$/.test(text) ||
    /^\$(scrypt|pbkdf2-sha\d+)\$/.test(text) ||
    /^eyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*$/.test(text) || // a JWT
    /^(AKIA|ASIA)[0-9A-Z]{16}$/.test(text) || // an AWS access key
    /^gh[pousr]_[A-Za-z0-9]{36,}$/.test(text) || // a GitHub token
    /^sk_(live|test)_[A-Za-z0-9]{16,}$/.test(text) ||
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)
  )
}

/** The kind a value looks like, if any (the strictest first). */
export function kindOfValue(text: string, phoneNamed: boolean, numeric = false): Kind | null {
  if (!numeric) {
    if (isSecret(text)) return 'secret'
    if (isEmail(text)) return 'email'
    if (isIban(text)) return 'iban'
  }
  if (isCard(text)) return 'card'
  if (isNationalId(text)) return 'nationalId'
  if (!numeric && isIp(text)) return 'ip'
  if (isPhone(text, phoneNamed, numeric)) return 'phone'
  return null
}

// ---- names

const FOLD = new Map([
  ['ç', 'c'],
  ['ğ', 'g'],
  ['ı', 'i'],
  ['ö', 'o'],
  ['ş', 's'],
  ['ü', 'u'],
  ['Ç', 'C'],
  ['Ğ', 'G'],
  ['İ', 'I'],
  ['Ö', 'O'],
  ['Ş', 'S'],
  ['Ü', 'U'],
])
/** A key's characters read, at most: a 60,000-letter key must not take seconds (review 2026-10-29). */
export const MAX_KEY = 256
/**
 * A key's words, lower case and folded: `phoneNumber2` → phone, number; `doğum_tarihi` → dogum,
 * tarihi; `kullanıcıAdı` → kullanici, adi (folded first, so Turkish letters split as any other).
 */
export function wordsOf(key: string): string[] {
  // Cut before and after NFKC (one character may become many); a half character cut is no letter.
  const folded = key
    .slice(0, MAX_KEY)
    .normalize('NFKC')
    .slice(0, MAX_KEY)
    .replace(/[çğıöşüÇĞİÖŞÜ]/g, (c) => FOLD.get(c) ?? c)
    // Other Latin accents off (é → e, ñ → n); Cyrillic and CJK keep their letters.
    .replace(/\p{Script=Latin}\p{M}*/gu, (c) =>
      c
        .normalize('NFD')
        .replace(/\p{M}/gu, '')
        .replace(/[ßøæœłđ]/gi, (x) => LATIN_EXTRA.get(x.toLowerCase()) ?? x),
    )
    .replace(/[ёЁ]/g, (c) => (c === 'ё' ? 'е' : 'Е'))
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, '$1 $2')
    .toLowerCase()
  const out: string[] = []
  for (const run of folded.split(NOT_LETTER))
    for (const chunk of run.match(CHUNK) ?? []) {
      if (CJK.test(chunk)) out.push(...cjkTokens(chunk))
      else out.push(chunk)
    }
  return out
}

const LATIN_EXTRA = new Map([
  ['ß', 'ss'],
  ['ø', 'o'],
  ['æ', 'ae'],
  ['œ', 'oe'],
  ['ł', 'l'],
  ['đ', 'd'],
])
const CJK_RANGE = String.raw`\u3005\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\u1100-\u11ff`
const NOT_LETTER = new RegExp(`[^a-z\u0400-\u04ff${CJK_RANGE}]+`, 'u')
const CHUNK = new RegExp(`[a-z]+|[\u0400-\u04ff]+|[${CJK_RANGE}]+`, 'gu')
const CJK = new RegExp(`[${CJK_RANGE}]`, 'u')

let cjkVocab: Set<string> | null = null
/** CJK has no spaces: a run is cut into the longest words the vocabulary knows (電話番号 → 電話, 番号). */
function cjkTokens(run: string): string[] {
  if (!cjkVocab) {
    const vocab = new Set<string>()
    cjkVocab = vocab
    const add = (w: string) => {
      if (CJK.test(w)) vocab.add(w)
    }
    for (const v of Object.values(X)) {
      if (Array.isArray(v)) v.forEach(add)
      else if (v instanceof Set) v.forEach(add)
      else if (v instanceof Map) [...v.keys()].forEach(add)
    }
  }
  const vocab = cjkVocab
  const chars = [...run]
  const out: string[] = []
  let unknown = ''
  for (let i = 0; i < chars.length;) {
    let hit = 0
    for (let n = Math.min(8, chars.length - i); n > 0; n--)
      if (vocab.has(chars.slice(i, i + n).join(''))) {
        hit = n
        break
      }
    if (!hit) unknown += chars[i++]
    else {
      if (unknown) out.push(unknown)
      unknown = ''
      out.push(chars.slice(i, i + hit).join(''))
      i += hit
    }
  }
  if (unknown) out.push(unknown)
  return out
}

/** Words after which a name says something about the data, not the data itself (emailVerified). */
const META = new Set([
  'verified',
  'confirmed',
  'enabled',
  'disabled',
  'count',
  'sent',
  'status',
  'type',
  'valid',
  'validated',
  'opt',
  'optin',
  'optout',
  'at',
  'date',
  'time',
  'on',
  'by',
  'template',
  'format',
  'domain',
  'provider',
  'settings',
  'prefs',
  'preferences',
  'notifications',
  'subscribed',
  'visible',
  'required',
  'length',
  'expires',
  'expiry',
  'changed',
  'updated',
  'created',
  'reset',
  'policy',
  'strength',
  'hint',
  'label',
  'field',
  'fields',
  'country',
  'code',
  'prefix',
  'extension',
  'ext',
  'version',
  'bounced',
  'bounce',
  'consent',
  'flag',
  'mask',
  'masked',
  'last',
  'attempts',
  'rules',
  'id',
  'ids',
  'kind',
  'source',
  'reminder',
  'algorithm',
  'algo',
  'scheme',
  'rounds',
  'set',
  'support',
  'supported',
  'only',
  'preferred',
  ...X.META_X,
])
const DATE_WORDS = new Set(['date', ...X.DATE_X])
/** First words of a yes-or-no field (isMobile, hasEmail). */
const FLAGS = new Set([
  'is',
  'has',
  'can',
  'should',
  'allow',
  'use',
  'show',
  'send',
  'needs',
  'no',
  ...X.FLAGS_X,
])
/** Words a field's name may end with after the word that says what it holds (phoneNumber). */
const TAILS = new Set(['number', 'no', 'num', 'nr', 'numara', 'numarasi', 'address', 'adresi', ...X.TAILS_X])
/** Who a name belongs to: customer.name, customerName, musteriAdi. */
const PERSON = new Set([
  'customer',
  'user',
  'person',
  'contact',
  'owner',
  'patient',
  'employee',
  'member',
  'client',
  'buyer',
  'recipient',
  'sender',
  'holder',
  'cardholder',
  'passenger',
  'guest',
  'student',
  'applicant',
  'driver',
  'musteri',
  'kullanici',
  'kisi',
  'uye',
  'hasta',
  'calisan',
  'ogrenci',
  'yolcu',
  'alici',
  'gonderen',
  ...X.PERSON_X,
])
const NAME_WORDS = new Set(['name', 'ad', 'adi', 'isim', 'ismi', ...X.NAME_WORDS_X])
/** First words of a name only of more than one character (명예회원 is an honorary member, no name). */
const NAME_WORDS_FIRST = new Set(X.NAME_WORDS_X.filter((w) => [...w].length > 1))
const NAMES_LAST = new Set(X.NAMES_LAST_X)
const NAMES = new Set([
  'firstname',
  'lastname',
  'surname',
  'fullname',
  'givenname',
  'familyname',
  'middlename',
  'maidenname',
  'forename',
  'adsoyad',
  'adsoyadi',
  'adisoyadi',
  'soyad',
  'soyadi',
  'soyisim',
  'soyismi',
  'isimsoyisim',
  'isimsoyad',
  ...X.NAMES_JOINED_X,
  ...X.NAMES_LAST_X,
])
const PHONE = new Set([
  'phone',
  'telephone',
  'tel',
  'mobile',
  'gsm',
  'cellphone',
  'telefon',
  'telefonu',
  'cep',
  'fax',
  'msisdn',
  ...X.PHONE_X,
])
const BIRTH = new Set(['birth', 'birthday', 'birthdate', 'dob', 'dogum', ...X.BIRTH_X])
/** Where one was born: an address, not a date. */
const PLACE = new Set([
  'place',
  'city',
  'country',
  'town',
  'location',
  'yeri',
  'yer',
  'sehir',
  'ulke',
  ...X.PLACE_X,
])
const ADDRESS_END = [
  'address',
  'addressline',
  'street',
  'streetaddress',
  'adres',
  'adresi',
  'sokak',
  'cadde',
  ...X.ADDRESS_END_X,
]
const POSTAL_END = ['postalcode', 'postcode', 'zipcode', 'postakodu', ...X.POSTAL_END_X]
const NOT_ADDRESS_END = [
  'macaddress',
  'serveraddress',
  'hostaddress',
  'ipaddress',
  'emailaddress',
  'mailaddress',
  'webaddress',
  'contractaddress',
  'bindaddress',
  'listenaddress',
  'remoteaddress',
  'localaddress',
  'walletaddress',
  'callbackaddress',
  'linkaddress',
  'urladdress',
  'redirectaddress',
  'proxyaddress',
  'gatewayaddress',
  'nodeaddress',
  'peeraddress',
  'networkaddress',
  'broadcastaddress',
  'multicastaddress',
  ...X.NOT_ADDRESS_END_X,
]
/** Identity numbers by their name alone, or (TAILED) before a "number" (kimlikNumarasi). */
const STRONG_ID_END = [
  'tckimlik',
  'tckimlikno',
  'nationalid',
  'nationalidentity',
  'passport',
  'pasaport',
  'socialsecurity',
  'taxid',
  ...X.STRONG_ID_END_X,
]
const STRONG_ID_WORDS = new Set(['ssn', 'tckn', 'vkn', 'nin', 'nino', ...X.STRONG_ID_WORDS_X])
const TAILED_ID_END = ['tc', 'kimlik', 'identity', 'vergi', 'tax', ...X.TAILED_ID_END_X]
const SECRET_END = [
  'password',
  'passwd',
  'pwd',
  'passcode',
  'passphrase',
  'secret',
  'clientsecret',
  'token',
  'accesstoken',
  'refreshtoken',
  'apikey',
  'privatekey',
  'secretkey',
  'accesskey',
  'sifre',
  'parola',
  ...X.SECRET_END_X,
]
const SECRET_ANY = new RegExp(`(password|sifre|parola|${X.SECRET_ANY_X.join('|')})`)
/** Tokens of a list or a stream, never anyone's (nextPageToken, a change stream's resume token). */
const NOT_SECRET_END = [
  'pagetoken',
  'nextpagetoken',
  'resumetoken',
  'csrftoken',
  'xsrftoken',
  'continuationtoken',
  'synctoken',
  'cursortoken',
  'nexttoken',
  'paginationtoken',
  ...X.NOT_SECRET_END_X,
]

const EMAIL_HEADS = new Set(['email', 'mail', 'eposta', ...X.EMAIL_X])
const CARD_HEADS = new Set(['card', 'kart', 'cc', ...X.CARD_HEADS_X])

/** Whether the last words, whole, make the phrase (tel_portable, not hotel_portable). */
function endsInWords(words: readonly string[], phrase: string): boolean {
  let tail = ''
  for (let i = words.length - 1; i >= 0 && tail.length < phrase.length; i--) {
    tail = words[i]! + tail
    if (tail === phrase) return true
  }
  return false
}

/** The kind a field's name says it holds, if any. */
export function kindOfName(segments: readonly string[]): Kind | null {
  const key = segments.at(-1) ?? ''
  const raw = wordsOf(key)
  if (!raw.length || FLAGS.has(raw[0]!)) return null
  // numero_de_telefono: the small words between are left out.
  const kept = raw.filter((w) => !X.LINKS.has(w))
  const all = kept.length ? kept : raw
  const joined = all.join('')
  const last = all.at(-1)!
  // Says something about the data: a word of META last, or "at" after one (senha_alterada_em).
  const meta = META.has(last) || (X.AT_X.has(last) && all.length > 1 && META.has(all.at(-2)!))
  // ipv4Address: digits the words leave out.
  if (/ipv[46]/i.test(key) && (all.length === 1 || ['address', 'addr', 'ip'].includes(last))) return 'ip'
  if (all.some((w) => BIRTH.has(w))) {
    // Where one was born, any word of it (placeOfBirth): an address.
    if (all.some((w) => PLACE.has(w))) return 'address'
    // nom_de_naissance is a (birth) name, not a date.
    if (all[0] === 'nom') return 'name'
    return meta && !DATE_WORDS.has(last) ? null : 'birthDate'
  }
  if (NOT_SECRET_END.some((e) => joined.endsWith(e))) return null
  // Endings that say it whatever their last word (postalCode); clave, senha as a whole last word.
  if (SECRET_END.some((e) => joined.endsWith(e)) || X.SECRET_LAST_X.has(last)) return 'secret'
  if (POSTAL_END.some((e) => joined.endsWith(e))) return 'address'
  // An identity number by its name, though it ends in "id" (nationalId, taxId).
  if (last === 'id' && STRONG_ID_END.some((e) => joined.endsWith(e))) return 'nationalId'
  if (meta) return null
  if (SECRET_ANY.test(joined) || all.some((w) => X.SECRET_WORDS_ANY_X.has(w))) return 'secret'
  // telefono_fijo, direccion_envio: a lead word of a kind, then only qualifiers.
  const lead = X.LEADS.get(all[0]!)
  if (lead && all.length > 1 && all.slice(1).every((w) => X.QUALIFIERS.has(w))) return lead
  // numero_tarjeta, номер_карты: the number word first.
  const base = all.length > 1 && X.LEAD_TAILS.has(all[0]!) ? all.slice(1) : all
  // phoneNumber: the word that says what it holds is before its tail.
  const words = base.length > 1 && TAILS.has(last) ? base.slice(0, -1) : base
  const tail = words.length < all.length
  // A number's tail, for a card's or an identity's (taxAddress, ccAddress are neither).
  const numbered = tail && !['address', 'adresi'].includes(last) && !X.ADDRESS_TAILS.has(last)
  const head = words.at(-1)!
  const core = words.join('')
  if (
    EMAIL_HEADS.has(head) ||
    core.endsWith('eposta') ||
    X.EMAIL_PHRASES_X.some((p) => endsInWords(words, p) || endsInWords(all, p))
  )
    return 'email'
  if (head === 'iban' || joined.includes('iban')) return 'iban'
  if (head === 'ip' || joined.endsWith('ipaddress')) return 'ip'
  if (PHONE.has(head) || X.PHONE_PHRASES_X.some((p) => endsInWords(all, p))) return 'phone'
  if (
    head === 'pan' ||
    core.endsWith('creditcard') ||
    core.endsWith('debitcard') ||
    X.CARD_END_X.some((e) => core.endsWith(e)) ||
    (numbered && CARD_HEADS.has(head))
  )
    return 'card'
  if (
    STRONG_ID_WORDS.has(head) ||
    STRONG_ID_END.some((e) => core.endsWith(e)) ||
    (numbered && TAILED_ID_END.some((e) => core.endsWith(e)))
  )
    return 'nationalId'
  if (NAMES.has(joined) || NAMES_LAST.has(last)) return 'name'
  // nombre_cliente, имя_клиента: the name word first, then who it belongs to.
  if (all.length > 1 && NAME_WORDS_FIRST.has(all[0]!) && PERSON.has(last)) return 'name'
  // A person's name: customerName, cardHolderName, customer.name, musteri.adi — not a product's.
  if (NAME_WORDS.has(last)) {
    const owner =
      all.length > 1 ? all.at(-2) : segments.length > 1 ? wordsOf(segments.at(-2)!).at(-1) : undefined
    if (owner && PERSON.has(owner)) return 'name'
  }
  if (
    head === 'zip' ||
    X.POSTAL_WORDS_X.has(last) ||
    X.ADDRESS_LAST_X.has(last) ||
    (ADDRESS_END.some((e) => joined.endsWith(e)) && !NOT_ADDRESS_END.some((e) => joined.endsWith(e)))
  )
    return 'address'
  return null
}

// ---- masked examples

const DOT = '•'
const dots = (n: number) => DOT.repeat(n)
/** A text's first character (a whole one: an emoji is not cut in two). */
const first = (s: string) => [...s][0] ?? ''

/** A value as shown: masked, so it says what it is but not whose. */
export function masked(kind: Kind, text: string): string {
  switch (kind) {
    case 'email': {
      // Split on the whole address, its top-level part shown only when short (review I2).
      const at = text.lastIndexOf('@')
      const domain = text.slice(at + 1)
      const tld = domain.slice(domain.lastIndexOf('.') + 1)
      const end = /^[a-z]{2,4}$/i.test(tld) ? tld : dots(3)
      return `${first(text)}${dots(3)}@${first(domain)}${dots(3)}.${end}`
    }
    case 'ip':
      return text.includes('.') && !text.includes(':')
        ? `${text.split('.')[0]}.${dots(3)}.${dots(3)}.${dots(3)}`
        : `${text.split(':')[0]}:${dots(3)}`
    case 'name':
    case 'address':
      return text
        .slice(0, 80)
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 4)
        .map((w) => `${first(w)}${dots(3)}`)
        .join(' ')
    case 'birthDate':
      return `${dots(4)}-${dots(2)}-${dots(2)}`
    case 'secret':
      return dots(8)
    default: {
      // Numbers: their last two digits; an IBAN its country too.
      const chars = [...text.slice(0, 40)]
      const keep = kind === 'iban' ? 2 : 0
      let left = chars.filter((c) => /[A-Za-z0-9]/.test(c)).length - 2 - keep
      let i = 0
      return chars
        .map((c) => {
          if (!/[A-Za-z0-9]/.test(c)) return c
          const at = i++
          if (at < keep) return c
          return left-- > 0 ? DOT : c
        })
        .join('')
    }
  }
}

// ---- the findings

const RANK: Record<Confidence, number> = { high: 0, medium: 1, low: 2 }
/** A key a personal data rule can name, as the app takes it (review I8). */
export const plainKey = (k: string) =>
  /^[^.$][^.]{0,127}$/.test(k) &&
  k !== '*' &&
  k !== '**' &&
  k === k.trim() &&
  ![...k].some((c) => isHiddenChar(c.codePointAt(0)!))
/** A rule is at most 512 bytes, its database and collection included. */
const MAX_RULE_BYTES = 512

/** Each field's finding, if it holds personal data: the likeliest first, then in the order met. */
export function findPersonalData(
  docs: readonly unknown[],
  hidden: readonly (readonly string[])[],
  ns?: { db: string; coll: string },
): Scan {
  const findings: Finding[] = []
  const hiddenFields: string[] = []
  for (const s of collect(docs).values()) {
    const field = s.segments.join('.')
    // Hidden from the user, by the rules told — or by its values: *** in every document.
    const allMasked = s.texts.length > 0 && !s.dates && !s.other && s.texts.every((t) => t.text === '***')
    if (hiddenMatch(hidden, s.segments) || allMasked) {
      hiddenFields.push(field)
      continue
    }
    const nameKind = kindOfName(s.segments)
    const values = s.texts.length + s.dates + s.other
    const counts = new Map<Kind, number>()
    const examples = new Map<Kind, string[]>()
    for (const { text, numeric } of s.texts) {
      const kind = kindOfValue(text, nameKind === 'phone', numeric)
      if (!kind) continue
      counts.set(kind, (counts.get(kind) ?? 0) + 1)
      const list = examples.get(kind) ?? []
      const example = masked(kind, text)
      if (list.length < 2 && !list.includes(example)) list.push(example)
      examples.set(kind, list)
    }
    const best = BY_VALUE.reduce<Kind | null>(
      (a, k) => ((counts.get(k) ?? 0) > (a ? (counts.get(a) ?? 0) : 0) ? k : a),
      null,
    )
    const share = (k: Kind | null) => (k && values ? (counts.get(k) ?? 0) / values : 0)
    let kind: Kind
    let confidence: Confidence
    if (nameKind === 'secret') {
      // A password or a key by its name: whatever its values look like, it is shown as one — sure
      // when they are text, less so for yes-or-no or numbers (a flag about one, review 2026-10-29).
      kind = 'secret'
      const flagsOnly = values > 0 && !s.dates && s.other === s.flags && s.texts.every((t) => t.numeric)
      confidence = flagsOnly ? 'low' : 'high'
    } else if (best && share(best) >= 0.5) {
      kind = best
      confidence = (share(best) >= 0.8 && values >= 3) || nameKind === best ? 'high' : 'medium'
    } else if (nameKind) {
      kind = nameKind
      if (!BY_VALUE.includes(nameKind)) confidence = 'medium'
      else confidence = values === 0 || share(nameKind) >= 0.2 ? 'medium' : 'low'
    } else if (best && share(best) >= 0.2) {
      kind = best
      confidence = 'low'
    } else continue
    // A name-told kind shows the field's own values, masked as that kind.
    const maskedExamples =
      kind === 'secret'
        ? s.texts.length
          ? [masked('secret', '')]
          : []
        : (examples.get(kind) ??
          (BY_VALUE.includes(kind)
            ? []
            : [...new Set(s.texts.slice(0, 5).map((t) => masked(kind, t.text)))].slice(0, 2)))
    const fits = !ns || new TextEncoder().encode(`${ns.db}.${ns.coll}.${field}`).length <= MAX_RULE_BYTES
    findings.push({
      field,
      segments: s.segments,
      kind,
      confidence,
      values,
      matched: BY_VALUE.includes(kind) && kind !== 'secret' ? (counts.get(kind) ?? 0) : values,
      named: nameKind === kind,
      examples: maskedExamples,
      nameable: s.segments.every(plainKey) && fits,
    })
  }
  findings.sort((a, b) => RANK[a.confidence] - RANK[b.confidence])
  return { findings, hidden: hiddenFields, sampled: docs.length }
}
