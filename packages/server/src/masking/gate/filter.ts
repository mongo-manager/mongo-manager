// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { Document } from 'mongodb'
import { Errors } from '../../errors'
import type { Shape } from './shape'
import type { GateCtx } from './context'
import { holdsDocument, isDocument, isOperatorDoc } from './values'
import { guardValue } from './expression'
import { notSupported, personalField } from './refusal'

const LOGICAL = new Set(['$and', '$or', '$nor'])
/** Operands that are names, types, counts or patterns over strings: no stored value is compared. */
const STRUCTURE = new Set([
  '$exists',
  '$type',
  '$size',
  '$regex',
  '$options',
  '$mod',
  '$bitsAllSet',
  '$bitsAllClear',
  '$bitsAnySet',
  '$bitsAnyClear',
])
const COMPARE = new Set(['$eq', '$ne', '$gt', '$gte', '$lt', '$lte'])
const LISTS = new Set(['$in', '$nin', '$all'])
const GEO = new Set(['$geoWithin', '$geoIntersects', '$near', '$nearSphere', '$maxDistance', '$minDistance'])
/** Allowed only where no rule applies: they read fields the gate cannot see ($text reads the text index's). */
const UNRULED_ONLY = new Set(['$text', '$jsonSchema'])

/**
 * Phase 3c §3.1: a filter as a restricted user may run it. A personal field is refused whatever
 * the operator; on a path that may hold personal data only scalars are compared (MongoDB never
 * matches a scalar against a sub-document). Only $expr changes: its references are guarded.
 */
export function guardFilter(
  filter: unknown,
  shape: Shape,
  gc: GateCtx,
  prefix: readonly string[] = [],
): Document {
  if (!isDocument(filter)) throw Errors.validation('A filter must be a document')
  const out: Document = {}
  for (const [key, value] of Object.entries(filter)) {
    if (key.startsWith('$')) {
      if (LOGICAL.has(key)) {
        if (!Array.isArray(value)) throw Errors.validation(`${key} takes an array of filters`)
        out[key] = value.map((f) => guardFilter(f, shape, gc, prefix))
      } else if (key === '$expr' && prefix.length === 0) out[key] = guardValue(value, shape, gc)
      else if (key === '$comment') out[key] = value
      else if (UNRULED_ONLY.has(key) && !shape.any && prefix.length === 0) out[key] = value
      else throw notSupported(key, shape.ns)
      continue
    }
    guardCondition(value, shape, gc, [...prefix, ...key.split('.')])
    out[key] = value
  }
  return out
}

function guardCondition(value: unknown, shape: Shape, gc: GateCtx, path: readonly string[]): void {
  const field = path.join('.')
  if (shape.personal(path)) throw personalField(field, shape.ns)
  const clean = !shape.mayHold(path)
  if (!isOperatorDoc(value)) {
    if (!clean && holdsDocument(value)) throw personalField(field, shape.ns)
    return
  }
  for (const [op, operand] of Object.entries(value)) {
    if (STRUCTURE.has(op)) continue
    if (COMPARE.has(op)) {
      if (!clean && holdsDocument(operand)) throw personalField(field, shape.ns)
    } else if (LISTS.has(op)) {
      if (!clean && Array.isArray(operand) && operand.some(holdsDocument))
        throw personalField(field, shape.ns)
    } else if (op === '$elemMatch') guardElemMatch(operand, shape, gc, path)
    else if (op === '$not') guardCondition(operand, shape, gc, path)
    else if (GEO.has(op)) {
      if (!clean) throw personalField(field, shape.ns)
    } else throw notSupported(op, shape.ns)
  }
}

/** Element operators on the array's own values, or a filter over its elements' fields. */
function guardElemMatch(operand: unknown, shape: Shape, gc: GateCtx, path: readonly string[]): void {
  if (isOperatorDoc(operand) && !Object.keys(operand).some((k) => LOGICAL.has(k) || k === '$expr'))
    guardCondition(operand, shape, gc, path)
  else guardFilter(operand, shape, gc, path)
}

/** The field paths a filter names, through $and/$or/$nor and $elemMatch. */
export function filterPaths(filter: unknown, prefix: string[] = []): string[][] {
  if (!isDocument(filter)) return []
  const out: string[][] = []
  for (const [key, value] of Object.entries(filter)) {
    if (LOGICAL.has(key) && Array.isArray(value)) out.push(...value.flatMap((f) => filterPaths(f, prefix)))
    else if (!key.startsWith('$')) {
      const path = [...prefix, ...key.split('.')]
      out.push(path)
      if (isDocument(value) && isDocument(value.$elemMatch)) out.push(...filterPaths(value.$elemMatch, path))
    }
  }
  return out
}
