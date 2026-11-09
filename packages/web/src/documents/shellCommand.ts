// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { FindQuery, QueryPart } from './queryBuild'
import { decodeValue, toShell } from './values'

const shell = (value: unknown, indent = 0) => toShell(decodeValue(value), indent)

/** The parts of a run query that are set, each as shell text (the limit always is). */
export function queryParts(query: FindQuery, indent = 0): Array<{ part: QueryPart; text: string }> {
  const parts: Array<{ part: QueryPart; text: string }> = []
  if (Object.keys(query.filter).length > 0) parts.push({ part: 'filter', text: shell(query.filter, indent) })
  if (query.projection) parts.push({ part: 'projection', text: shell(query.projection, indent) })
  if (query.sort) parts.push({ part: 'sort', text: shell(query.sort, indent) })
  if (query.collation) parts.push({ part: 'collation', text: shell(query.collation, indent) })
  if (query.hint !== undefined)
    parts.push({
      part: 'hint',
      text: typeof query.hint === 'string' ? JSON.stringify(query.hint) : shell(query.hint, indent),
    })
  if (query.skip > 0) parts.push({ part: 'skip', text: String(query.skip) })
  parts.push({ part: 'limit', text: String(query.limit) })
  if (query.maxTimeMS !== undefined) parts.push({ part: 'maxTimeMS', text: String(query.maxTimeMS) })
  return parts
}

/**
 * The query as one mongosh command. The collection name is a JSON string, so quotes and backslashes in
 * it cannot break out of the call.
 */
export function findCommand(coll: string, query: FindQuery): string {
  const text = new Map(queryParts(query).map((p) => [p.part, p.text]))
  const filter = text.get('filter') ?? '{}'
  const projection = text.get('projection')
  let command = `db.getCollection(${JSON.stringify(coll)}).find(${filter}${projection ? `, ${projection}` : ''})`
  for (const part of ['sort', 'collation', 'hint', 'skip', 'limit', 'maxTimeMS'] as const) {
    const value = text.get(part)
    if (value !== undefined) command += `.${part}(${value})`
  }
  return command
}
