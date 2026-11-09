// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { z } from 'zod'
import { bsonClassOf } from '../ejson'
import { CollectionNameSchema } from '../schemas'

/** A canonical-EJSON object as sent over the wire (deserialized on the server). */
export const EjsonObjectSchema = z.record(z.string(), z.unknown())

export const FieldPathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (p) => !p.startsWith('$') && !p.includes('\0') && !p.split('.').some((part) => part === ''),
    'Invalid field path',
  )

const MAX_SKIP = 1_000_000_000

/** SHA-256 (hex) of a document's canonical EJSON, as returned by the server with every document. */
export const DocumentHashSchema = z.string().regex(/^[0-9a-f]{64}$/, 'Invalid document version')

export const FindRequestSchema = z.object({
  filter: EjsonObjectSchema.default({}),
  projection: EjsonObjectSchema.optional(),
  sort: EjsonObjectSchema.optional(),
  collation: EjsonObjectSchema.optional(),
  hint: z.union([z.string().min(1).max(512), EjsonObjectSchema]).optional(),
  skip: z.number().int().min(0).max(MAX_SKIP).default(0),
  limit: z.number().int().min(1).max(1000).default(20),
  maxTimeMS: z.number().int().min(100).max(300_000).default(30_000),
  /** Plugins wave 2 review I1: false for a find the user did not write (a plugin's): no recent query. */
  remember: z.boolean().default(true),
  /**
   * W1 review (minor 3): false for a read the app makes for the user itself (the chart view): not one
   * of their recent queries, yet their own read (a plugin's stays told apart by `remember`).
   */
  record: z.boolean().default(true),
})
export type FindRequest = z.infer<typeof FindRequestSchema>

export const CountRequestSchema = z.object({
  filter: EjsonObjectSchema.default({}),
  /** The find's collation: without it the count could disagree with the listed documents. */
  collation: EjsonObjectSchema.optional(),
  /** The find's hint: a sparse or partial index changes which documents are counted. */
  hint: z.union([z.string().min(1).max(512), EjsonObjectSchema]).optional(),
  maxTimeMS: z.number().int().min(100).max(60_000).default(10_000),
})

export const IdRequestSchema = z
  .object({ _id: z.unknown() })
  .refine((v) => v._id !== undefined, '_id is required')

export const InsertRequestSchema = z.object({ documents: z.array(EjsonObjectSchema).min(1).max(1000) })

export const UpdateRequestSchema = z
  .object({
    _id: z.unknown(),
    set: z.record(FieldPathSchema, z.unknown()).default({}),
    unset: z.array(FieldPathSchema).max(1000).default([]),
    /** Version of the document as loaded (from find/get); the update is refused if it changed. */
    hash: DocumentHashSchema,
  })
  .refine((v) => v._id !== undefined, '_id is required')
  .refine((v) => Object.keys(v.set).length > 0 || v.unset.length > 0, 'Nothing to update')
  .refine((v) => !v.unset.some((p) => Object.hasOwn(v.set, p)), 'A field cannot be set and unset at once')
export type UpdateRequest = z.infer<typeof UpdateRequestSchema>

export const ReplaceRequestSchema = z
  .object({ _id: z.unknown(), document: EjsonObjectSchema, hash: DocumentHashSchema })
  .refine((v) => v._id !== undefined, '_id is required')

const isOperatorDoc = (o: Record<string, unknown>) =>
  Object.keys(o).length > 0 && Object.keys(o).every((k) => k.startsWith('$'))
const UpdateSpecSchema = z.union([
  EjsonObjectSchema.refine(
    isOperatorDoc,
    'Use update operators such as $set; replacing documents in bulk is not allowed',
  ),
  z
    .array(
      EjsonObjectSchema.refine(
        (s) => Object.keys(s).length === 1 && Object.keys(s)[0]!.startsWith('$'),
        'Invalid stage',
      ),
    )
    .min(1)
    .max(100),
])

export const BulkRequestSchema = z
  .object({
    filter: EjsonObjectSchema,
    operation: z.enum(['update', 'delete']),
    update: UpdateSpecSchema.optional(),
  })
  .refine(
    (v) => (v.operation === 'update') === (v.update !== undefined),
    'update is required for update and not allowed for delete',
  )
export type BulkRequest = z.infer<typeof BulkRequestSchema>

export const BulkExecuteSchema = z.intersection(
  BulkRequestSchema,
  z.object({ filterHash: z.string().min(1).max(4096), confirm: z.string().max(255).optional() }),
)

export const ConfirmSchema = z.object({ confirm: z.string().max(255) })

/**
 * W2.4 (2026-10-16): a collection's or a view's default collation — MongoDB's own fields only, a
 * locale as ICU names them ("tr", "en_US", "de@collation=phonebook") or "simple".
 */
