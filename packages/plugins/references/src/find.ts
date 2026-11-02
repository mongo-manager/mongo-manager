import { inferRelations, LABEL_PROJECTION, nameOf, objectIdFields, orderCollections, type Doc } from './infer'

/**
 * References (redesigned 2026-10-10, spec plugin-tabs-redesign §2.6): a sample of the collection,
 * its fields holding ObjectIds, and the collections of its database those ids are found in — each
 * read bounded (200 sampled documents, 200 ids, at most 50 collections, stopping once every field
 * is mostly found).
 */
export const SAMPLE = 200

export interface Relation {
  path: string
  coll: string
  share: number
  /** Distinct sampled ids of the field, and how many of them the collection holds. */
  sampled: number
  matched: number
  /** The sampled ids the collection does not hold. */
  missing: string[]
  /** What a few of the found documents are called (their naming field), in sample order. */
  names: string[]
}
export interface Found {
  sampled: number
  fields: number
  relations: Relation[]
  unmatched: string[]
  looked: number
  of: number
  /** Why it stopped before looking everywhere (what it found stays). */
  stopped: unknown
}

type Ask = <T>(method: string, params?: unknown) => Promise<T>

const idOf = (d: Doc): string | null => {
  const id = (d._id as { $oid?: unknown } | undefined)?.$oid
  return typeof id === 'string' ? id.toLowerCase() : null
}

export async function findReferences(
  ask: Ask,
  progress: (step: { looking: number; of: number } | null) => void,
): Promise<Found> {
  progress(null)
  // A random sample, not the first documents (review M7).
  const sample = await ask<{ documents: Doc[] }>('documents.aggregate', {
    pipeline: [{ $sample: { size: { $numberInt: String(SAMPLE) } } }],
    limit: SAMPLE,
  })
  const fields = objectIdFields(sample.documents)
  const base = { sampled: sample.documents.length, fields: fields.length }
  if (!fields.length) return { ...base, relations: [], unmatched: [], looked: 0, of: 0, stopped: null }
  const list = await ask<Array<{ name: string; type: string }>>('collections.list')
  const order = orderCollections(
    list,
    fields.map((f) => f.path),
  )
  const all = [...new Set(fields.flatMap((f) => f.ids))].slice(0, 200)
  // Only the naming fields come back: a found document's name, never the whole document.
  const projection = LABEL_PROJECTION
  const found: Array<{ coll: string; ids: Set<string>; names: Map<string, string> }> = []
  let stopped: unknown = null
  let looked = 0
  for (const [n, coll] of order.entries()) {
    progress({ looking: n + 1, of: order.length })
    try {
      const answer = await ask<{ documents: Doc[] }>('documents.findIn', {
        coll,
        filter: { _id: { $in: all.map((id) => ({ $oid: id })) } },
        projection,
        limit: 200,
      })
      looked = n + 1
      const names = new Map<string, string>()
      const ids = new Set<string>()
      for (const d of answer.documents) {
        const id = idOf(d)
        if (!id) continue
        ids.add(id)
        const name = nameOf(d)
        if (name !== null) names.set(id, name)
      }
      if (ids.size) found.push({ coll, ids, names })
    } catch (e) {
      stopped = e
      break
    }
    // Every field mostly found: the rest of the collections need not be read.
    const { relations } = inferRelations(fields, found)
    if (relations.length === fields.length && relations.every((r) => r.share >= 0.8)) break
  }
  const { relations, unmatched } = inferRelations(fields, found)
  return {
    ...base,
    relations: relations.map((r) => {
      const field = fields.find((f) => f.path === r.path)!
      const target = found.find((c) => c.coll === r.coll)!
      const hit = field.ids.filter((id) => target.ids.has(id))
      return {
        ...r,
        sampled: field.ids.length,
        matched: hit.length,
        missing: field.ids.filter((id) => !target.ids.has(id)),
        names: [...new Set(hit.flatMap((id) => target.names.get(id) ?? []))].slice(0, 3),
      }
    }),
    unmatched,
    looked,
    of: order.length,
    stopped,
  }
}
