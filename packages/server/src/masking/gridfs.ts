// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { Masker } from './match'

/**
 * Security review 2026-10-13 (M2): a GridFS bucket's `<bucket>.chunks` collection is its files'
 * contents, whose download is denied where personal fields are hidden — through any path that
 * reads, copies, backs up, watches or writes it. Its `<bucket>.files` collection names them: a copy
 * or backup that cannot carry the contents leaves the bucket out whole.
 */
export const isFileContents = (coll: string): boolean => coll.endsWith('.chunks')

/** A GridFS bucket's collection: its files or their contents. */
export const isGridFsCollection = (coll: string): boolean =>
  coll.endsWith('.chunks') || coll.endsWith('.files')

/** The bucket a GridFS collection belongs to (`photos.chunks` → `photos`), or null for another. */
export function bucketOf(coll: string): string | null {
  if (coll.endsWith('.chunks')) return coll.slice(0, -'.chunks'.length)
  if (coll.endsWith('.files')) return coll.slice(0, -'.files'.length)
  return null
}

/**
 * User report 2026-10-27: where file contents are hidden — a bucket some personal data rule reaches
 * (its files, its chunks, every collection of its database or of every database). The rules say what
 * personal data is: a bucket none of them reaches holds none, and its files are anyone's to use who
 * may read them. False for a collection that is no bucket's, and for a caller who sees the values.
 */
export function bucketRuled(masker: Masker | null | undefined, db: string, coll: string): boolean {
  const bucket = bucketOf(coll)
  if (!masker || bucket === null) return false
  return masker.forNs(db, `${bucket}.files`).any || masker.forNs(db, `${bucket}.chunks`).any
}

/**
 * Writing `from` (a source collection's name) into `to` where rules may hide values: a bucket's
 * content written into a bucket a rule reaches there, or into a collection with rules (whatever its
 * name, a bucket's chunks cannot be checked for personal values). False when neither is a bucket's.
 */
export function bucketWriteRuled(
  masker: Masker | null | undefined,
  from: string,
  db: string,
  to: string,
): boolean {
  if (!masker || (!isGridFsCollection(from) && !isGridFsCollection(to))) return false
  return isGridFsCollection(to) ? bucketRuled(masker, db, to) : masker.forNs(db, to).any
}
