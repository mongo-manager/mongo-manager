import type { FieldShape } from '../../kit/src/shape'

/**
 * Plugins wave 4 (spec §4): candidate shard keys and what `analyzeShardKey` says of them, judged as
 * MongoDB's and Atlas's guidance has it — many distinct values, none of them held by a large share
 * of the documents, and not growing with each insert (unless hashed).
 */
export type Analysis =
  | {
      available: true
      numDocsTotal: number | null
      numDocsSampled: number | null
      numDistinctValues: number | null
      avgDocSizeBytes: number | null
      isUnique: boolean | null
      mostCommonValues: Array<{ value: unknown; frequency: number }>
      monotonicity: 'monotonic' | 'not monotonic' | 'unknown'
    }
  | { available: false; reason: 'version' | 'standalone' | 'no_index' }

export interface KeyField {
  field: string
  hashed: boolean
}
/** MongoDB's limit is 32 fields; a key past five is not one anyone should pick (my call). */
export const MAX_FIELDS = 5

/**
 * The fields a key may hold, from the sampled shape: no field hidden from the user, none inside an
 * array or holding one (MongoDB refuses arrays in a shard key), no object as a whole.
 */
export function candidateFields(shape: readonly FieldShape[]): string[] {
  return shape
    .filter(
      (f) =>
        !f.hidden &&
        !f.path.includes('[]') &&
        // Final review Minor 13: a name JavaScript reads as an integer would be moved first in the key.
        !/^\d+$/.test(f.segments.join('.')) &&
        f.types.length > 0 &&
        f.types.every((t) => t.type !== 'array' && t.type !== 'object'),
    )
    .map((f) => f.segments.join('.'))
    .sort((a, b) => (a === '_id' ? -1 : b === '_id' ? 1 : a < b ? -1 : a > b ? 1 : 0))
}

export type KeyProblem = 'empty' | 'unknown' | 'twice' | 'hashed' | 'tooMany'
/** Why a candidate is not one MongoDB takes, or null. */
export function keyProblem(key: readonly KeyField[], offered: readonly string[]): KeyProblem | null {
  if (!key.length) return 'empty'
  if (key.length > MAX_FIELDS) return 'tooMany'
  if (key.some((k) => !offered.includes(k.field))) return 'unknown'
  if (new Set(key.map((k) => k.field)).size !== key.length) return 'twice'
  if (key.filter((k) => k.hashed).length > 1) return 'hashed'
  return null
}

/** The key as the bridge takes it. */
export const keyObject = (key: readonly KeyField[]): Record<string, 1 | 'hashed'> =>
  Object.fromEntries(key.map((k) => [k.field, k.hashed ? 'hashed' : 1]))

const PLAIN = /^[A-Za-z_$][A-Za-z0-9_$]*$/
/** The key as the shell writes it: `{ city: 1, "user.id": "hashed" }`. */
export function keyText(key: readonly KeyField[]): string {
  const parts = key.map(
    (k) => `${PLAIN.test(k.field) ? k.field : JSON.stringify(k.field)}: ${k.hashed ? '"hashed"' : '1'}`,
  )
  return `{ ${parts.join(', ')} }`
}

/** The index analyzeShardKey needs, as the shell creates it. */
export const createIndexText = (coll: string, key: readonly KeyField[]): string =>
  `db.getCollection(${JSON.stringify(coll)}).createIndex(${keyText(key)})`

export type Verdict = 'good' | 'fair' | 'poor' | 'unknown'
export interface Verdicts {
  cardinality: Verdict
  frequency: Verdict
  monotonicity: Verdict
  overall: Verdict
}

/** At least this many distinct values are many; below the second, few (my call). */
export const MANY_VALUES = 1000
export const FEW_VALUES = 100
/** One value held by at least this share of the sampled documents is common; past the second, too common. */
export const COMMON_SHARE = 0.05
export const TOO_COMMON_SHARE = 0.2

const RANK: Record<Verdict, number> = { unknown: 0, good: 1, fair: 2, poor: 3 }

export function verdictsOf(a: Extract<Analysis, { available: true }>, hashed: boolean): Verdicts {
  const cardinality: Verdict = a.isUnique
    ? 'good'
    : a.numDistinctValues === null
      ? 'unknown'
      : a.numDistinctValues >= MANY_VALUES
        ? 'good'
        : a.numDistinctValues >= FEW_VALUES
          ? 'fair'
          : 'poor'
  const top = Math.max(0, ...a.mostCommonValues.map((v) => v.frequency))
  const share = a.numDocsSampled && a.mostCommonValues.length ? top / a.numDocsSampled : null
  const frequency: Verdict =
    share === null ? 'unknown' : share >= TOO_COMMON_SHARE ? 'poor' : share >= COMMON_SHARE ? 'fair' : 'good'
  // A hashed key spreads even a growing value across the chunks.
  const monotonicity: Verdict = hashed
    ? 'good'
    : a.monotonicity === 'monotonic'
      ? 'poor'
      : a.monotonicity === 'not monotonic'
        ? 'good'
        : 'unknown'
  const parts = [cardinality, frequency, monotonicity]
  const overall = parts.reduce<Verdict>((worst, v) => (RANK[v] > RANK[worst] ? v : worst), 'unknown')
  return {
    cardinality,
    frequency,
    monotonicity,
    overall: parts.includes('unknown') && overall === 'good' ? 'unknown' : overall,
  }
}

/** The share of the sampled documents the most common value is held by, or null. */
export function topShare(a: Extract<Analysis, { available: true }>): number | null {
  if (!a.numDocsSampled || !a.mostCommonValues.length) return null
  return Math.max(...a.mostCommonValues.map((v) => v.frequency)) / a.numDocsSampled
}
