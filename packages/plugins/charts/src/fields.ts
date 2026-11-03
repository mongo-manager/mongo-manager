/**
 * Plugins wave 2 (charts): the fields a sample of the collection holds and the kinds of their values,
 * read from canonical Extended JSON — what a chart can group by, sum or place on an axis.
 */
export type Doc = Record<string, unknown>
export type Kind = 'number' | 'date' | 'string' | 'bool' | 'objectId' | 'other'

export interface FieldInfo {
  path: string
  /** Documents holding the field. */
  count: number
  kinds: Partial<Record<Kind, number>>
}

const NUMBER_WRAPPERS = ['$numberInt', '$numberLong', '$numberDouble', '$numberDecimal']

/** An Extended JSON wrapper: an object whose only key starts with "$". */
export const isWrapper = (v: unknown): boolean => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const keys = Object.keys(v)
  return keys.length > 0 && keys.every((k) => k.startsWith('$'))
}

export function kindOf(v: unknown): Kind {
  if (typeof v === 'string') return 'string'
  if (typeof v === 'boolean') return 'bool'
  if (typeof v === 'number') return 'number'
  if (!v || typeof v !== 'object' || Array.isArray(v)) return 'other'
  const keys = Object.keys(v)
  if (keys.length !== 1) return 'other'
  const [k] = keys
  if (NUMBER_WRAPPERS.includes(k!)) return 'number'
  if (k === '$date') return 'date'
  if (k === '$oid') return 'objectId'
  return 'other'
}

/** The fields of the sampled documents, nested ones (two levels) by path, the most common first. */
export function fieldInfo(documents: Doc[], max = 60): FieldInfo[] {
  const fields = new Map<string, FieldInfo>()
  const walk = (doc: Doc, prefix: string, depth: number) => {
    for (const [k, v] of Object.entries(doc)) {
      const path = prefix ? `${prefix}.${k}` : k
      if (v && typeof v === 'object' && !Array.isArray(v) && !isWrapper(v) && depth < 2) {
        walk(v as Doc, path, depth + 1)
        continue
      }
      let info = fields.get(path)
      if (!info) {
        info = { path, count: 0, kinds: {} }
        fields.set(path, info)
      }
      info.count++
      const kind = kindOf(v)
      info.kinds[kind] = (info.kinds[kind] ?? 0) + 1
    }
  }
  for (const d of documents) walk(d, '', 0)
  return [...fields.values()].sort((a, b) => b.count - a.count || a.path.localeCompare(b.path)).slice(0, max)
}

/** The fields holding values of these kinds, those holding the most of them first. */
export function fieldsFor(info: FieldInfo[], kinds: Kind[]): string[] {
  const held = (f: FieldInfo) => kinds.reduce((n, k) => n + (f.kinds[k] ?? 0), 0)
  return info
    .filter((f) => held(f) > 0)
    .sort((a, b) => held(b) - held(a) || a.path.localeCompare(b.path))
    .map((f) => f.path)
}
