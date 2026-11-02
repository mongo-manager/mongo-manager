import { SqlError, parse, type AggFn, type Expr, type Literal, type Select } from './parser'

export { SqlError } from './parser'

/**
 * Plugins wave 1: a SELECT as MongoDB — a find when it maps one to one, else an aggregation pipeline
 * (groups, aggregates, DISTINCT, renamed columns, a join). Values are plain JSON (`{ $regex,
 * $options }` for patterns); `canonical()` makes them Extended JSON for the app.
 */
export type Doc = Record<string, unknown>
export type Model =
  | {
      kind: 'find'
      collection: string
      filter: Doc
      projection?: Doc
      sort?: Doc
      skip?: number
      limit?: number
    }
  | { kind: 'aggregate'; collection: string; pipeline: Doc[] }

const OPS: Record<string, string> = {
  '=': '$eq',
  '<>': '$ne',
  '<': '$lt',
  '<=': '$lte',
  '>': '$gt',
  '>=': '$gte',
}
const FLIP: Record<string, string> = { '=': '=', '<>': '<>', '<': '>', '<=': '>=', '>': '<', '>=': '<=' }

/**
 * A LIKE pattern as a regular expression anchored at both ends (`\z`: the very end, a final line
 * break included), `%` and `_` matching any character, line breaks too (wave 1 review Minor 3).
 */
export function likeToRegex(pattern: string): string {
  let out = '^'
  for (const c of pattern) {
    if (c === '%') out += '[\\s\\S]*'
    else if (c === '_') out += '[\\s\\S]'
    else out += /[.*+?^${}()|[\]\\]/.test(c) ? `\\${c}` : c
  }
  return `${out}\\z`
}

const isOperatorDoc = (v: unknown): v is Doc =>
  !!v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).length > 0 &&
  Object.keys(v).every((k) => k.startsWith('$'))

/** Filters joined by AND: one document when their fields do not clash, else $and. */
function andOf(items: Doc[]): Doc {
  const merged: Doc = {}
  for (const item of items)
    for (const [k, v] of Object.entries(item)) {
      if (!(k in merged)) {
        merged[k] = v
        continue
      }
      const prev = merged[k]
      if (
        !k.startsWith('$') &&
        isOperatorDoc(prev) &&
        isOperatorDoc(v) &&
        Object.keys(v).every((op) => !(op in prev))
      )
        merged[k] = { ...prev, ...v }
      else return { $and: items }
    }
  return merged
}

type Resolve = (name: string, pos: number) => string

function filterOf(expr: Expr, field: Resolve, agg?: (e: Extract<Expr, { t: 'agg' }>) => string): Doc {
  const ref = (e: Expr): string | null => {
    if (e.t === 'col') return field(e.name, e.pos)
    if (e.t === 'agg') {
      if (!agg) throw new SqlError('aggregate_in_where', e.pos)
      return agg(e)
    }
    return null
  }
  const value = (e: Expr): Literal => (e.t === 'lit' ? e.value : null)
  const columnOf = (e: Expr, pos: number): string => {
    const r = ref(e)
    if (r === null) throw new SqlError('condition_field', pos)
    return r
  }
  switch (expr.t) {
    case 'and':
      return andOf(expr.items.map((e) => filterOf(e, field, agg)))
    case 'or':
      return { $or: expr.items.map((e) => filterOf(e, field, agg)) }
    case 'not':
      return { $nor: [filterOf(expr.expr, field, agg)] }
    case 'cmp': {
      const left = ref(expr.left)
      const right = ref(expr.right)
      if (left !== null && right !== null) return { $expr: { [OPS[expr.op]!]: [`$${left}`, `$${right}`] } }
      if (left === null && right === null) throw new SqlError('condition_compare', expr.pos)
      const [f, op, v] =
        left !== null ? [left, expr.op, value(expr.right)] : [right!, FLIP[expr.op]!, value(expr.left)]
      // SQL: nothing equals NULL, and a field that is NULL or missing is no answer to "<>" (review
      // Minor 3), where MongoDB's $ne would take it.
      if (v === null) throw new SqlError('null_compare', expr.pos)
      if (op === '=') return { [f]: v }
      if (op === '<>') return { [f]: { $nin: [v, null] } }
      return { [f]: { [OPS[op]!]: v } }
    }
    case 'in': {
      if (expr.values.includes(null)) throw new SqlError('null_compare', expr.pos)
      const f = columnOf(expr.col, expr.pos)
      return expr.not ? { [f]: { $nin: [...expr.values, null] } } : { [f]: { $in: expr.values } }
    }
    case 'like': {
      const regex = { $regex: likeToRegex(expr.pattern), $options: expr.ci ? 'i' : '' }
      return { [columnOf(expr.col, expr.pos)]: expr.not ? { $not: regex } : regex }
    }
    case 'between': {
      if (expr.low === null || expr.high === null) throw new SqlError('null_compare', expr.pos)
      const f = columnOf(expr.col, expr.pos)
      return expr.not
        ? { $or: [{ [f]: { $lt: expr.low } }, { [f]: { $gt: expr.high } }] }
        : { [f]: { $gte: expr.low, $lte: expr.high } }
    }
    case 'null': {
      const f = columnOf(expr.col, expr.pos)
      return { [f]: expr.not ? { $ne: null } : null }
    }
    default:
      throw new SqlError('expected_condition', expr.pos)
  }
}

