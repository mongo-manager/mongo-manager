import { EJSON, type Document } from 'bson'
import type { EncryptedFieldInfo, EncryptedFieldKind } from '@mongo-manager/shared'

/**
 * W8 (completion): which fields of a collection are encrypted, for the UI's marks and the copy
 * paths. Queryable Encryption keeps them in the collection's options (encryptedFields); CSFLE in a
 * $jsonSchema with `encrypt` (the server's validator, or the connection's own schema map).
 */
const MAX_FIELDS = 500
const MAX_DEPTH = 20

function kindOf(encrypt: Document): EncryptedFieldKind {
  return String(encrypt.algorithm ?? '').includes('Deterministic') ? 'deterministic' : 'random'
}

/** The `encrypt` paths of a $jsonSchema (properties, nested objects), bounded. */
export function schemaPaths(schema: unknown, source: EncryptedFieldInfo['source']): EncryptedFieldInfo[] {
  const out: EncryptedFieldInfo[] = []
  const walk = (node: unknown, prefix: string, depth: number) => {
    if (!node || typeof node !== 'object' || depth > MAX_DEPTH || out.length >= MAX_FIELDS) return
    const n = node as Document
    if (n.encrypt && typeof n.encrypt === 'object' && prefix) {
      out.push({
        path: prefix,
        kind: kindOf(n.encrypt as Document),
        ...(typeof (n.encrypt as Document).bsonType === 'string'
          ? { bsonType: (n.encrypt as Document).bsonType }
          : {}),
        source,
      })
      return
    }
    const props = n.properties
    if (props && typeof props === 'object')
      for (const [k, v] of Object.entries(props as Document))
        walk(v, prefix ? `${prefix}.${k}` : k, depth + 1)
  }
  walk(schema, '', 0)
  return out
}

/** Queryable Encryption's fields (collection options, or an encryptedFieldsMap entry). */
export function queryablePaths(
  encryptedFields: unknown,
  source: EncryptedFieldInfo['source'],
): EncryptedFieldInfo[] {
  const fields = (encryptedFields as { fields?: unknown } | undefined)?.fields
  if (!Array.isArray(fields)) return []
  return fields.slice(0, MAX_FIELDS).flatMap((f): EncryptedFieldInfo[] => {
    if (!f || typeof f !== 'object' || typeof (f as Document).path !== 'string') return []
    const queries = (f as Document).queries
    const first = Array.isArray(queries) ? queries[0] : queries
    return [
      {
        path: (f as Document).path as string,
        kind: 'queryable',
        ...(typeof (f as Document).bsonType === 'string'
          ? { bsonType: (f as Document).bsonType as string }
          : {}),
        ...(first && typeof first.queryType === 'string' ? { queryType: first.queryType as string } : {}),
        source,
      },
    ]
  })
}

/**
 * W8 × W6: client-side encryption's own collections — the connection's key vault (its data keys,
 * however wrapped) and Queryable Encryption's metadata (enxcol_.*). Never read for an AI provider.
 */
export function isEncryptionMetadata(
  encryption: { enabled?: boolean; keyVaultNamespace?: string } | undefined,
  db: string,
  coll: string,
): boolean {
  if (coll.startsWith('enxcol_.')) return true
  return encryption?.enabled === true && encryption.keyVaultNamespace === `${db}.${coll}`
}

/** The $jsonSchema of a validator, when it is one. */
const jsonSchemaOf = (options: Document | undefined): unknown =>
  (options?.validator as Document | undefined)?.$jsonSchema

/** A CSFLE collection: its validator encrypts at least one field. */
export function isCsfleCollection(options: Document | undefined): boolean {
  return schemaPaths(jsonSchemaOf(options), 'server').length > 0
}

function mapEntry(text: string | undefined, ns: string): unknown {
  if (!text?.trim()) return undefined
  try {
    return (EJSON.parse(text, { relaxed: false }) as Document)[ns]
  } catch {
    return undefined
  }
}

/** Every encrypted field of a collection, from the server's options and the connection's maps. */
export function encryptedFields(
  options: Document | undefined,
  ns: string,
  maps: { schemaMap?: string | undefined; encryptedFieldsMap?: string | undefined } = {},
): { kind: 'queryable' | 'csfle' | null; fields: EncryptedFieldInfo[] } {
  const qe = [
    ...queryablePaths(options?.encryptedFields, 'server'),
    ...queryablePaths(mapEntry(maps.encryptedFieldsMap, ns), 'connection'),
  ]
  const csfle = [
    ...schemaPaths(jsonSchemaOf(options), 'server'),
    ...schemaPaths(mapEntry(maps.schemaMap, ns), 'connection'),
  ]
  const seen = new Set<string>()
  const fields = [...qe, ...csfle].filter((f) => !seen.has(f.path) && !!seen.add(f.path))
  return { kind: qe.length ? 'queryable' : csfle.length ? 'csfle' : null, fields }
}
