import { z } from 'zod'
import { EjsonObjectSchema } from './data'
import { PARAM_NAME } from '../shell/literals'
import { MAX_QUERY_PARAMS } from '../query/marker'

/** Phase 2c spec §2.1: a tag as kept: a-z, 0-9, _ and -, 1 to 30 characters. */
export const TAG_PATTERN = /^[a-z0-9_-]+$/
export const MAX_TAG_LENGTH = 30
export const MAX_TAGS = 10

/** A tag as typed ("#Sales ") into what is kept ("sales"); the web form and the server share it. */
export const normaliseTag = (text: string): string => text.trim().replace(/^#+/, '').toLowerCase()

/** One tag checked as the server checks it, for a message beside the field (final review 2c, I3). */
export function checkTag(text: string): { tag: string } | { error: 'empty' | 'long' | 'chars' } {
  const tag = normaliseTag(text)
  if (!tag) return { error: 'empty' }
  if (tag.length > MAX_TAG_LENGTH) return { error: 'long' }
  if (!TAG_PATTERN.test(tag)) return { error: 'chars' }
  return { tag }
}

/**
 * Tags on favourites and saved pipelines: normalised, duplicates dropped, then at most 10
 * (final review 2c, Minor 7: duplicates do not count).
 */
export const TagsSchema = z
  .array(
    z
      .string()
      .max(200)
      .transform(normaliseTag)
      .pipe(
        z
          .string()
          .min(1, 'A tag cannot be empty')
          .max(MAX_TAG_LENGTH, 'A tag has 30 characters at most')
          .regex(TAG_PATTERN, 'A tag uses a-z, 0-9, _ and - only'),
      ),
  )
  .max(100, 'Too many tags')
  .transform((tags) => [...new Set(tags)])
  .refine((tags) => tags.length <= MAX_TAGS, 'At most 10 tags')

/** A parameter's default, at most (characters): as long as a value given to it (final review, Minor 5). */
export const MAX_PARAM_DEFAULT = 64 * 1024

/** A find as it is saved: the query bar's parts, canonical EJSON. */
export const FavouriteQuerySchema = z.object({
  filter: EjsonObjectSchema.default({}),
  projection: EjsonObjectSchema.optional(),
  sort: EjsonObjectSchema.optional(),
  collation: EjsonObjectSchema.optional(),
  hint: z.union([z.string().min(1).max(512), EjsonObjectSchema]).optional(),
  /** Query parameters (spec 2026-10-28): each parameter's default, as typed in its field. */
  params: z
    .record(z.string().regex(PARAM_NAME), z.string().max(MAX_PARAM_DEFAULT))
    .refine((p) => Object.keys(p).length <= MAX_QUERY_PARAMS, `At most ${MAX_QUERY_PARAMS} parameters`)
    .optional(),
})
export type FavouriteQuery = z.infer<typeof FavouriteQuerySchema>

export const FavouriteBodySchema = z.object({
  name: z
    .string()
    .max(100)
    .refine((s) => s.trim().length > 0, 'A name is required'),
  tags: TagsSchema.default([]),
  query: FavouriteQuerySchema,
  shared: z.boolean().default(false),
})
export type FavouriteBody = z.input<typeof FavouriteBodySchema>

/** A change: tags left out stay as they are (final review 2c, Minor 6). */
export const FavouriteUpdateSchema = FavouriteBodySchema.extend({ tags: TagsSchema.optional() })

export interface FavouriteView {
  id: string
  name: string
  tags: string[]
  query: FavouriteQuery
  shared: boolean
  mine: boolean
  owner: string | null
  updatedAt: string
}

/** Phase 2c spec §2.2: one result of a library search. */
export interface LibraryItem {
  type: 'favourite' | 'pipeline' | 'history' | 'snippet'
  id: string
  db: string
  coll: string
  /** Favourites and pipelines have names; history entries do not. */
  name?: string
  tags: string[]
  kind: 'find' | 'aggregate' | 'shell'
  /** The query as shell text, cut at 200 characters. */
  preview: string
  /** The query itself (canonical EJSON): a find's parts, or a pipeline's stages. */
  body: unknown
  /** ISO time: when it was last used (history) or saved. */
  at: string
  shared: boolean
  mine: boolean
  /** W5 review: saved in local mode (no owner); a connection admin may change it. */
  ownerless?: boolean
  count?: number
  /** W1 (completion §2): a saved query the caller pinned (listed first, and on Home). */
  pinned?: boolean
}

/** W1: the saved queries a user may pin (their own, or shared with them). */
export const PINNABLE_TYPES = ['favourite', 'pipeline'] as const
/** W1: pins per user and connection at most. */
export const MAX_LIBRARY_PINS = 50
export const LibraryPinSchema = z.object({
  type: z.enum(PINNABLE_TYPES),
  id: z.string().uuid(),
  pinned: z.boolean(),
})
export type LibraryPin = z.infer<typeof LibraryPinSchema>

export const LibraryQuerySchema = z.object({
  q: z.string().max(200).optional(),
  // One comma list, or the parameter repeated (final review 2c, Minor 7).
  tags: z
    .union([z.string().max(400), z.array(z.string().max(400)).max(20)])
    .optional()
    .transform((s) =>
      (Array.isArray(s) ? s : s ? [s] : [])
        .flatMap((part) => part.split(','))
        .map(normaliseTag)
        .filter(Boolean),
    ),
  type: z.enum(['favourite', 'pipeline', 'history', 'snippet']).optional(),
  db: z.string().max(64).optional(),
  coll: z.string().max(255).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})