/**
 * Names for the fields of one document (a group's _id, its aggregates), from paths or words: no dot,
 * no "$" first, never the same for two (wave 1 review I4: "a.b" and "a_b" stay apart).
 */
function namer(reserved: string[] = []) {
  const taken = new Set(reserved)
  const given = new Map<string, string>()
  return (id: string, wanted: string = id): string => {
    const known = given.get(id)
    if (known !== undefined) return known
    const base = wanted.replace(/\./g, '_').replace(/^\$+/, '') || 'field'
    let name = base
    for (let n = 2; taken.has(name); n++) name = `${base}_${n}`
    taken.add(name)
    given.set(id, name)
    return name
  }
}

/** A field path MongoDB takes: not empty, no empty part, no "$" first (wave 1 review Minor 5). */
function checked(path: string, pos: number): string {
  if (!path || path.startsWith('$') || path.split('.').some((part) => part === ''))
    throw new SqlError('bad_field', pos, { name: path })
  return path
}

const signature = (e: Extract<Expr, { t: 'agg' }>) => `${e.fn}(${e.arg})`

/**
 * The collection a column as written is of, and its field there: its prefix — an alias first, then
 * a collection's own name (review Minor 5) — taken off; no prefix is the main collection's field.
 * The translator and the results' headings read columns by this one rule (review 2026-10-10).
 */
export function columnSide(q: Select, name: string): { side: 'base' | 'join'; rest: string } {
  const prefixes = (
    [
      [q.from.alias, 'base'],
      [q.join?.table.alias, 'join'],
      [q.from.name, 'base'],
      [q.join?.table.name, 'join'],
    ] as const
  ).filter((p): p is readonly [string, 'base' | 'join'] => !!p[0])
  const prefix = prefixes.find(([p]) => name.startsWith(`${p}.`))
  return prefix ? { side: prefix[1], rest: name.slice(prefix[0].length + 1) } : { side: 'base', rest: name }
}

