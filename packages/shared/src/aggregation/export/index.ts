// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { LANGUAGES, type CollationSpec, type FindParts, type Syntax } from './languages'
import { toValue, type Value } from './values'

/** Phase 2a spec §4.6: the driver languages a pipeline can be exported to, in menu order. */
export const EXPORT_LANGUAGES = ['node', 'python', 'java', 'go', 'csharp', 'php', 'ruby', 'rust'] as const
export type ExportLanguage = (typeof EXPORT_LANGUAGES)[number]

function render(syntax: Syntax, value: Value, indent: string): string {
  if (value.k === 'doc')
    return syntax.doc(
      value.entries.map(([k, v]) => [k, render(syntax, v, `${indent}  `)]),
      indent,
    )
  if (value.k === 'array')
    return syntax.array(
      value.items.map((v) => render(syntax, v, `${indent}  `)),
      indent,
    )
  return syntax.scalar(value)
}

/**
 * A complete program that runs the pipeline with that language's official driver. The connection
 * string is read from the MONGODB_URI environment variable, never written into the code.
 */
export function exportPipeline(
  language: ExportLanguage,
  input: { db: string; coll: string; stages: readonly unknown[] },
): string {
  const syntax = LANGUAGES[language]()
  const stages = input.stages.map((s) => syntax.stage(render(syntax, toValue(s), syntax.indent)))
  // Rendered before the program: the Go snippet imports only what the values used.
  const pipeline = syntax.stages(stages)
  return syntax.program({ db: input.db, coll: input.coll }, pipeline)
}

/** A Documents query to export (plugins wave 2): decoded BSON values, as the query bar holds them. */
export interface FindExport {
  db: string
  coll: string
  filter: unknown
  projection?: unknown
  sort?: unknown
  collation?: unknown
  /** An index's name, or its key pattern. */
  hint?: unknown
  skip?: number
  limit?: number
  maxTimeMS?: number
}

const hasFields = (v: unknown): boolean =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0

/** A number as written in a document (a plain number or an Int32, Long or Double). */
const numberOf = (v: unknown): number => Number(typeof v === 'object' && v !== null ? String(v) : v)

/** A collation the builders can write, or an error saying which part cannot be. */
function collationOf(raw: unknown): CollationSpec {
  const o = raw as Record<string, unknown>
  const refuse = (part: string): never => {
    throw new Error(`The collation's ${part} cannot be exported`)
  }
  if (typeof o.locale !== 'string') refuse('locale')
  const spec: CollationSpec = { locale: o.locale as string }
  const bool = (key: 'caseLevel' | 'numericOrdering' | 'normalization' | 'backwards') => {
    if (o[key] === undefined) return
    if (typeof o[key] !== 'boolean') refuse(key)
    spec[key] = o[key] as boolean
  }
  const oneOf = <K extends 'caseFirst' | 'alternate' | 'maxVariable'>(key: K, allowed: readonly string[]) => {
    if (o[key] === undefined) return
    if (typeof o[key] !== 'string' || !allowed.includes(o[key] as string)) refuse(key)
    spec[key] = o[key] as CollationSpec[K]
  }
  bool('caseLevel')
  oneOf('caseFirst', ['upper', 'lower', 'off'])
  if (o.strength !== undefined) {
    const n = numberOf(o.strength)
    if (![1, 2, 3, 4, 5].includes(n)) refuse('strength')
    spec.strength = n as CollationSpec['strength']
  }
  bool('numericOrdering')
  oneOf('alternate', ['non-ignorable', 'shifted'])
  oneOf('maxVariable', ['punct', 'space'])
  bool('normalization')
  bool('backwards')
  const known = new Set([
    'locale',
    'caseLevel',
    'caseFirst',
    'strength',
    'numericOrdering',
    'alternate',
    'maxVariable',
    'normalization',
    'backwards',
  ])
  for (const key of Object.keys(o)) if (!known.has(key)) refuse(key)
  return spec
}

/**
 * Plugins wave 2: a Documents query as a complete program for that language's official driver —
 * filter, projection, sort, collation, hint, skip and limit through the driver's own options. As
 * for a pipeline, the connection string is read from MONGODB_URI, never written into the code.
 */
export function exportFind(language: ExportLanguage, input: FindExport): string {
  const syntax = LANGUAGES[language]()
  // The filter where its statement starts; an option's document inside the options (review M11).
  const doc = (v: unknown, at = syntax.findIndent) => render(syntax, toValue(v), at)
  const option = (v: unknown) => doc(v, syntax.optionIndent)
  const pairs = (v: unknown): Array<[string, string]> => {
    const value = toValue(v)
    if (value.k !== 'doc') throw new Error('Not a document')
    return value.entries.map(([k, x]) => [k, render(syntax, x, syntax.optionIndent)])
  }
  const parts: FindParts = { filter: doc(input.filter ?? {}) }
  if (hasFields(input.projection)) parts.projection = option(input.projection)
  if (hasFields(input.sort)) {
    parts.sort = option(input.sort)
    parts.sortPairs = pairs(input.sort)
  }
  if (hasFields(input.collation)) {
    parts.collation = collationOf(input.collation)
    parts.collationDoc = option(input.collation)
  }
  if (typeof input.hint === 'string' && input.hint !== '') parts.hint = { name: input.hint }
  else if (hasFields(input.hint)) parts.hint = { keys: option(input.hint), pairs: pairs(input.hint) }
  if (input.skip) parts.skip = input.skip
  if (input.limit) parts.limit = input.limit
  if (input.maxTimeMS) parts.maxTimeMS = input.maxTimeMS
  // Rendered before the program: the Go snippet imports only what the values used.
  const { body, imports } = syntax.findBody(parts)
  return syntax.program({ db: input.db, coll: input.coll, find: true }, '', body, imports)
}

/** A string as a literal of that language (exported for the escaping tests). */
export function stringLiteral(language: ExportLanguage, text: string): string {
  return LANGUAGES[language]().str(text)
}
