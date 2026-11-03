import { decodeValue, isDocument, toShell, typeOf } from './values'

/**
 * W1 (completion §2): the results as a chart, in the core app — bars, lines, points or a pie from
 * fields the user picks. Pure functions over decoded documents, so they are tested without a canvas.
 * A hidden field (phase 3c) is refused before any of its values is read: masked values are never
 * charted, not even as "***".
 */
export type ChartKind = 'bar' | 'line' | 'scatter' | 'pie'
export type ChartMeasure = 'count' | 'sum' | 'avg'
export interface ChartSpec {
  kind: ChartKind
  /** The field along the bottom (a slice's label in a pie). */
  x: string
  /** The number summed or averaged ('' for a count), or the vertical axis of a scatter. */
  y: string
  /** One series per value of this field ('' for none; not for a pie). */
  group: string
  measure: ChartMeasure
}
export const CHART_KINDS: readonly ChartKind[] = ['bar', 'line', 'scatter', 'pie']
export const CHART_MEASURES: readonly ChartMeasure[] = ['count', 'sum', 'avg']
/** Documents read for a chart at most (the find route's own page limit). */
export const CHART_SAMPLE = 1000

export type ChartData =
  | { kind: 'refused'; field: string }
  /** A pie of sums with a negative one (W1 review, minor 5). */
  | { kind: 'negative' }
  | {
      kind: 'categories'
      categories: string[]
      /** null: no document of that series in that category. */
      series: Array<{ name: string; values: Array<number | null> }>
      /** The last category is the rest, together. */
      other: boolean
      /** Documents left out: no value of x (or of y, for a sum or an average). */
      skipped: number
    }
  | {
      kind: 'points'
      xType: 'number' | 'date'
      series: Array<{ name: string; points: Array<[number, number]> }>
      skipped: number
    }

/** Categories drawn at most, the rest as "Other" (a pie's slices are fewer). */
const MAX_CATEGORIES = 30
const MAX_SLICES = 10
/** Series drawn at most, the rest as "Other". */
const MAX_SERIES = 8
export const OTHER = '\u0000other'
/** W1 review (minor 5): the group of documents without the field (not the same as null). */
export const NO_VALUE = '\u0000none'

const MISSING = Symbol('missing')
const NUMERIC = new Set(['int32', 'double', 'long', 'decimal128'])

/** The value at a dotted path (missing through arrays and absent fields). */
function valueAt(doc: Record<string, unknown>, path: string): unknown {
  let at: unknown = doc
  for (const key of path.split('.')) {
    if (!isDocument(at) || !Object.hasOwn(at, key)) return MISSING
    at = at[key]
  }
  return at
}

/** A number from a JavaScript or BSON number; null for anything else (NaN and infinities too). */
export function numberOf(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (!NUMERIC.has(typeOf(value))) return null
  const n = Number(String(value))
  return Number.isFinite(n) ? n : null
}

/** A category's label and, for numbers and dates, the value it sorts by. */
/**
 * A category: its key (W1 review, minor 5: type and value — the number 1 and the string "1" are two),
 * its label, its kind and, for numbers and dates, the value it sorts by.
 */
interface Category {
  key: string
  label: string
  kind: 'number' | 'date' | 'string' | 'other'
  order: number | null
}
function categoryOf(value: unknown): Category | null {
  if (value === MISSING || value === undefined) return null
  const type = typeOf(value)
  if (type === 'array' || type === 'object') return null
  const n = numberOf(value)
  if (n !== null) return { key: `n:${n}`, label: String(n), kind: 'number', order: n }
  if (type === 'date') {
    const ms = (value as Date).getTime()
    if (Number.isNaN(ms)) return null
    const iso = (value as Date).toISOString()
    const label = iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso
    return { key: `d:${ms}`, label, kind: 'date', order: ms }
  }
  if (type === 'string')
    return { key: `s:${value as string}`, label: value as string, kind: 'string', order: null }
  const label = type === 'objectId' ? (value as { toHexString(): string }).toHexString() : toShell(value, 0)
  return { key: `${type}:${label}`, label, kind: 'other', order: null }
}
/** A group's category; a document without the field is its own group (not null's). */
const groupOf = (value: unknown): Category =>
  categoryOf(value) ?? { key: NO_VALUE, label: NO_VALUE, kind: 'other', order: null }

/** Labels that read alike for two keys: the strings among them are quoted ("1" beside 1). */
function distinctLabels(categories: Iterable<Category>): Map<string, string> {
  const all = [...categories]
  const seen = new Map<string, number>()
  for (const c of all) seen.set(c.label, (seen.get(c.label) ?? 0) + 1)
  return new Map(
    all.map((c) => [
      c.key,
      c.kind === 'string' && seen.get(c.label)! > 1 ? JSON.stringify(c.label) : c.label,
    ]),
  )
}

