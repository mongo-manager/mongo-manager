import { matchesAny, underAny } from '@mongo-manager/shared/browser'
import type { SearchIndexList } from '@/api/documents'

/**
 * Plugins wave 4 (spec §5): a collection's search indexes as a plugin is told them — each index's
 * name, kind and state, and the fields it maps (a path and its type, a vector's dimensions and
 * similarity), never a field hidden from the user: as with validation rules (wave 3), a hidden
 * field's type is never told. Atlas's status message is left out (it may name any field), and so is
 * the rest of the definition (analyzers, synonyms, stored source).
 */
export interface PluginSearchField {
  path: string
  type: string
  numDimensions?: number
  similarity?: string
}
export interface PluginSearchIndex {
  name: string
  type: 'search' | 'vectorSearch'
  status: string
  queryable: boolean
  /** A search index mapping every field (its dynamic mapping on). */
  dynamic: boolean
  fields: PluginSearchField[]
}
export type PluginSearchIndexList =
  | { supported: true; indexes: PluginSearchIndex[] }
  | { supported: false; reason: 'not_enabled' | 'unsupported'; indexes: [] }

/** At most this many fields of one index are told. */
const MAX_FIELDS = 500
const DEPTH = 8

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

export function searchIndexesFor(
  list: SearchIndexList,
  patterns: readonly string[][],
): PluginSearchIndexList {
  if (!list.supported) return { supported: false, reason: list.reason, indexes: [] }
  const hidden = (path: readonly string[]) => matchesAny(patterns, path)
  const indexes = list.indexes.map((index): PluginSearchIndex => {
    const fields: PluginSearchField[] = []
    const add = (f: PluginSearchField) => {
      if (fields.length < MAX_FIELDS) fields.push(f)
    }
    const definition = isObject(index.definition) ? index.definition : {}
    let dynamic = false
    if (index.type === 'vectorSearch') {
      for (const f of Array.isArray(definition.fields) ? definition.fields : []) {
        if (!isObject(f) || typeof f.path !== 'string' || typeof f.type !== 'string') continue
        if (hidden(f.path.split('.'))) continue
        add({
          path: f.path,
          type: f.type,
          ...(typeof f.numDimensions === 'number' ? { numDimensions: f.numDimensions } : {}),
          ...(typeof f.similarity === 'string' ? { similarity: f.similarity } : {}),
        })
      }
    } else {
      const mappings = isObject(definition.mappings) ? definition.mappings : {}
      dynamic = mappings.dynamic === true || isObject(mappings.dynamic)
      const walk = (mapped: unknown, base: string[], depth: number) => {
        if (!isObject(mapped) || depth > DEPTH) return
        for (const [name, spec] of Object.entries(mapped)) {
          const path = [...base, name]
          if (hidden(path)) continue
          const specs = (Array.isArray(spec) ? spec : [spec]).filter(isObject)
          const types = specs.map((s) => s.type).filter((t): t is string => typeof t === 'string')
          const nested = specs.find((s) => s.type === 'document' || s.type === 'embeddedDocuments')
          if (nested) walk(nested.fields, path, depth + 1)
          // An object holding a hidden field is followed, never told as a whole.
          else if (types.length && !underAny(patterns, path)) add({ path: path.join('.'), type: types[0]! })
        }
      }
      walk(mappings.fields, [], 1)
    }
    return {
      name: index.name,
      type: index.type,
      status: index.status,
      queryable: index.queryable,
      dynamic,
      fields,
    }
  })
  return { supported: true, indexes }
}
