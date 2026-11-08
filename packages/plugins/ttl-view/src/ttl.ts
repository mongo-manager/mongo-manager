// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { pick, pluralOf, shown, type Language } from '../../kit/src/i18n'
import { formatNumber } from '../../kit/src/ui'
/**
 * Expiry (research 2026-10-28: CUSTOMER-I-6486): when a collection's TTL indexes remove its
 * documents. A TTL index removes a document once its field's date (the earliest, for an array) is
 * `expireAfterSeconds` in the past — the server's TTL monitor runs about once a minute — and never
 * one whose field holds no date, nor, for a partial index, one outside its filter.
 */
export type Doc = Record<string, unknown>
export interface ListedIndex {
  name: string
  key: Doc
  options: Doc
}

export interface TtlIndex {
  name: string
  field: string
  /** Seconds after the field's date. */
  after: number
  partial: Doc | null
}

export type Bucket = 'waiting' | 'hour' | 'day' | 'week' | 'later' | 'never'
export const BUCKETS: Bucket[] = ['waiting', 'hour', 'day', 'week', 'later', 'never']

const isDoc = (v: unknown): v is Doc => v !== null && typeof v === 'object' && !Array.isArray(v)
const HOUR = 3_600_000

const numberOf = (v: unknown): number | null => {
  if (typeof v === 'number') return v
  if (isDoc(v))
    for (const k of ['$numberInt', '$numberLong', '$numberDouble'])
      if (typeof v[k] === 'string') {
        const n = Number(v[k])
        return Number.isFinite(n) ? n : null
      }
  return null
}

/** The TTL indexes of a list: one field, expireAfterSeconds set (MongoDB makes no compound TTL index). */
export function ttlIndexes(indexes: readonly ListedIndex[]): TtlIndex[] {
  return indexes.flatMap((i) => {
    const after = numberOf(i.options.expireAfterSeconds)
    const fields = Object.keys(i.key)
    if (after === null || after < 0 || fields.length !== 1) return []
    const partial = isDoc(i.options.partialFilterExpression) ? i.options.partialFilterExpression : null
    return [{ name: i.name, field: fields[0]!, after, partial }]
  })
}

const date = (ms: number): Doc => ({ $date: { $numberLong: String(Math.round(ms)) } })

/**
 * The filter selecting a bucket's documents at `now`: those whose expiry (the field's date plus
 * `after`) is already past but not yet acted on, in the next hour, day or week, later, or never.
 * TTL acts on the earliest date of an array: a document is in [from, to) when its field holds a date
 * before `to` and none before `from` — { $gte, $lt } would take any date for one bound and another
 * date for the other (review I3).
 */
export function bucketFilter(ttl: TtlIndex, bucket: Bucket, now: number): Doc {
  const f = ttl.field
  // The field's date at which a document expires now.
  const t = now - ttl.after * 1000
  const range = (from: number | null, to: number | null): Doc => ({
    [f]: {
      ...(to !== null ? { $lt: date(to) } : { $gte: date(from!) }),
      ...(from !== null ? { $not: { $lt: date(from) } } : {}),
    },
  })
  const within = (cond: Doc) => (ttl.partial ? { $and: [ttl.partial, cond] } : cond)
  switch (bucket) {
    case 'waiting':
      return within(range(null, t))
    case 'hour':
      return within(range(t, t + HOUR))
    case 'day':
      return within(range(t + HOUR, t + 24 * HOUR))
    case 'week':
      return within(range(t + 24 * HOUR, t + 7 * 24 * HOUR))
    case 'later':
      return within(range(t + 7 * 24 * HOUR, null))
    case 'never': {
      const noDate = { [f]: { $not: { $type: 'date' } } }
      return ttl.partial ? { $or: [{ $nor: [ttl.partial] }, noDate] } : noDate
    }
  }
}

/** The pipeline counting a bucket's documents (a range on the TTL field, which its index can serve). */
export const countPipeline = (filter: Doc): Doc[] => [{ $match: filter }, { $count: 'n' }]

/** A count out of the pipeline's answer: none when no document matched. */
export function countOf(documents: readonly unknown[]): number {
  const first = documents[0]
  return isDoc(first) ? (numberOf(first.n) ?? 0) : 0
}

/** The forms of a unit's name by plural category; `other` is always there. */
type Forms = { other: string } & Partial<Record<Intl.LDMLPluralRule, string>>

interface Words {
  zero: string
  /** The names of week, day, hour, minute, second. */
  units: Forms[]
  /** `n` is already formatted in the language. */
  after: (n: string, unit: string) => string
}

