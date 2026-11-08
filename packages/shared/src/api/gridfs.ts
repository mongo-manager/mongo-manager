// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { z } from 'zod'
import { isSpoofingChar } from '../chars'

/**
 * Phase 4b §1: GridFS buckets — the `<bucket>.files` / `<bucket>.chunks` pair — as files to list,
 * download, upload, rename, describe and delete.
 */

/** A bucket's name: what goes before `.files` (GridFS's default is `fs`). */
export const BucketNameSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)

export { isHiddenAt, isHiddenChar, isInvisibleChar, isSpoofingChar } from '../chars'

/** A stored file's name: any text a person may give it, nothing that hides or fakes its form. */
export const GridFsFileNameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (s) => ![...s].some((c) => isSpoofingChar(c.codePointAt(0)!)),
    'A file name may not hold control or direction characters',
  )

/** A file's id in a URL: its `_id` as canonical EJSON, base64url (any type of id, ObjectId or not). */
export const GridFsFileIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,512}$/)

export const GRIDFS_SORTS = ['uploadDate', 'filename', 'length'] as const
/** The furthest a page may start: past it, a name search finds the rest. */
export const GRIDFS_MAX_SKIP = 10_000
export const GridFsListQuerySchema = z.strictObject({
  /** The start of a name, any case. */
  q: z.string().min(1).max(200).optional(),
  /** Unset: the newest first, or the stored order where upload dates are personal data. */
  sort: z.enum(GRIDFS_SORTS).optional(),
  dir: z.enum(['asc', 'desc']).default('desc'),
  skip: z.coerce.number().int().min(0).max(GRIDFS_MAX_SKIP).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})
export type GridFsListQuery = z.infer<typeof GridFsListQuerySchema>

export const GridFsUploadQuerySchema = z.strictObject({
  filename: GridFsFileNameSchema,
  contentType: z
    .string()
    .max(127)
    .regex(/^[\w.+-]+\/[\w.+-]+$/)
    .optional(),
})

export const GridFsPatchSchema = z
  .strictObject({
    filename: GridFsFileNameSchema.optional(),
    /** Extended JSON; replaces the file's metadata. No key may start with `$` or hold a `.`. */
    metadata: z.record(z.string(), z.unknown()).nullable().optional(),
    /** The metadata's version shown (GridFsFile.version): a change of it is made only from that one. */
    version: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  })
  .refine((b) => b.filename !== undefined || b.metadata !== undefined, 'Nothing to change')
  .refine((b) => b.metadata === undefined || b.version !== undefined, {
    message: 'A change of metadata names the version it was made from',
    path: ['version'],
  })

export interface GridFsFile {
  /** For URLs (GridFsFileIdSchema); null where the `_id` is personal data (a restricted user). */
  id: string | null
  /** `***` where the name is personal data. */
  filename: string
  /** Null where hidden (see `masked`). */
  length: number | null
  chunkSize: number | null
  uploadDate: string | null
  contentType: string | null
  /** Canonical Extended JSON, masked inside by the `<bucket>.files` rules; null where all of it is hidden. */
  metadata: Record<string, unknown> | null
  /**
   * Data review 2026-10-13 (M3): the version of the metadata, which a change of it names; null for
   * a restricted user (who cannot change it).
   */
  version: string | null
  /** A field of the metadata the app would not write back as stored (see DocumentItem.caution). */
  caution: {
    kind: 'ejson_like' | 'undefined' | 'too_deep' | 'unmatched' | 'bad_date'
    field: string
    others?: number
  } | null
  /** The fields hidden from a restricted user (`_id`, `filename`, `length`, … `metadata`). */
  masked: string[]
}

export interface GridFsPage {
  files: GridFsFile[]
  /** The skip of the next page, or null. */
  next: number | null
  /**
   * User report 2026-10-27: personal data rules reach this bucket and hide values from the caller —
   * its files are listed masked, never downloaded, previewed or changed by them.
   */
  locked: boolean
}

export interface GridFsBucket {
  name: string
}
