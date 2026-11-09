// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { AskError } from '../../kit/src/client'
import { LABEL_PROJECTION, type Doc } from './infer'

/**
 * Referenced by (research 2026-10-28: CUSTOMER-I-6695): the documents of a database that refer to
 * one document. The database's model (one read: the references its Database tab draws, found from
 * field names, sampled values and $lookup stages) says which fields of which collections refer to
 * this collection's _id; each such field is then asked once for this document's id.
 */
export interface Referrer {
  from: string
  /** The field as MongoDB names it (an array's elements by the array's path). */
  path: string
}

export interface ReferringGroup extends Referrer {
  documents: Doc[]
  /** More documents than are listed. */
  more: boolean
}

export interface Referred {
  groups: ReferringGroup[]
  /** Fields that could not be asked, and why. */
  failed: Array<Referrer & { error: unknown }>
  /** Fields left unasked past the minute's reads: the rest would fail too (review 2026-10-28). */
  limited: Referrer[]
  /** Fields asked (the model's references to this collection). */
  asked: number
}

/** Documents listed per field, and fields asked, at most. */
export const PER_FIELD = 20
export const MAX_FIELDS = 20

interface ModelLike {
  collections?: Array<{ name: string; type: string }>
  references?: Array<{ from: string; field: string; to: string; toField: string }>
}

/** The fields the model says refer to `coll`'s _id, in collections (not views), once each. */
export function referrersOf(model: unknown, coll: string): Referrer[] {
  const m = (model ?? {}) as ModelLike
  const views = new Set((m.collections ?? []).filter((c) => c.type === 'view').map((c) => c.name))
  const seen = new Set<string>()
  const out: Referrer[] = []
  for (const r of m.references ?? []) {
    if (r.to !== coll || r.toField !== '_id' || views.has(r.from)) continue
    // The model writes an array's elements as "[]": MongoDB reaches them by the array's path.
    const path = r.field
      .replace(/\[\]/g, '')
      .replace(/\.{2,}/g, '.')
      .replace(/^\.|\.$/g, '')
    const key = `${r.from}\u0000${path}`
    if (!path || seen.has(key)) continue
    seen.add(key)
    out.push({ from: r.from, path })
  }
  return out.sort((a, b) => a.from.localeCompare(b.from) || a.path.localeCompare(b.path)).slice(0, MAX_FIELDS)
}

/** The filter selecting a field's documents that refer to `id` (an array holding it too). */
export const referringFilter = (path: string, id: unknown): Doc => ({ [path]: id })

type Ask = <T>(method: string, params?: unknown) => Promise<T>

export async function findReferring(ask: Ask, coll: string, id: unknown): Promise<Referred> {
  const model = await ask<unknown>('database.model')
  const referrers = referrersOf(model, coll)
  const groups: ReferringGroup[] = []
  const failed: Referred['failed'] = []
  const limited: Referrer[] = []
  // Their names come back, never the whole documents.
  const projection = LABEL_PROJECTION
  for (const [n, r] of referrers.entries()) {
    try {
      // User report 2026-11-07: the documents whose names fit in one answer; the rest are "more".
      const found = await ask<{ documents: Doc[]; cut?: boolean }>('documents.findIn', {
        coll: r.from,
        filter: referringFilter(r.path, id),
        projection,
        limit: PER_FIELD + 1,
        fit: true,
      })
      if (found.documents.length)
        groups.push({
          ...r,
          documents: found.documents.slice(0, PER_FIELD),
          more: found.documents.length > PER_FIELD || !!found.cut,
        })
    } catch (error) {
      if (error instanceof AskError && error.code === 'too_many') {
        limited.push(...referrers.slice(n))
        break
      }
      failed.push({ ...r, error })
    }
  }
  return { groups, failed, limited, asked: referrers.length }
}
