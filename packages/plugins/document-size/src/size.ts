/**
 * Document size (research 2026-10-28: "which fields make my documents big?" — Compass shows only a
 * collection's average size): how big a collection's documents are — their spread, the largest, how
 * near MongoDB's 16 MB limit — and where their bytes go, field by field, a field's name included.
 * Measured on the server by one read-only pipeline: no document comes to the page, only sizes, the
 * fields' names, their types and arrays' lengths, and the largest documents' _id.
 */
import { langTag } from '../../kit/src/i18n'

export type Doc = Record<string, unknown>

/** MongoDB's largest document (BSON). */
export const BSON_LIMIT = 16 * 1024 * 1024
/** The sizes the spread is counted in: under 1 KB, 1–4 KB, … up to the limit. */
export const BOUNDARIES = [0, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304, BSON_LIMIT + 1]
/** Fields listed, at most (the largest share first), and largest documents. */
export const MAX_FIELDS = 50
export const LARGEST = 10

/** What is measured: the documents themselves, or one of their object fields (its keys). */
export type Level = readonly string[]

const isDoc = (v: unknown): v is Doc => v !== null && typeof v === 'object' && !Array.isArray(v)
const ref = (level: Level) => `$${level.join('.')}`
/** A key a path can name, to go into (no dot, not an operator, not empty). */
export const enterable = (key: string) => key !== '' && !key.includes('.') && !key.startsWith('$')

/**
 * The pipeline measuring `level` in `sample` random documents (all of them when null). A field's
 * bytes are what it takes in its document: its type, its name and its value — the size of a
 * document of that one field, less an empty document's 5. `late`: the sample drawn after the
 * documents are measured, so only their sizes are sorted at random — what a collection of large
 * documents needs, whose random sort of whole documents goes past MongoDB's memory (review I3).
 */
export function sizePipeline(level: Level, sample: number | null, late = false): Doc[] {
  const of = level.length ? ref(level) : '$$ROOT'
  const draw = sample ? [{ $sample: { size: sample } }] : []
  return [
    ...(late ? [] : draw),
    // Only the documents where it is an object: as the expressions read the path, so an array of
    // objects there is no object (review I2).
    ...(level.length ? [{ $match: { $expr: { $eq: [{ $type: of }, 'object'] } } }] : []),
    {
      $project: {
        size: { $bsonSize: of },
        fields: {
          $map: {
            input: { $objectToArray: of },
            as: 'f',
            in: {
              k: '$$f.k',
              s: { $subtract: [{ $bsonSize: { $arrayToObject: [[{ k: '$$f.k', v: '$$f.v' }]] } }, 5] },
              t: { $type: '$$f.v' },
              n: { $cond: [{ $isArray: '$$f.v' }, { $size: '$$f.v' }, null] },
            },
          },
        },
      },
    },
    ...(late ? draw : []),
    {
      $facet: {
        stats: [
          {
            $group: {
              _id: null,
              n: { $sum: 1 },
              total: { $sum: '$size' },
              max: { $max: '$size' },
              // Every field's name and type byte, all of them (not only those listed).
              names: {
                $sum: {
                  $sum: { $map: { input: '$fields', in: { $add: [{ $strLenBytes: '$$this.k' }, 2] } } },
                },
              },
            },
          },
        ],
        spread: [
          {
            $bucket: {
              groupBy: '$size',
              boundaries: BOUNDARIES,
              default: 'over',
              output: { n: { $sum: 1 } },
            },
          },
        ],
        largest: [{ $project: { _id: 1, size: 1 } }, { $sort: { size: -1 } }, { $limit: LARGEST }],
        fields: [
          { $unwind: '$fields' },
          {
            $group: {
              _id: '$fields.k',
              total: { $sum: '$fields.s' },
              docs: { $sum: 1 },
              max: { $max: '$fields.s' },
              types: { $addToSet: '$fields.t' },
              elements: { $avg: '$fields.n' },
            },
          },
          { $sort: { total: -1, _id: 1 } },
          { $limit: MAX_FIELDS + 1 },
        ],
      },
    },
  ]
}

