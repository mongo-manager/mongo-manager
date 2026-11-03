import type { SchemaAnalysis } from '@mongo-manager/shared/browser'

export interface SchemaColumn {
  path: string
  /** Some sampled value is an array: it can be expanded to one column per element. */
  array: boolean
  /** Personal data hidden from this user: exported as ***. */
  masked: boolean
}

/** Spec §5.4 / ExportRequest.fields: at most this many columns are sent. */
const MAX_COLUMNS = 500

/**
 * W4.2 (phase 3d-1 spec §5.4): CSV and Excel columns proposed from a schema sample — the leaf fields,
 * `_id` first. A field that is sometimes a sub-document and sometimes a value is one column holding
 * the whole value (as the server's own column sampling does); array elements are not columns here
 * (the export's array option decides).
 */
export function schemaColumns(schema: SchemaAnalysis): SchemaColumn[] {
  const fields = schema.fields.filter((f) => f.keys.length && f.keys.every((k) => k !== null))
  const key = (keys: Array<string | null>) => JSON.stringify(keys)
  const hasChildren = new Set<string>()
  for (const f of fields) for (let i = 1; i < f.keys.length; i++) hasChildren.add(key(f.keys.slice(0, i)))
  // A sub-document only, with fields below it, is no column itself: its fields are.
  const containers = new Set(
    fields
      .filter((f) => hasChildren.has(key(f.keys)) && Object.keys(f.types).every((t) => t === 'object'))
      .map((f) => key(f.keys)),
  )
  const kept = fields.filter((f) => !containers.has(key(f.keys)))
  const keptKeys = new Set(kept.map((f) => key(f.keys)))
  // A column holding the whole value takes the place of the columns below it.
  const below = (keys: Array<string | null>) =>
    keys.slice(0, -1).some((_, i) => keptKeys.has(key(keys.slice(0, i + 1))))
  const columns = kept
    .filter((f) => !below(f.keys))
    .map((f) => ({
      path: f.keys.join('.'),
      array: (f.types.array ?? 0) > 0,
      masked: f.masked === true,
    }))
  const id = columns.findIndex((c) => c.path === '_id')
  if (id > 0) columns.unshift(...columns.splice(id, 1))
  return columns.slice(0, MAX_COLUMNS)
}
