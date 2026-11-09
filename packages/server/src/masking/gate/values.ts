// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { Document } from 'mongodb'

/** A plain sub-document: not an array, not a BSON value (ObjectId, Date, Decimal128, regex, …). */
export function isDocument(v: unknown): v is Document {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  if (v instanceof Date || v instanceof RegExp) return false
  // A DBRef is stored as the sub-document { $ref, $id } (final review M2).
  const tag = (v as { _bsontype?: unknown })._bsontype
  if (typeof tag === 'string') return tag === 'DBRef'
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

type Ref = { _bsontype: 'DBRef'; collection: string; oid: unknown; db?: string; fields: Document }
export const isDbRef = (v: unknown): v is Ref =>
  typeof v === 'object' && v !== null && (v as { _bsontype?: unknown })._bsontype === 'DBRef'

/**
 * A document's fields as stored. A DBRef is { $ref, $id, $db?, …fields } in the database, so its
 * extra fields are walked where they will be (final review I2), not as the class's properties.
 */
export function fieldsOf(v: Document): Document {
  if (!isDbRef(v)) return v
  return { $ref: v.collection, $id: v.oid, ...(v.db ? { $db: v.db } : {}), ...v.fields }
}

/** The stored field `key` of a document, or undefined; own fields only ("constructor" is a name). */
export function fieldOf(v: Document, key: string): { value: unknown } | undefined {
  const fields = fieldsOf(v)
  return Object.hasOwn(fields, key) ? { value: fields[key] } : undefined
}

/** Sets the stored field `key`, on a DBRef its collection, id, database or an extra field. */
export function setField(v: Document, key: string, value: unknown): void {
  if (!isDbRef(v)) v[key] = value
  else if (key === '$ref') v.collection = value as string
  else if (key === '$id') v.oid = value
  else if (key === '$db') v.db = value as string
  else v.fields[key] = value
}

/** The value is, or holds in its arrays at any depth, a sub-document. */
export const holdsDocument = (v: unknown): boolean =>
  isDocument(v) || (Array.isArray(v) && v.some(holdsDocument))

/** `{ $gt: 1, $lt: 5 }`: every key an operator. */
export const isOperatorDoc = (v: unknown): v is Document =>
  isDocument(v) && Object.keys(v).length > 0 && Object.keys(v).every((k) => k.startsWith('$'))

const NUMBER_TYPES = new Set(['Int32', 'Double', 'Long', 'Decimal128'])
/** A projection flag (1, 0, true, false), in any of the forms decoded EJSON gives it. */
export const isNumberLike = (v: unknown): boolean =>
  typeof v === 'number' ||
  typeof v === 'boolean' ||
  (typeof v === 'object' && v !== null && NUMBER_TYPES.has(String((v as { _bsontype?: unknown })._bsontype)))