/** Every field a chart can be drawn from: scalar leaves, in the order first seen, never a hidden one. */
export function chartFields(
  docs: readonly Record<string, unknown>[],
  isMasked: (path: readonly string[]) => boolean,
  max = 200,
): string[] {
  const out = new Set<string>()
  const walk = (value: Record<string, unknown>, prefix: string[], depth: number) => {
    for (const [key, child] of Object.entries(value)) {
      if (out.size >= max) return
      // W1 review (minor 4): a name a field path cannot reach is not offered.
      if (key === '' || key.includes('.') || key.startsWith('$')) continue
      const path = [...prefix, key]
      if (isMasked(path)) continue
      if (isDocument(child)) {
        if (depth < 3) walk(child, path, depth + 1)
      } else if (typeOf(child) !== 'array') out.add(path.join('.'))
    }
  }
  for (const doc of docs) walk(doc, [], 1)
  return [...out]
}

interface Cell {
  n: number
  sum: number
}

/** The fields a chart reads: x, y when it is measured or plotted, the group when there are series. */
export function usedFields(spec: ChartSpec): string[] {
  return [
    spec.x,
    spec.kind === 'scatter' || spec.measure !== 'count' ? spec.y : '',
    spec.kind === 'pie' ? '' : spec.group,
  ].filter((f) => f !== '')
}

/** The first field of a chart the user may not see (phase 3c), or null. */
export function refusedField(spec: ChartSpec, isMasked: (path: readonly string[]) => boolean): string | null {
  return usedFields(spec).find((f) => isMasked(f.split('.'))) ?? null
}

/**
 * A projection of just the fields drawn (less to read and send). A field under another one drawn is
 * read with it: MongoDB refuses a projection naming a path and its parent.
 */
export function chartProjection(spec: ChartSpec, own?: Record<string, unknown>): Record<string, unknown> {
  const fields = [...new Set(usedFields(spec))]
  const kept = fields.filter((f) => !fields.some((other) => other !== f && f.startsWith(`${other}.`)))
  if (!own || !Object.keys(own).length)
    return { ...(kept.includes('_id') ? {} : { _id: 0 }), ...Object.fromEntries(kept.map((f) => [f, 1])) }
  return withinProjection(kept, own)
}

/**
 * W1 review (minor 4): the fields drawn, as the query's own projection (canonical EJSON) gives them —
 * a computed one as computed, one it leaves out not at all — so a chart never reads whole documents.
 */
function withinProjection(fields: string[], own: Record<string, unknown>): Record<string, unknown> {
  const decoded = decodeValue(own) as Record<string, unknown>
  const flag = (v: unknown) => typeof v === 'boolean' || numberOf(v) !== null
  const on = (v: unknown) => (typeof v === 'boolean' ? v : numberOf(v) !== 0)
  const entries = Object.keys(own).filter((k) => k !== '_id')
  const inclusion = entries.some((k) => !flag(decoded[k]) || on(decoded[k]))
  const out: Record<string, unknown> = {}
  const take = (k: string) => {
    out[k] = flag(decoded[k]) ? 1 : own[k]
  }
  for (const f of fields) {
    if (f === '_id') continue
    const parent = entries.find((k) => f === k || f.startsWith(`${k}.`))
    const children = entries.filter((k) => k.startsWith(`${f}.`))
    if (parent !== undefined) {
      if (!flag(decoded[parent])) take(parent)
      else if (on(decoded[parent])) out[f] = 1
    } else if (children.length) {
      for (const k of children) if (!flag(decoded[k]) || on(decoded[k])) take(k)
      if (!inclusion) out[f] = 1
    } else if (!inclusion) out[f] = 1
  }
  const idShown = !Object.hasOwn(own, '_id') || !flag(decoded._id) || on(decoded._id)
  if (fields.includes('_id') && idShown) out._id = 1
  // Nothing drawn is left: the _id alone (an empty or _id: 0 projection would read whole documents).
  if (!Object.keys(out).length) return { _id: 1 }
  return out._id === 1 ? out : { _id: 0, ...out }
}

export function chartData(
  docs: readonly Record<string, unknown>[],
  spec: ChartSpec,
  isMasked: (path: readonly string[]) => boolean,
): ChartData {
  // Refused first: a hidden field's values are never read.
  const refused = refusedField(spec, isMasked)
  if (refused) return { kind: 'refused', field: refused }
  return spec.kind === 'scatter' ? points(docs, spec) : categories(docs, spec)
}