export const CollationSchema = z.strictObject({
  locale: z
    .string()
    .max(64)
    .regex(/^(?:simple|[A-Za-z]{2,3}(?:_[A-Za-z0-9]{2,8})*(?:@[A-Za-z]+=[A-Za-z0-9]+)?)$/, 'Unknown locale'),
  caseLevel: z.boolean().optional(),
  caseFirst: z.enum(['upper', 'lower', 'off']).optional(),
  strength: z.number().int().min(1).max(5).optional(),
  numericOrdering: z.boolean().optional(),
  alternate: z.enum(['non-ignorable', 'shifted']).optional(),
  maxVariable: z.enum(['punct', 'space']).optional(),
  backwards: z.boolean().optional(),
  normalization: z.boolean().optional(),
})
export type Collation = z.infer<typeof CollationSchema>

const Name = { name: CollectionNameSchema }
const WithCollation = { collation: CollationSchema.optional() }
/** Change-stream pre- and post-images (MongoDB 6.0+); not for time series or views. */
const WithImages = { changeStreamPreAndPostImages: z.boolean().optional() }
export const CreateCollectionSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('collection'),
    ...Name,
    clustered: z.boolean().default(false),
    ...WithCollation,
    ...WithImages,
  }),
  z.strictObject({
    kind: z.literal('capped'),
    ...Name,
    size: z
      .number()
      .int()
      .min(4096)
      .max(2 ** 50),
    max: z.number().int().min(1).optional(),
    ...WithCollation,
    ...WithImages,
  }),
  z.strictObject({
    kind: z.literal('timeseries'),
    ...Name,
    timeField: z.string().min(1).max(256),
    metaField: z.string().min(1).max(256).optional(),
    granularity: z.enum(['seconds', 'minutes', 'hours']).optional(),
    expireAfterSeconds: z.number().int().min(1).optional(),
    ...WithCollation,
  }),
  z.strictObject({
    kind: z.literal('view'),
    ...Name,
    viewOn: CollectionNameSchema,
    pipeline: z.array(EjsonObjectSchema).max(100),
    ...WithCollation,
  }),
])
export type CreateCollection = z.infer<typeof CreateCollectionSchema>

/** W2.4: change-stream pre/post images on or off (collMod), the collection named to confirm. */
export const CollectionOptionsSchema = z.strictObject({
  changeStreamPreAndPostImages: z.boolean(),
  confirm: CollectionNameSchema,
})
export type CollectionOptions = z.infer<typeof CollectionOptionsSchema>

/** W2.2: a view's source and pipeline replaced (collMod viewOn/pipeline), the view named to confirm. */
export const UpdateViewSchema = z.strictObject({
  viewOn: CollectionNameSchema,
  pipeline: z.array(EjsonObjectSchema).max(100),
  confirm: CollectionNameSchema,
  /**
   * W2 review (I1): the definition the edit started from, as the page got it; a view changed
   * meanwhile is not overwritten.
   */
  base: z.strictObject({ viewOn: CollectionNameSchema, pipeline: z.array(EjsonObjectSchema).max(100) }),
})
export type UpdateView = z.infer<typeof UpdateViewSchema>

const INDEX_TYPES = new Set(['text', '2dsphere', '2d', 'hashed'])
export const CreateIndexSchema = z.object({
  key: z
    .record(z.string().min(1).max(1024), z.union([z.literal(1), z.literal(-1), z.string()]))
    .refine((k) => Object.keys(k).length > 0, 'The index needs at least one key')
    .refine(
      (k) => Object.values(k).every((v) => typeof v === 'number' || INDEX_TYPES.has(v)),
      'Unsupported index type',
    ),
  options: z
    .object({
      name: z.string().min(1).max(512).optional(),
      unique: z.boolean().optional(),
      sparse: z.boolean().optional(),
      hidden: z.boolean().optional(),
      expireAfterSeconds: z.number().int().min(0).optional(),
      partialFilterExpression: EjsonObjectSchema.optional(),
      collation: EjsonObjectSchema.optional(),
      wildcardProjection: EjsonObjectSchema.optional(),
      weights: z.record(z.string(), z.number().int().min(1)).optional(),
      default_language: z.string().max(64).optional(),
    })
    .default({}),
})
export type CreateIndex = z.infer<typeof CreateIndexSchema>

/**
 * W2.6 (2026-10-16): Atlas Search and Vector Search indexes. A name as Atlas takes one (letters,
 * digits, "_" and "-"); a definition of 64 KiB at most, written as JSON (Atlas checks the rest).
 */
