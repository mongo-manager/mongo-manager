import { z } from 'zod'
import type { SchemaType } from '../schema/analyse'

/**
 * completion W6.4: a database's data model — its collections, their fields from a schema sample,
 * and the references inferred between them. Names, types and counts only: never a value.
 */
export const DATA_MODEL_LIMITS = {
  /** Collections and views drawn; the rest are counted in `skipped`. */
  collections: 50,
  /** Fields listed per collection: the top level first, then the nested ones that matter. */
  fields: 40,
  /** How deep a nested field is listed (top level is 1); id-like fields deeper still, to 4. */
  depth: 2,
  idDepth: 4,
  /** Sampled values checked against another collection's _id, per field, and checks in all. */
  overlapValues: 10,
  overlapChecks: 60,
  /** Saved pipelines read for their $lookup stages. */
  pipelines: 500,
  /** Plugins wave 3: indexes listed per collection (MongoDB allows 64). */
  indexes: 64,
} as const

export const DataModelQuerySchema = z.strictObject({
  sampleSize: z.coerce.number().int().min(20).max(1000).default(200),
})
export type DataModelQuery = z.infer<typeof DataModelQuerySchema>

export interface ModelField {
  /** For display: keys joined by "." (array elements as "[]"). */
  path: string
  /** The types seen, most common first (none for a field hidden from this user). */
  types: SchemaType[]
  /** An array's: the types of its elements. */
  items?: SchemaType[]
  /** Share of the sampled documents holding it, 0–1. */
  share: number
  /** Personal data hidden from this user: its name only. */
  masked?: true
}

export type ModelCollectionType = 'collection' | 'view' | 'timeseries'

/** Plugins wave 3 (spec §4): an index, by its keys' names only (never a partial filter or options). */
export interface ModelIndex {
  /** The keys' field paths, in the index's order. */
  keys: string[]
  /** A unique index (the `_id` index always is). */
  unique?: true
}

export interface ModelCollection {
  name: string
  type: ModelCollectionType
  /** Documents sampled (0 for a view: views are not sampled). */
  sampled: number
  fields: ModelField[]
  /** Fields left out of `fields` (deeper ones, or past the limit). */
  moreFields: number
  /** A view's source collection. */
  viewOn?: string
  /** Why it could not be sampled. */
  refused?: 'not_permitted' | 'error' | 'timeout'
  /** Plugins wave 3: its indexes (absent for a view, or where they could not be read). */
  indexes?: ModelIndex[]
}

/**
 * How a reference was found: the field's name names the collection (userId → users), its sampled
 * values are _ids there, a saved pipeline or a view joins them with $lookup.
 */
export const REFERENCE_SOURCES = ['name', 'values', 'lookup'] as const
export type ReferenceSource = (typeof REFERENCE_SOURCES)[number]

export interface ModelReference {
  /** The collection holding the reference, and its field's path. */
  from: string
  field: string
  /** The collection referred to, and the field matched there (usually _id). */
  to: string
  toField: string
  sources: ReferenceSource[]
  /** Several per document (an array of references). */
  many: boolean
  /** The values check: how many sampled values were looked for, and how many were found. */
  overlap?: { checked: number; found: number }
}

export interface DataModel {
  db: string
  /** Documents sampled per collection: the size asked for, or less when `capped`. */
  sampleSize: number
  /** The server's cap on the documents one model samples in all made each sample smaller. */
  capped?: true
  collections: ModelCollection[]
  references: ModelReference[]
  /** Collections past the limit, not drawn. */
  skipped: number
  /** When it was read (ISO). */
  at: string
}