function points(docs: readonly Record<string, unknown>[], spec: ChartSpec): ChartData {
  const series = new Map<string, Array<[number, number]>>()
  let skipped = 0
  let dates = 0
  for (const doc of docs) {
    const xv = valueAt(doc, spec.x)
    const isDate = typeOf(xv) === 'date'
    const x = isDate ? (xv as Date).getTime() : numberOf(xv)
    const y = numberOf(valueAt(doc, spec.y))
    if (x === null || Number.isNaN(x) || y === null) {
      skipped++
      continue
    }
    if (isDate) dates++
    const name = spec.group ? groupOf(valueAt(doc, spec.group)).label : spec.y
    if (!series.has(name)) series.set(name, [])
    series.get(name)!.push([x, y])
  }
  // Largest first, as the bars' series are: a group keeps its colour from one kind of chart to another.
  const kept = [...series.entries()].sort((a, b) => b[1].length - a[1].length)
  const shown = kept.slice(0, MAX_SERIES)
  const rest = kept.slice(MAX_SERIES).flatMap(([, p]) => p)
  return {
    kind: 'points',
    xType: dates > 0 ? 'date' : 'number',
    series: [
      ...shown.map(([name, p]) => ({ name, points: p })),
      ...(rest.length ? [{ name: OTHER, points: rest }] : []),
    ],
    skipped,
  }
}

function categories(docs: readonly Record<string, unknown>[], spec: ChartSpec): ChartData {
  const grouped = spec.kind !== 'pie' && !!spec.group
  // W1 review (minor 5): a pie is of counts or sums (an average's slices add up to nothing).
  const measure: ChartMeasure = spec.kind === 'pie' && spec.measure === 'avg' ? 'sum' : spec.measure
  const cells = new Map<string, Map<string, Cell>>()
  const totals = new Map<string, { n: number; category: Category; first: number }>()
  const seriesTotals = new Map<string, { n: number; category: Category }>()
  let skipped = 0
  let i = 0
  for (const doc of docs) {
    const x = categoryOf(valueAt(doc, spec.x))
    const y = measure === 'count' ? 0 : numberOf(valueAt(doc, spec.y))
    if (!x || y === null) {
      skipped++
      continue
    }
    const group = grouped ? groupOf(valueAt(doc, spec.group)) : null
    const name = group?.key ?? ''
    const total = totals.get(x.key) ?? { n: 0, category: x, first: i++ }
    total.n++
    totals.set(x.key, total)
    const st = seriesTotals.get(name) ?? { n: 0, category: group ?? x }
    st.n++
    seriesTotals.set(name, st)
    if (!cells.has(name)) cells.set(name, new Map())
    const cell = cells.get(name)!.get(x.key) ?? { n: 0, sum: 0 }
    cell.n++
    cell.sum += y
    cells.get(name)!.set(x.key, cell)
  }
  // Numbers in their order, or dates in theirs; anything else (or a mix) largest first, ties as seen.
  const ordered = [...totals.entries()]
  const kinds = new Set(ordered.map(([, t]) => t.category.kind))
  const byValue = kinds.size === 1 && (kinds.has('number') || kinds.has('date'))
  ordered.sort(([, a], [, b]) =>
    byValue ? a.category.order! - b.category.order! : b.n - a.n || a.first - b.first,
  )
  const cap = spec.kind === 'pie' ? MAX_SLICES : MAX_CATEGORIES
  const other = ordered.length > cap
  const shown = ordered.slice(0, cap).map(([key]) => key)
  const inShown = new Set(shown)
  const labels = distinctLabels(ordered.map(([, t]) => t.category))

  const names = [...seriesTotals.entries()].sort((a, b) => b[1].n - a[1].n).map(([n]) => n)
  const seriesLabels = distinctLabels([...seriesTotals.values()].map((t) => t.category))
  const shownNames = names.slice(0, MAX_SERIES)
  const restNames = names.slice(MAX_SERIES)
  const value = (cell: Cell | undefined): number | null =>
    !cell ? null : measure === 'count' ? cell.n : measure === 'sum' ? cell.sum : cell.sum / cell.n
  const merge = (list: Array<Cell | undefined>): Cell | undefined => {
    const present = list.filter((c): c is Cell => !!c)
    return present.length
      ? present.reduce((a, c) => ({ n: a.n + c.n, sum: a.sum + c.sum }), { n: 0, sum: 0 })
      : undefined
  }
  const row = (series: string[]) => {
    const values = shown.map((key) => value(merge(series.map((s) => cells.get(s)?.get(key)))))
    if (other)
      values.push(
        value(
          merge(
            series.flatMap((s) =>
              [...(cells.get(s) ?? new Map<string, Cell>()).entries()]
                .filter(([k]) => !inShown.has(k))
                .map(([, c]) => c),
            ),
          ),
        ),
      )
    return values
  }
  const plainName = measure === 'count' ? 'count' : spec.y
  const series = grouped
    ? [
        ...shownNames.map((name) => ({ name: seriesLabels.get(name) ?? name, values: row([name]) })),
        ...(restNames.length ? [{ name: OTHER, values: row(restNames) }] : []),
      ]
    : [{ name: plainName, values: row(names) }]
  // A pie's slices are parts of a whole: a negative sum is none (W1 review, minor 5).
  if (spec.kind === 'pie' && series.some((s) => s.values.some((v) => v !== null && v < 0)))
    return { kind: 'negative' }
  return {
    kind: 'categories',
    categories: [...shown.map((key) => labels.get(key)!), ...(other ? [OTHER] : [])],
    series,
    other,
    skipped,
  }
}