export const SearchIndexNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,128}$/, 'Use letters, digits, "_" and "-" (128 at most)')
export const SEARCH_INDEX_TYPES = ['search', 'vectorSearch'] as const
export type SearchIndexType = (typeof SEARCH_INDEX_TYPES)[number]
const MAX_SEARCH_DEFINITION = 64 * 1024
const SearchDefinitionSchema = EjsonObjectSchema.refine(
  (d) => JSON.stringify(d).length <= MAX_SEARCH_DEFINITION,
  'The definition is too large (64 KiB at most)',
)
export const CreateSearchIndexSchema = z.strictObject({
  name: SearchIndexNameSchema,
  type: z.enum(SEARCH_INDEX_TYPES),
  definition: SearchDefinitionSchema,
})
export type CreateSearchIndex = z.infer<typeof CreateSearchIndexSchema>
export const UpdateSearchIndexSchema = z.strictObject({ definition: SearchDefinitionSchema })

/** The similarity functions and quantizations Atlas Vector Search takes. */
export const VECTOR_SIMILARITIES = ['euclidean', 'cosine', 'dotProduct'] as const
export const VECTOR_QUANTIZATIONS = ['none', 'scalar', 'binary'] as const
export const MAX_VECTOR_DIMENSIONS = 8192

/**
 * W2 review (minor 9): what is wrong with a vector index definition, as a code each side words in its
 * own language (the server in English, the page in the user's).
 */
export const VECTOR_PROBLEMS = {
  vector_fields: 'A vector index needs a list of fields',
  vector_path: 'Each field needs a path',
  vector_kind: 'A field is either a vector or a filter',
  vector_dimensions: `numDimensions is a whole number from 1 to ${MAX_VECTOR_DIMENSIONS}`,
  vector_similarity: 'similarity is euclidean, cosine or dotProduct',
  vector_quantization: 'quantization is none, scalar or binary',
  vector_none: 'A vector index needs at least one vector field',
} as const
export type VectorProblem = keyof typeof VECTOR_PROBLEMS

/**
 * What is wrong with a vector index definition (decoded), or null: one vector field or more, each
 * with a path, 1 to 8192 dimensions and a known similarity; filter fields with a path.
 */
export function vectorDefinitionProblem(definition: unknown): VectorProblem | null {
  const fields = (definition as { fields?: unknown } | null)?.fields
  if (!Array.isArray(fields) || fields.length === 0 || fields.length > 1000) return 'vector_fields'
  let vectors = 0
  for (const field of fields) {
    const f = (field ?? {}) as Record<string, unknown>
    if (typeof f.path !== 'string' || f.path === '' || f.path.startsWith('$')) return 'vector_path'
    if (f.type === 'filter') continue
    if (f.type !== 'vector') return 'vector_kind'
    const dims = Number(
      (f.numDimensions as { valueOf?: () => unknown } | undefined)?.valueOf?.() ?? f.numDimensions,
    )
    if (!Number.isInteger(dims) || dims < 1 || dims > MAX_VECTOR_DIMENSIONS) return 'vector_dimensions'
    if (!VECTOR_SIMILARITIES.includes(f.similarity as (typeof VECTOR_SIMILARITIES)[number]))
      return 'vector_similarity'
    if (f.quantization !== undefined && !VECTOR_QUANTIZATIONS.includes(f.quantization as never))
      return 'vector_quantization'
    vectors++
  }
  return vectors > 0 ? null : 'vector_none'
}

const SERVER_JS = new Set(['$where', '$function', '$accumulator'])
/**
 * Security review 2026-10-16 (I-1): MongoDB's undocumented internal operators. $_internalJsEmit and
 * $_internalJsReduce run JavaScript (they ran on 6.0, 7.0 and 8.2); any other $_internal… operator
 * is refused as well, fail closed, since none is meant for clients and new ones appear unannounced.
 */
const INTERNAL_OPERATOR = '$_internal'

/** First operator that would execute JavaScript on the MongoDB server, or null. */
export function findServerJs(value: unknown, depth = 0): string | null {
  // Fail closed: anything nested this deeply is refused rather than scanned partially.
  if (depth > 200) return '(nesting too deep)'
  if (value === null || typeof value !== 'object') return null
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findServerJs(item, depth + 1)
      if (found) return found
    }
    return null
  }
  if (value instanceof Date) return null
  const bsonClass = bsonClassOf(value)
  // Security review 2026-10-16 (I-5): an object whose only $-keys are $ref/$id/$db is parsed into a
  // DBRef, and what sat beside them ends in its fields — looked into, as its id is.
  if (bsonClass === 'DBRef') {
    const ref = value as unknown as { oid?: unknown; fields?: unknown }
    return findServerJs(ref.oid, depth + 1) ?? findServerJs(ref.fields, depth + 1)
  }
  if (bsonClass !== undefined) return null
  for (const [key, item] of Object.entries(value)) {
    if (SERVER_JS.has(key) || key.startsWith(INTERNAL_OPERATOR)) return key
    const found = findServerJs(item, depth + 1)
    if (found) return found
  }
  return null
}