export function translate(sql: string): Model {
  const q: Select = parse(sql)
  const joinAs = q.join ? (q.join.table.alias ?? q.join.table.name) : null
  /** A column as a field path and the collection it is of: the main one's prefix taken off. */
  const resolve = (name: string, pos: number): { side: 'base' | 'join'; path: string } => {
    const { side, rest } = columnSide(q, name)
    return side === 'join'
      ? { side: 'join', path: checked(`${joinAs}.${rest}`, pos) }
      : { side: 'base', path: checked(rest, pos) }
  }
  const field: Resolve = (name, pos) => resolve(name, pos).path
  const items = q.columns === '*' ? null : q.columns
  for (const c of items ?? []) if (c.alias !== undefined) checked(c.alias, c.expr.pos)
  const aggregates = [
    ...(items ?? []).flatMap((c) => (c.expr.t === 'agg' ? [c.expr] : [])),
    ...q.orderBy.flatMap((o) => (o.expr.t === 'agg' ? [o.expr] : [])),
  ]
  const collectAggs = (e: Expr | undefined): void => {
    if (!e) return
    if (e.t === 'agg') aggregates.push(e)
    else if (e.t === 'and' || e.t === 'or') e.items.forEach(collectAggs)
    else if (e.t === 'not') collectAggs(e.expr)
    else if (e.t === 'cmp') {
      collectAggs(e.left)
      collectAggs(e.right)
    } else if (e.t === 'in' || e.t === 'like' || e.t === 'between' || e.t === 'null') collectAggs(e.col)
  }
  collectAggs(q.having)
  const grouped = aggregates.length > 0 || q.groupBy.length > 0
  if (q.having && !grouped) throw new SqlError('having_alone', q.having.pos)
  const renamed = (items ?? []).some((c) => c.alias !== undefined && c.expr.t === 'col')
  const where = q.where ? filterOf(q.where, field) : undefined

  // ---- a find, when nothing needs a pipeline
  if (!grouped && !q.distinct && !q.join && !renamed && !q.having) {
    const model: Model = { kind: 'find', collection: q.from.name, filter: where ?? {} }
    if (items) {
      const projection: Doc = {}
      for (const c of items) projection[field((c.expr as { name: string }).name, c.expr.pos)] = 1
      if (!('_id' in projection)) projection._id = 0
      model.projection = projection
    }
    if (q.orderBy.length)
      model.sort = Object.fromEntries(
        q.orderBy.map((o) => [field((o.expr as { name: string }).name, o.expr.pos), o.dir]),
      )
    if (q.offset !== undefined) model.skip = q.offset
    if (q.limit !== undefined) model.limit = q.limit
    return model
  }

  const pipeline: Doc[] = []
  if (q.join) {
    const [a, b] = q.join.on.map((n) => resolve(n, q.join!.pos)) as [
      ReturnType<typeof resolve>,
      ReturnType<typeof resolve>,
    ]
    if (a.side === b.side) throw new SqlError('join_sides', q.join.pos)
    const [local, foreign] = a.side === 'base' ? [a, b] : [b, a]
    pipeline.push(
      {
        $lookup: {
          from: q.join.table.name,
          localField: local.path,
          foreignField: foreign.path.slice(joinAs!.length + 1),
          as: joinAs,
        },
      },
      { $unwind: { path: `$${joinAs}`, preserveNullAndEmptyArrays: q.join.left } },
    )
  }
  if (where && Object.keys(where).length) pipeline.push({ $match: where })

  // ---- groups and aggregates
  if (grouped || q.distinct) {
    if (q.distinct && aggregates.length) throw new SqlError('distinct_aggregates', 0)
    if (!items) throw new SqlError('grouped_star', 0)
    // GROUP BY may name a selected column by its alias (review Minor 5).
    const aliased = new Map(
      items.flatMap((c) => (c.alias !== undefined && c.expr.t === 'col' ? [[c.alias, c.expr.name]] : [])),
    )
    const keys = q.distinct
      ? items.map((c) => field((c.expr as { name: string }).name, c.expr.pos))
      : q.groupBy.map((g) => field(aliased.get(g.name) ?? g.name, g.pos))
    const keyName = namer()
    const accName = namer(['_id'])
    const names = new Map<string, string>()
    for (const c of items)
      if (c.expr.t === 'agg' && !names.has(signature(c.expr)))
        names.set(
          signature(c.expr),
          accName(signature(c.expr), c.alias ?? defaultName(c.expr.fn, c.expr.arg)),
        )
    for (const a of aggregates)
      if (!names.has(signature(a))) names.set(signature(a), accName(signature(a), defaultName(a.fn, a.arg)))
    const group: Doc = {
      _id: keys.length ? Object.fromEntries(keys.map((k) => [keyName(k), `$${k}`])) : null,
    }
    const seen = new Set<string>()
    for (const a of aggregates) {
      const n = names.get(signature(a))!
      if (seen.has(n)) continue
      seen.add(n)
      group[n] = accumulator(a.fn, a.arg === '*' ? '*' : field(a.arg, a.pos))
    }
    pipeline.push({ $group: group })
    // Output names: a selected field by its alias or path, an aggregate by its alias or default.
    const output = new Map<string, string>()
    const put = (name: string, value: string, pos: number) => {
      if (output.has(name)) throw new SqlError('same_name', pos, { name })
      output.set(name, value)
    }
    for (const c of items)
      if (c.expr.t === 'col') {
        const f = field(c.expr.name, c.expr.pos)
        if (!keys.includes(f)) throw new SqlError('not_grouped', c.expr.pos, { name: c.expr.name })
        put(c.alias ?? f, `$_id.${keyName(f)}`, c.expr.pos)
      } else put(c.alias ?? names.get(signature(c.expr))!, `$${names.get(signature(c.expr))}`, c.expr.pos)
    if (q.having) {
      const aliases = new Map(items.filter((c) => c.alias).map((c) => [c.alias!, c]))
      const havingField: Resolve = (name, pos) => {
        const aliased = aliases.get(name)
        if (aliased?.expr.t === 'agg') return names.get(signature(aliased.expr))!
        const f = field(aliased?.expr.t === 'col' ? aliased.expr.name : name, pos)
        if (!keys.includes(f)) throw new SqlError('having_field', pos, { name })
        return `_id.${keyName(f)}`
      }
      pipeline.push({ $match: filterOf(q.having, havingField, (a) => names.get(signature(a))!) })
    }
    pipeline.push({ $project: { _id: 0, ...Object.fromEntries(output) } })
    if (q.orderBy.length) {
      const sort: Doc = {}
      for (const o of q.orderBy) {
        const n =
          o.expr.t === 'agg'
            ? [...output.keys()].find(
                (k) => output.get(k) === `$${names.get(signature(o.expr as Extract<Expr, { t: 'agg' }>))}`,
              )
            : output.has(o.expr.name)
              ? o.expr.name
              : output.has(field(o.expr.name, o.expr.pos))
                ? field(o.expr.name, o.expr.pos)
                : undefined
        if (!n) throw new SqlError('order_grouped', o.expr.pos)
        sort[n] = o.dir
      }
      pipeline.push({ $sort: sort })
    }
    if (q.offset !== undefined) pipeline.push({ $skip: q.offset })
    if (q.limit !== undefined) pipeline.push({ $limit: q.limit })
    return { kind: 'aggregate', collection: q.from.name, pipeline }
  }

  // ---- no groups: sort by the source fields, page, then shape
  const sourceOf = new Map(
    (items ?? [])
      .filter((c) => c.alias && c.expr.t === 'col')
      .map((c) => [c.alias!, (c.expr as { name: string }).name]),
  )
  if (q.orderBy.length)
    pipeline.push({
      $sort: Object.fromEntries(
        q.orderBy.map((o) => [
          field(
            sourceOf.get((o.expr as { name: string }).name) ?? (o.expr as { name: string }).name,
            o.expr.pos,
          ),
          o.dir,
        ]),
      ),
    })
  if (q.offset !== undefined) pipeline.push({ $skip: q.offset })
  if (q.limit !== undefined) pipeline.push({ $limit: q.limit })
  if (items) {
    const project: Doc = {}
    for (const c of items) {
      const f = field((c.expr as { name: string }).name, c.expr.pos)
      const name = c.alias ?? f
      if (name in project) throw new SqlError('same_name', c.expr.pos, { name })
      project[name] = `$${f}`
    }
    pipeline.push({ $project: '_id' in project ? project : { _id: 0, ...project } })
  }
  return { kind: 'aggregate', collection: q.from.name, pipeline }
}

const defaultName = (fn: AggFn, arg: string) => (arg === '*' ? fn : `${fn}_${arg}`)

function accumulator(fn: AggFn, f: string): unknown {
  if (fn === 'count') return f === '*' ? { $sum: 1 } : { $sum: { $cond: [{ $gt: [`$${f}`, null] }, 1, 0] } }
  return { [`$${fn}`]: `$${f}` }
}

/** Plain JSON values as canonical Extended JSON (numbers by their type, patterns as regexes). */
export function canonical(value: unknown): unknown {
  if (typeof value === 'number') {
    // A whole number a double keeps exactly is an int or a long; any other a double (review I4).
    if (Number.isSafeInteger(value))
      return value >= -2147483648 && value <= 2147483647
        ? { $numberInt: String(value) }
        : { $numberLong: String(value) }
    return { $numberDouble: String(value) }
  }
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    const o = value as Doc
    if (typeof o.$regex === 'string' && Object.keys(o).every((k) => k === '$regex' || k === '$options'))
      return {
        $regularExpression: { pattern: o.$regex, options: typeof o.$options === 'string' ? o.$options : '' },
      }
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, canonical(v)]))
  }
  return value
}
