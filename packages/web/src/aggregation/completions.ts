// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { Completion } from '@/ds/code/completion'
import { completionsFor } from '@/documents/completions'

/** Aggregation expression and accumulator operators offered in stage editors (phase 2a spec §4.2). */
const EXPRESSION_OPERATORS = [
  '$abs',
  '$add',
  '$addToSet',
  '$allElementsTrue',
  '$and',
  '$anyElementTrue',
  '$arrayElemAt',
  '$arrayToObject',
  '$avg',
  '$ceil',
  '$cmp',
  '$concat',
  '$concatArrays',
  '$cond',
  '$convert',
  '$dateAdd',
  '$dateDiff',
  '$dateFromString',
  '$dateToString',
  '$dateTrunc',
  '$dayOfMonth',
  '$divide',
  '$eq',
  '$filter',
  '$first',
  '$floor',
  '$gt',
  '$gte',
  '$ifNull',
  '$in',
  '$indexOfArray',
  '$isArray',
  '$last',
  '$let',
  '$literal',
  '$lt',
  '$lte',
  '$map',
  '$max',
  '$mergeObjects',
  '$min',
  '$mod',
  '$month',
  '$multiply',
  '$ne',
  '$not',
  '$objectToArray',
  '$or',
  '$push',
  '$reduce',
  '$regexMatch',
  '$round',
  '$setUnion',
  '$size',
  '$slice',
  '$split',
  '$strLenCP',
  '$substrCP',
  '$subtract',
  '$sum',
  '$switch',
  '$toBool',
  '$toDate',
  '$toDouble',
  '$toInt',
  '$toLong',
  '$toLower',
  '$toObjectId',
  '$toString',
  '$toUpper',
  '$trim',
  '$type',
  '$year',
  '$zip',
]

/** Query and expression operators, constructors, and the field paths of the stage's input. */
export function stageCompletions(fields: readonly string[]): Completion[] {
  const base = completionsFor('query', fields)
  const known = new Set(base.map((c) => c.label))
  const extra = EXPRESSION_OPERATORS.filter((op) => !known.has(op)).map((label): Completion => ({
    label,
    kind: 'operator',
  }))
  // Fields also as "$field" references, which expressions use.
  const refs = fields.map((f): Completion => ({ label: `$${f}`, kind: 'field' }))
  return [...base, ...extra, ...refs]
}
