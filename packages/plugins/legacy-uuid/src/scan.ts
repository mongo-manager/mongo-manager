import { LEGACY, formatUuid, reorder, uuidBytes, type Doc, type Encoding } from './uuid'

/**
 * The fields of a sample that hold UUIDs, legacy or standard, and for the legacy ones the drivers
 * whose byte order reads them as well-formed UUIDs: a UUID's version digit and variant bits sit in
 * fixed places, so read in the wrong order they almost never land there.
 */
export interface UuidField {
  path: string
  legacy: number
  standard: number
  /** A few legacy values, to show read in each order. */
  examples: Uint8Array[]
  /** The orders that read every legacy value as a well-formed UUID (none, one, or several). */
  likely: Exclude<Encoding, 'standard'>[]
}

const MAX_DEPTH = 20
const EXAMPLES = 3
/** A well-formed UUID (RFC 9562): version 1 to 8, variant 10xx. */
const WELL_FORMED = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export const wellFormed = (bytes: Uint8Array): boolean => WELL_FORMED.test(formatUuid(bytes))

/** The nil and the max UUID (all zeros, all ones): the same in every order, telling none of them. */
const special = (bytes: Uint8Array): boolean => bytes.every((b) => b === 0) || bytes.every((b) => b === 0xff)

/**
 * The orders that read every legacy value as a well-formed UUID, the nil and max ones aside
 * (Guid.Empty is common in C# data; research plugins' review, I3); none when only those are there.
 */
function likelyOrders(legacy: readonly Uint8Array[]): Exclude<Encoding, 'standard'>[] {
  const telling = legacy.filter((b) => !special(b))
  return telling.length ? LEGACY.filter((e) => telling.every((b) => wellFormed(reorder(b, e)))) : []
}

const isDoc = (v: unknown): v is Doc => v !== null && typeof v === 'object' && !Array.isArray(v)

export function scanUuids(docs: readonly unknown[]): UuidField[] {
  const found = new Map<string, { legacy: Uint8Array[]; standard: number }>()
  const walk = (v: unknown, path: string, depth: number): void => {
    if (depth > MAX_DEPTH) return
    if (Array.isArray(v)) {
      for (const item of v) walk(item, path, depth + 1)
      return
    }
    if (!isDoc(v)) return
    const uuid = uuidBytes(v)
    if (uuid) {
      const entry = found.get(path) ?? { legacy: [], standard: 0 }
      if (uuid.legacy) entry.legacy.push(uuid.bytes)
      else entry.standard++
      found.set(path, entry)
      return
    }
    for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k, depth + 1)
  }
  for (const doc of docs) walk(doc, '', 0)
  return [...found.entries()]
    .map(([path, { legacy, standard }]) => ({
      path,
      legacy: legacy.length,
      standard,
      examples: legacy.slice(0, EXAMPLES),
      likely: likelyOrders(legacy),
    }))
    .sort((a, b) => b.legacy + b.standard - (a.legacy + a.standard) || a.path.localeCompare(b.path))
}