const WORDS = {
  en: {
    zero: 'at the field’s date',
    units: [
      { one: 'week', other: 'weeks' },
      { one: 'day', other: 'days' },
      { one: 'hour', other: 'hours' },
      { one: 'minute', other: 'minutes' },
      { one: 'second', other: 'seconds' },
    ],
    after: (n, unit) => `${n} ${unit} after it`,
  },
  tr: {
    zero: 'alandaki tarihte',
    units: [
      { other: 'hafta' },
      { other: 'gün' },
      { other: 'saat' },
      { other: 'dakika' },
      { other: 'saniye' },
    ],
    after: (n, unit) => `${n} ${unit} sonra`,
  },
  zh: {
    zero: '在该字段的日期时',
    units: [{ other: '周' }, { other: '天' }, { other: '小时' }, { other: '分钟' }, { other: '秒' }],
    after: (n, unit) => `${n} ${unit}后`,
  },
  ja: {
    zero: 'フィールドの日時に',
    units: [{ other: '週間' }, { other: '日' }, { other: '時間' }, { other: '分' }, { other: '秒' }],
    after: (n, unit) => `${n}${unit}後`,
  },
  es: {
    zero: 'en la fecha del campo',
    units: [
      { one: 'semana', other: 'semanas' },
      { one: 'día', other: 'días' },
      { one: 'hora', other: 'horas' },
      { one: 'minuto', other: 'minutos' },
      { one: 'segundo', other: 'segundos' },
    ],
    after: (n, unit) => `${n} ${unit} después`,
  },
  pt: {
    zero: 'na data do campo',
    units: [
      { one: 'semana', other: 'semanas' },
      { one: 'dia', other: 'dias' },
      { one: 'hora', other: 'horas' },
      { one: 'minuto', other: 'minutos' },
      { one: 'segundo', other: 'segundos' },
    ],
    after: (n, unit) => `${n} ${unit} depois`,
  },
  ko: {
    zero: '필드의 날짜 시점',
    units: [{ other: '주' }, { other: '일' }, { other: '시간' }, { other: '분' }, { other: '초' }],
    after: (n, unit) => `${n}${unit} 후`,
  },
  de: {
    zero: 'zum Datum des Felds',
    units: [
      { one: 'Woche', other: 'Wochen' },
      { one: 'Tag', other: 'Tage' },
      { one: 'Stunde', other: 'Stunden' },
      { one: 'Minute', other: 'Minuten' },
      { one: 'Sekunde', other: 'Sekunden' },
    ],
    after: (n, unit) => `${n} ${unit} nach dem Datum`,
  },
  fr: {
    zero: 'à la date du champ',
    // pluralOf: one for 0 and 1 (and a decimal below 2), other from 2.
    units: [
      { one: 'semaine', other: 'semaines' },
      { one: 'jour', other: 'jours' },
      { one: 'heure', other: 'heures' },
      { one: 'minute', other: 'minutes' },
      { one: 'seconde', other: 'secondes' },
    ],
    after: (n, unit) => `${n} ${unit} après la date`,
  },
  ru: {
    zero: 'в момент даты поля',
    // After “через” the noun takes the accusative: one is неделю, минуту, секунду (день and час are the
    // same); a decimal reads like few (“через 1,5 секунды”).
    units: [
      { one: 'неделю', few: 'недели', many: 'недель', other: 'недели' },
      { one: 'день', few: 'дня', many: 'дней', other: 'дня' },
      { one: 'час', few: 'часа', many: 'часов', other: 'часа' },
      { one: 'минуту', few: 'минуты', many: 'минут', other: 'минуты' },
      { one: 'секунду', few: 'секунды', many: 'секунд', other: 'секунды' },
    ],
    after: (n, unit) => `через ${n} ${unit}`,
  },
} satisfies Record<Language, Words>

const SIZES = [86_400 * 7, 86_400, 3600, 60, 1]

/** A duration in words: 3600 → "1 hour after it"; 0 → the date itself. */
export function duration(seconds: number, locale: string): string {
  const words = pick<Words>(WORDS, locale)
  const language = shown(WORDS, locale)
  if (seconds === 0) return words.zero
  const say = (n: number, unit: number): string => {
    const forms = words.units[unit]!
    return words.after(formatNumber(n, language), forms[pluralOf(n, language)] ?? forms.other)
  }
  for (const [i, size] of SIZES.entries()) if (seconds % size === 0) return say(seconds / size, i)
  return say(seconds, 4)
}