/** A pipeline MongoDB stopped for its memory: the sample's random sort of whole documents. */
export const outOfMemory = (message: string) =>
  /\b292\b|exceeded memory|memory limit|QueryExceededMemoryLimit/i.test(message)

export interface FieldSize {
  name: string
  /** Bytes in all the documents measured, and in how many of them it is. */
  total: number
  docs: number
  max: number
  types: string[]
  /** An array's elements, on average (none for a field never an array). */
  elements: number | null
}
export interface Measured {
  documents: number
  total: number
  max: number
  /** The bytes the fields' names (and their type bytes) take, in all the documents measured. */
  names: number
  /** Documents per size range, in BOUNDARIES' order. */
  spread: number[]
  largest: Array<{ id: unknown; size: number }>
  fields: FieldSize[]
  /** More fields than are listed. */
  moreFields: boolean
}

const num = (v: unknown): number => {
  if (typeof v === 'number') return v
  if (isDoc(v))
    for (const k of ['$numberInt', '$numberLong', '$numberDouble'])
      if (typeof v[k] === 'string') {
        const n = Number(v[k])
        return Number.isFinite(n) ? n : 0
      }
  return 0
}

/** The pipeline's one answer, read. */
export function readMeasured(answer: unknown): Measured {
  const facet = isDoc(answer) ? answer : {}
  const list = (k: string) => (Array.isArray(facet[k]) ? (facet[k] as unknown[]).filter(isDoc) : [])
  const stats = list('stats')[0] ?? {}
  const spread = BOUNDARIES.slice(0, -1).map(() => 0)
  for (const b of list('spread')) {
    // Past the limit (never, for a document MongoDB holds): counted with the largest range.
    const at = b._id === 'over' ? spread.length - 1 : BOUNDARIES.indexOf(num(b._id))
    if (at >= 0 && at < spread.length) spread[at] = spread[at]! + num(b.n)
  }
  const fields = list('fields').map((f) => ({
    name: typeof f._id === 'string' ? f._id : String(f._id),
    total: num(f.total),
    docs: num(f.docs),
    max: num(f.max),
    types: Array.isArray(f.types) ? f.types.filter((t): t is string => typeof t === 'string').sort() : [],
    elements: f.elements === null || f.elements === undefined ? null : num(f.elements),
  }))
  return {
    documents: num(stats.n),
    total: num(stats.total),
    max: num(stats.max),
    names: num(stats.names),
    spread,
    largest: list('largest').map((d) => ({ id: d._id, size: num(d.size) })),
    fields: fields.slice(0, MAX_FIELDS),
    moreFields: fields.length > MAX_FIELDS,
  }
}

/** A field's name as stored, in bytes: its UTF-8 and the NUL that ends it, with its type's byte. */
export const nameBytes = (name: string) => new TextEncoder().encode(name).length + 2

/** The share of the documents' bytes their fields' names (and type bytes) take. */
export const namesShare = (m: Measured): number => (m.total ? m.names / m.total : 0)

/** A size in words: 512 B, 2.3 KB, 1.5 MB, 51.2 GB (1 KB = 1,024 bytes, as MongoDB counts). */
export function bytesText(n: number, locale: string): string {
  const format = (x: number, digits: number) =>
    new Intl.NumberFormat(langTag(locale), { maximumFractionDigits: digits }).format(x)
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = n
  let unit = 0
  // A value that would read 1,024 of a unit reads 1 of the next.
  while (unit < units.length - 1 && Math.round(value * (unit ? 10 : 1)) / (unit ? 10 : 1) >= 1024) {
    value /= 1024
    unit++
  }
  return `${format(value, unit ? 1 : 0)} ${units[unit]}`
}
