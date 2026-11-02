import {
  MAX_QUERY_PARAMS,
  QueryParseError,
  fillParams,
  paramsOf,
  parseQueryObject,
  serializeValue,
  type ParamFillError,
} from '@mongo-manager/shared/browser'

export const PAGE_SIZES = [10, 20, 50, 100, 250, 500, 1000] as const

/** What the user typed; kept per tab. */
export interface QueryDraft {
  filter: string
  projection: string
  sort: string
  skip: string
  limit: number
  collation: string
  /** An index name, or a key document. */
  hint: string
  maxTimeMS: string
  /** Query parameters (spec 2026-10-28): each `{{name}}`'s value, as typed in its field. */
  params?: Record<string, string>
}

/** What is sent: canonical EJSON parts and numbers. */
export interface FindQuery {
  filter: Record<string, unknown>
  projection?: Record<string, unknown>
  sort?: Record<string, unknown>
  collation?: Record<string, unknown>
  hint?: string | Record<string, unknown>
  maxTimeMS?: number
  skip: number
  limit: number
}

export type QueryField =
  'filter' | 'projection' | 'sort' | 'collation' | 'hint' | 'skip' | 'maxTimeMS' | 'params'

/** The parts a favourite keeps, as typed: canonical EJSON, its parameters as markers. */
export type FindTemplate = Pick<FindQuery, 'filter' | 'projection' | 'sort' | 'collation' | 'hint'>

export type BuildResult =
  | {
      ok: true
      /** What runs: the parameters' values filled in. */
      query: FindQuery
      /** The parameters the parts hold, in the order they first appear. */
      params: string[]
      /** With parameters: the parts as typed, for a favourite. */
      template?: FindTemplate
    }
  | { ok: false; field: Exclude<QueryField, 'params'>; message: string; line?: number; column?: number }
  | {
      ok: false
      field: 'params'
      /** The first parameter with no value. */
      message: string
      errors: Record<string, ParamFillError>
      /** Why a value written as code cannot be read, by parameter. */
      messages: Record<string, string>
      params: string[]
      template: FindTemplate
    }

export const emptyDraft = (): QueryDraft => ({
  filter: '',
  projection: '',
  sort: '',
  skip: '',
  limit: 20,
  collation: '',
  hint: '',
  maxTimeMS: '',
})

/** The server's FindRequestSchema bounds. */
export const MAX_TIME_MS = { min: 100, max: 300_000 } as const
const MAX_HINT_NAME = 512
export const defaultQuery = (): FindQuery => ({ filter: {}, skip: 0, limit: 20 })

/**
 * Parses each part with the safe shell parser (no eval) and encodes it as canonical EJSON. A value
 * may be a `{{parameter}}` (spec 2026-10-28): the draft's values are filled in, and the parts as
 * typed come back as the template.
 */
export function buildQuery(draft: QueryDraft): BuildResult {
  type Part = 'filter' | 'projection' | 'sort' | 'collation' | 'hint'
  const parts: Partial<Record<Part, Record<string, unknown>>> = {}
  for (const field of ['filter', 'projection', 'sort', 'collation'] as const) {
    try {
      const value = parseQueryObject(draft[field], { params: true })
      if (Object.keys(value).length > 0) parts[field] = value
    } catch (e) {
      if (e instanceof QueryParseError)
        return { ok: false, field, message: e.message, line: e.line, column: e.column }
      return { ok: false, field, message: e instanceof Error ? e.message : String(e) }
    }
  }
  // A hint is a key document ({ qty: 1 }) or an index name (qty_1).
  let hintName: string | undefined
  const hintText = draft.hint.trim()
  if (hintText.startsWith('{')) {
    try {
      const keys = parseQueryObject(hintText, { params: true })
      // An empty key document is no hint at all.
      if (Object.keys(keys).length > 0) parts.hint = keys
    } catch (e) {
      if (e instanceof QueryParseError)
        return { ok: false, field: 'hint', message: e.message, line: e.line, column: e.column }
      return { ok: false, field: 'hint', message: String(e) }
    }
  } else if (hintText !== '') {
    if (/^[[\]"'`]/.test(hintText) || hintText.length > MAX_HINT_NAME)
      return { ok: false, field: 'hint', message: hintText }
    hintName = hintText
  }
  const skip = draft.skip.trim() === '' ? 0 : Number(draft.skip.trim())
  if (!Number.isInteger(skip) || skip < 0) return { ok: false, field: 'skip', message: draft.skip }
  const timeText = draft.maxTimeMS.trim()
  const maxTimeMS = timeText === '' ? undefined : /^\d+$/.test(timeText) ? Number(timeText) : NaN
  if (maxTimeMS !== undefined && !(maxTimeMS >= MAX_TIME_MS.min && maxTimeMS <= MAX_TIME_MS.max))
    return { ok: false, field: 'maxTimeMS', message: draft.maxTimeMS }
  const params = paramsOf(parts)
  // Final review (Minor 4): the parts together, not each, have 20 parameters at most.
  if (params.length > MAX_QUERY_PARAMS)
    return { ok: false, field: 'filter', message: `A query has ${MAX_QUERY_PARAMS} parameters at most` }
  const filled = fillParams(parts, draft.params ?? {})
  const encode = (value: Partial<Record<Part, Record<string, unknown>>>): FindTemplate => {
    const ejson = (part: Part) =>
      value[part] ? (serializeValue(value[part]) as Record<string, unknown>) : undefined
    const filter = ejson('filter')
    const projection = ejson('projection')
    const sort = ejson('sort')
    const collation = ejson('collation')
    const hint = hintName ?? ejson('hint')
    return {
      filter: filter ?? {},
      ...(projection ? { projection } : {}),
      ...(sort ? { sort } : {}),
      ...(collation ? { collation } : {}),
      ...(hint !== undefined ? { hint } : {}),
    }
  }
  if (!filled.ok)
    return {
      ok: false,
      field: 'params',
      message: Object.keys(filled.errors)[0]!,
      errors: filled.errors,
      messages: filled.messages,
      params,
      template: encode(parts),
    }
  return {
    ok: true,
    query: {
      ...encode(filled.value as typeof parts),
      ...(maxTimeMS !== undefined ? { maxTimeMS } : {}),
      skip,
      limit: draft.limit,
    },
    params,
    ...(params.length > 0 ? { template: encode(parts) } : {}),
  }
}

/** The parts of a query that are set, in the order the shell chains them. */
export type QueryPart =
  'filter' | 'projection' | 'sort' | 'collation' | 'hint' | 'skip' | 'limit' | 'maxTimeMS'

/** UI redesign R1 revision 2 §4.3: whether a run query says more than "everything, first page". */
export function hasQueryParts(query: FindQuery): boolean {
  return (
    Object.keys(query.filter).length > 0 ||
    !!query.projection ||
    !!query.sort ||
    !!query.collation ||
    query.hint !== undefined ||
    query.maxTimeMS !== undefined ||
    query.skip > 0
  )
}

/** True when the query run is still the one the assistant's parts describe (spec rev. 2 §4.2). */
export function sameParts(
  parts: { filter: string; projection: string; sort: string },
  query: FindQuery,
): boolean {
  const built = buildQuery({ ...emptyDraft(), ...parts })
  if (!built.ok) return false
  const pick = (q: FindQuery) => JSON.stringify([q.filter, q.projection ?? null, q.sort ?? null])
  return pick(built.query) === pick(query)
}
