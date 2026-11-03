import { KEYWORDS } from './parser'
import type { Doc } from './translate'

/**
 * Plugin tabs redesign §2.2: a few SELECTs for the open collection, in its own fields and values
 * when a sample of it was read (else plain names), each one the translator takes.
 */
export const EXAMPLE_IDS = ['filter', 'group', 'sum', 'like', 'in', 'join'] as const
export type ExampleId = (typeof EXAMPLE_IDS)[number]
export interface Example {
  id: ExampleId
  sql: string
}

const PLAIN = /^[\p{L}_][\p{L}\p{N}_]*$/u

/** A name as SQL writes it: bare when it is a plain word, else in backticks. */
export function quoteName(name: string): string {
  return PLAIN.test(name) && !KEYWORDS.has(name.toUpperCase()) ? name : `\`${name.replace(/`/g, '``')}\``
}
const text = (value: string) => `'${value.replace(/'/g, "''")}'`

/** A field an example may name bare: a plain word, not a keyword, not _id. */
const usable = (key: string) => key !== '_id' && PLAIN.test(key) && !KEYWORDS.has(key.toUpperCase())
const isNumber = (v: unknown) =>
  typeof v === 'number' ||
  (!!v &&
    typeof v === 'object' &&
    ['$numberInt', '$numberLong', '$numberDouble', '$numberDecimal'].some((k) => k in (v as Doc)))
const isOid = (v: unknown) => !!v && typeof v === 'object' && typeof (v as Doc).$oid === 'string'
/** A short one-line text a reader can make sense of in a WHERE. */
const isShortText = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 40 && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(v)

/**
 * The field of the sample whose values pass `test` that suits an example best, and its values, most
 * frequent first: one with repeated values (it groups and filters better than one unique to each
 * document), then the one most documents hold, then the one with fewest values.
 */
function bestField(sample: Doc[], test: (v: unknown) => boolean): { key: string; values: unknown[] } | null {
  const found = new Map<string, unknown[]>()
  for (const doc of sample)
    for (const [key, v] of Object.entries(doc))
      if (usable(key) && test(v)) found.set(key, [...(found.get(key) ?? []), v])
  const ranked = [...found].map(([key, values]) => {
    const counts = new Map<string, number>()
    for (const v of values) counts.set(JSON.stringify(v), (counts.get(JSON.stringify(v)) ?? 0) + 1)
    return { key, held: values.length, counts, repeats: counts.size < values.length }
  })
  ranked.sort(
    (a, b) => Number(b.repeats) - Number(a.repeats) || b.held - a.held || a.counts.size - b.counts.size,
  )
  const best = ranked[0]
  if (!best) return null
  const values = [...best.counts].sort((a, b) => b[1] - a[1]).map(([v]) => JSON.parse(v) as unknown)
  return { key: best.key, values }
}

const initial = (name: string) => {
  const c = [...name][0]?.toLowerCase() ?? ''
  return /^\p{L}$/u.test(c) ? c : 't'
}

export function examples(coll: string | null, sample: Doc[]): Example[] {
  const from = quoteName(coll ?? 'orders')
  const str = bestField(sample, isShortText)
  const field = str ? quoteName(str.key) : 'status'
  const [first, second] = (str?.values as string[] | undefined) ?? ['active', 'pending']
  const num = bestField(sample, isNumber)
  const number = num ? quoteName(num.key) : 'total'
  const prefix = [...first!].slice(0, 2).join('')
  const like = /[%_]/.test(prefix) ? 'a' : prefix
  // A reference held as an ObjectId (customerId, customer_id) names the collection it points to.
  const ref = bestField(sample, isOid)
  const refMatch = ref ? /^(\p{L}[\p{L}\p{N}]*?)_?(?:Id|ID|id)$/u.exec(ref.key) : null
  const refField = refMatch ? quoteName(ref!.key) : 'customerId'
  const otherName = refMatch ? (refMatch[1]!.endsWith('s') ? refMatch[1]! : `${refMatch[1]}s`) : 'customers'
  const a = initial(coll ?? 'orders')
  const b = initial(otherName) === a ? `${a}2` : initial(otherName)
  return [
    {
      id: 'filter',
      sql: `SELECT *\nFROM ${from}\nWHERE ${field} = ${text(first!)}\nORDER BY ${number} DESC\nLIMIT 20`,
    },
    { id: 'group', sql: `SELECT ${field}, COUNT(*) AS n\nFROM ${from}\nGROUP BY ${field}\nORDER BY n DESC` },
    {
      id: 'sum',
      sql: `SELECT ${field}, SUM(${number}) AS sum_${num?.key ?? 'total'}, AVG(${number}) AS avg_${num?.key ?? 'total'}\nFROM ${from}\nGROUP BY ${field}`,
    },
    { id: 'like', sql: `SELECT *\nFROM ${from}\nWHERE ${field} LIKE ${text(`${like}%`)}\nLIMIT 20` },
    {
      id: 'in',
      sql: `SELECT *\nFROM ${from}\nWHERE ${field} IN (${[first!, ...(second !== undefined ? [second] : [])].map(text).join(', ')})\nLIMIT 20`,
    },
    {
      id: 'join',
      sql: `SELECT *\nFROM ${from} ${a}\nJOIN ${quoteName(otherName)} ${b} ON ${a}.${refField} = ${b}._id\nLIMIT 20`,
    },
  ]
}
