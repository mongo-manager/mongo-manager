import { pick, type Language } from '../../kit/src/i18n'
import { LABEL_PROJECTION, candidates, labelOf, type Doc } from './infer'

/**
 * Plugins wave 2 (references): the cell renderer. Beside an ObjectId in a field named like a
 * collection of the same database (customerId → customers), the referenced document's name — or
 * "not found" for a dangling reference. Where a field refers to is learnt once per collection and
 * field, the names read in batches and kept; a refused read answers nothing and is tried again.
 */
export interface Place {
  connectionId: string
  db: string
  coll: string
}
export type Ask = <T>(method: string, params?: unknown) => Promise<T>
type Answer = { text: string; tone: 'info' | 'warning' } | { retry: true } | null

export const MISSING = {
  en: 'not found',
  tr: 'bulunamadı',
  zh: '未找到',
  ja: '見つかりません',
  es: 'no encontrado',
  pt: 'não encontrado',
  ko: '찾을 수 없음',
  de: 'nicht gefunden',
  fr: 'introuvable',
  ru: 'не найдено',
} satisfies Record<Language, string>
const MAX_LABELS = 5000
const LIST_FOR_MS = 60_000

const oidOf = (v: unknown): string | null => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  return Object.keys(o).length === 1 && typeof o.$oid === 'string' ? o.$oid.toLowerCase() : null
}

export function createRenderer(ask: Ask) {
  const lists = new Map<string, { at: number; names: string[] }>()
  /** Where a field of a collection refers to (null: nowhere found). */
  const targets = new Map<string, string | null>()
  /** Names of referenced documents ('' for one not found). */
  const labels = new Map<string, string>()
  const db = (p: Place) => JSON.stringify([p.connectionId, p.db])
  const labelKey = (p: Place, coll: string, id: string) => JSON.stringify([p.connectionId, p.db, coll, id])

  async function collections(p: Place): Promise<string[]> {
    const known = lists.get(db(p))
    if (known && Date.now() - known.at < LIST_FOR_MS) return known.names
    const list = await ask<Array<{ name: string; type: string }>>('collections.list', { place: p })
    const names = list.filter((c) => c.type !== 'view').map((c) => c.name)
    lists.set(db(p), { at: Date.now(), names })
    return names
  }

  /** Reads the names of these documents of a collection; how many were found. */
  async function read(p: Place, coll: string, ids: string[]): Promise<number> {
    const projection = LABEL_PROJECTION
    const { documents } = await ask<{ documents: Doc[] }>('documents.findIn', {
      place: p,
      coll,
      filter: { _id: { $in: ids.map((id) => ({ $oid: id })) } },
      projection,
      limit: 200,
    })
    if (labels.size > MAX_LABELS) labels.clear()
    const found = new Set<string>()
    for (const d of documents) {
      const id = oidOf(d._id)
      if (!id) continue
      found.add(id)
      labels.set(labelKey(p, coll, id), labelOf(d))
    }
    for (const id of ids) if (!found.has(id)) labels.set(labelKey(p, coll, id), '')
    return found.size
  }

  return async function render(
    values: unknown[],
    paths: Array<string | null>,
    place: Place | null,
    locale: string,
  ): Promise<Answer[]> {
    if (!place) return values.map(() => null)
    const byPath = new Map<string, Set<string>>()
    values.forEach((v, i) => {
      const id = oidOf(v)
      const path = paths[i]
      if (!id || !path || path === '_id') return
      let ids = byPath.get(path)
      if (!ids) byPath.set(path, (ids = new Set()))
      ids.add(id)
    })
    /** Paths whose read was refused: the app asks about them again later (review M2). */
    const failed = new Set<string>()
    for (const [path, set] of byPath) {
      const key = JSON.stringify([place.connectionId, place.db, place.coll, path])
      const ids = [...set].slice(0, 200)
      try {
        let target = targets.get(key)
        if (target === undefined) {
          target = null
          for (const coll of candidates(path, await collections(place)).slice(0, 2))
            if ((await read(place, coll, ids)) > 0) {
              target = coll
              break
            }
          targets.set(key, target)
        } else if (target) {
          const coll = target
          const unknown = ids.filter((id) => !labels.has(labelKey(place, coll, id)))
          if (unknown.length) await read(place, coll, unknown)
        }
      } catch {
        // Refused (too many reads, rights): the app is asked to ask again later.
        failed.add(path)
      }
    }
    return values.map((v, i) => {
      const id = oidOf(v)
      const path = paths[i]
      if (!id || !path) return null
      if (failed.has(path)) return { retry: true }
      const target = targets.get(JSON.stringify([place.connectionId, place.db, place.coll, path]))
      if (!target) return null
      const label = labels.get(labelKey(place, target, id))
      if (label === undefined) return null
      return label
        ? { text: `→ ${label}`, tone: 'info' }
        : { text: `→ ${pick(MISSING, locale)}`, tone: 'warning' }
    })
  }
}
