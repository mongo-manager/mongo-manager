import { KEYWORDS } from './parser'

/**
 * SQL completion (user request 2026-10-10: "WHERE suggested as I type it; st finds status in the
 * collection"): what may come at the caret — keywords, the collection's fields (from a sample),
 * the values a field was seen holding, functions, the collection — read from the text before it,
 * which need not be a whole statement yet.
 */
export interface Catalog {
  /** Field paths, the most common in the sample first. */
  fields: string[]
  /** A field's values as SQL writes them, the most common first. */
  values: Record<string, string[]>
  collections: string[]
}
export type ItemKind = 'keyword' | 'field' | 'value' | 'function' | 'collection'
export interface Item {
  label: string
  kind: ItemKind
  /** What goes in (a keyword in the case being typed). */
  insert: string
  /** Where the caret goes inside `insert` (after it when absent). */
  caretAt?: number
  /** No space after it (a value in a list, a function). */
  tight?: boolean
}
export interface Completions {
  /** The text from `from` to `to` is replaced. */
  from: number
  to: number
  items: Item[]
}

const MAX_FIELDS = 200
const MAX_VALUES = 20
const MAX_VALUE_TEXT = 60
const MAX_ITEMS = 50

type Doc = Record<string, unknown>
const isPlain = (v: unknown): v is Doc => !!v && typeof v === 'object' && !Array.isArray(v)
const isWrapper = (v: Doc) => {
  const keys = Object.keys(v)
  return keys.length > 0 && keys.every((k) => k.startsWith('$'))
}

/** A value as SQL writes it, or null for one SQL does not write (ids, dates, documents). */
function sqlValue(v: unknown): string | null {
  if (typeof v === 'string') return v.length <= MAX_VALUE_TEXT ? `'${v.replace(/'/g, "''")}'` : null
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : null
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  if (isPlain(v))
    for (const k of ['$numberInt', '$numberLong', '$numberDouble', '$numberDecimal'])
      if (typeof v[k] === 'string' && /^-?\d+(\.\d+)?$/.test(v[k] as string)) return v[k] as string
  return null
}

/** The fields and values a sample of the collection holds. */
export function catalogOf(docs: unknown[], collection: string | null): Catalog {
  const fields = new Map<string, number>()
  const values = new Map<string, Map<string, number>>()
  const seen = (path: string, docSeen: Set<string>) => {
    if (docSeen.has(path)) return
    docSeen.add(path)
    if (fields.has(path) || fields.size < MAX_FIELDS) fields.set(path, (fields.get(path) ?? 0) + 1)
  }
  const walk = (value: unknown, path: string, depth: number, docSeen: Set<string>) => {
    if (depth > 4) return
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 50)) walk(item, path, depth + 1, docSeen)
      return
    }
    if (isPlain(value) && !isWrapper(value)) {
      for (const [k, v] of Object.entries(value)) walk(v, path ? `${path}.${k}` : k, depth + 1, docSeen)
      return
    }
    if (!path) return
    seen(path, docSeen)
    const text = path === '_id' ? null : sqlValue(value)
    if (text === null || !fields.has(path)) return
    const counts = values.get(path) ?? new Map<string, number>()
    values.set(path, counts)
    counts.set(text, (counts.get(text) ?? 0) + 1)
  }
  for (const doc of docs) walk(doc, '', 0, new Set())
  const byCount = <T>(m: Map<T, number>) =>
    [...m.entries()]
      .map(([k, n], i) => ({ k, n, i }))
      .sort((a, b) => b.n - a.n || a.i - b.i)
      .map((e) => e.k)
  return {
    fields: byCount(fields),
    values: Object.fromEntries(
      [...values].map(([path, counts]) => [path, byCount(counts).slice(0, MAX_VALUES)]),
    ),
    collections: collection ? [collection] : [],
  }
}

// ---- reading the text before the caret, forgiving what is not finished yet
type Tok = { kind: 'word' | 'string' | 'quoted' | 'number' | 'symbol'; text: string; up: string }
interface Read {
  toks: Tok[]
  /** The caret is in a comment, or in an open quote (`'`, `"` or a backtick) that starts at `at`. */
  open: { kind: 'comment' } | { kind: 'quote'; char: string; at: number } | null
}
const SYMBOLS = ['<>', '!=', '<=', '>=', '=', '<', '>', '(', ')', ',', '*', ';', '-', '+']
function read(sql: string): Read {
  const toks: Tok[] = []
  let i = 0
  while (i < sql.length) {
    const c = sql[i]!
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (sql.startsWith('--', i)) {
      const end = sql.indexOf('\n', i)
      if (end === -1) return { toks, open: { kind: 'comment' } }
      i = end + 1
      continue
    }
    if (sql.startsWith('/*', i)) {
      const end = sql.indexOf('*/', i + 2)
      if (end === -1) return { toks, open: { kind: 'comment' } }
      i = end + 2
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1
      let text = ''
      for (;;) {
        if (j >= sql.length) return { toks, open: { kind: 'quote', char: c, at: i } }
        if (sql[j] === c) {
          if (sql[j + 1] === c) {
            text += c
            j += 2
            continue
          }
          break
        }
        text += sql[j++]
      }
      toks.push({ kind: c === "'" ? 'string' : 'quoted', text, up: text.toUpperCase() })
      i = j + 1
      continue
    }
    const number = /^\d+(\.\d+)?/.exec(sql.slice(i))
    if (number) {
      toks.push({ kind: 'number', text: number[0], up: number[0] })
      i += number[0].length
      continue
    }
    const word = /^[\p{L}_$][\p{L}\p{N}_$.]*/u.exec(sql.slice(i))
    if (word) {
      toks.push({ kind: 'word', text: word[0], up: word[0].toUpperCase() })
      i += word[0].length
      continue
    }
    const symbol = SYMBOLS.find((s) => sql.startsWith(s, i)) ?? c
    toks.push({ kind: 'symbol', text: symbol, up: symbol })
    i += symbol.length
  }
  return { toks, open: null }
}

const isKw = (t: Tok | undefined, ...words: string[]) => !!t && t.kind === 'word' && words.includes(t.up)
const isSym = (t: Tok | undefined, ...symbols: string[]) =>
  !!t && t.kind === 'symbol' && symbols.includes(t.text)
/** A name a field may be: a word that is no keyword, or a quoted name. */
const isName = (t: Tok | undefined) =>
  !!t && ((t.kind === 'word' && !KEYWORDS.has(t.up)) || (t.kind === 'quoted' && t.text !== ''))
const COMPARE = ['=', '<>', '!=', '<', '<=', '>', '>=']
const AGGREGATES = ['COUNT', 'SUM', 'AVG', 'MIN', 'MAX']
const CLAUSES = ['SELECT', 'FROM', 'JOIN', 'ON', 'WHERE', 'BY', 'HAVING', 'LIMIT', 'OFFSET']

/** What the caret expects. */
type Want =
  | { kind: 'fields'; star?: boolean; functions?: boolean; distinct?: boolean; not?: boolean }
  | { kind: 'values'; field: string; except: string[] }
  | { kind: 'collections' }
  | { kind: 'keywords'; words: string[] }
  | { kind: 'nothing' }

function wantAfter(toks: Tok[]): Want {
  const n = toks.length
  const last = toks[n - 1]
  if (!n) return { kind: 'keywords', words: ['SELECT'] }
  if (isKw(last, 'FROM', 'JOIN')) return { kind: 'collections' }

  // Inside parentheses: an IN list, a function's argument, or a grouping.
  let depth = 0
  for (let i = n - 1; i >= 0; i--) {
    const t = toks[i]!
    if (isSym(t, ')')) depth++
    else if (isSym(t, '(')) {
      if (depth > 0) {
        depth--
        continue
      }
      const before = toks[i - 1]
      if (isKw(before, 'IN')) {
        const field = isKw(toks[i - 2], 'NOT') ? toks[i - 3] : toks[i - 2]
        if (!isName(field) || !isSym(last, '(', ',')) return { kind: 'nothing' }
        const listed = toks
          .slice(i + 1)
          .flatMap((x) =>
            x.kind === 'string' ? [`'${x.text.replace(/'/g, "''")}'`] : x.kind === 'number' ? [x.text] : [],
          )
        return { kind: 'values', field: field!.text, except: listed }
      }
      if (before && before.kind === 'word' && AGGREGATES.includes(before.up))
        return isSym(last, '(') ? { kind: 'fields', star: before.up === 'COUNT' } : { kind: 'nothing' }
      break
    }
  }

  if (isSym(last, ...COMPARE)) {
    const field = toks[n - 2]
    return isName(field) ? { kind: 'values', field: field!.text, except: [] } : { kind: 'fields' }
  }
  if (isKw(last, 'BETWEEN') && isName(toks[n - 2]))
    return { kind: 'values', field: toks[n - 2]!.text, except: [] }
  if (isKw(last, 'AND') && isKw(toks[n - 3], 'BETWEEN') && isName(toks[n - 4]))
    return { kind: 'values', field: toks[n - 4]!.text, except: [] }
  if (isKw(last, 'LIKE', 'ILIKE', 'AS')) return { kind: 'nothing' }
  if (isKw(last, 'IS')) return { kind: 'keywords', words: ['NULL', 'NOT NULL'] }

  // The clause the caret is in: the last clause keyword before it.
  let clause = ''
  for (let i = n - 1; i >= 0; i--) {
    const t = toks[i]!
    if (t.kind !== 'word' || !CLAUSES.includes(t.up)) continue
    clause = t.up === 'BY' ? (isKw(toks[i - 1], 'GROUP') ? 'GROUP BY' : 'ORDER BY') : t.up
    break
  }
  const afterCondition = ['AND', 'OR', 'GROUP BY', 'ORDER BY', 'LIMIT']
  switch (clause) {
    case 'SELECT':
      if (isKw(last, 'SELECT', 'DISTINCT') || isSym(last, ','))
        return {
          kind: 'fields',
          star: !isSym(last, ','),
          functions: true,
          distinct: isKw(last, 'SELECT'),
        }
      return { kind: 'keywords', words: ['FROM', 'AS'] }
    case 'FROM':
    case 'JOIN':
      return { kind: 'keywords', words: ['WHERE', 'JOIN', 'LEFT JOIN', 'GROUP BY', 'ORDER BY', 'LIMIT'] }
    case 'ON':
      if (isKw(last, 'ON')) return { kind: 'fields' }
      return { kind: 'keywords', words: ['WHERE', 'GROUP BY', 'ORDER BY', 'LIMIT'] }
    case 'WHERE':
    case 'HAVING': {
      const having = clause === 'HAVING'
      if (isKw(last, 'WHERE', 'HAVING', 'AND', 'OR', 'NOT') || isSym(last, '('))
        return { kind: 'fields', functions: having, not: !isKw(last, 'NOT') }
      // A field just named: what compares it.
      const opens = (t: Tok | undefined) => isKw(t, 'WHERE', 'HAVING', 'AND', 'OR', 'NOT') || isSym(t, '(')
      if (isName(last) && opens(toks[n - 2]))
        return { kind: 'keywords', words: ['IN', 'NOT IN', 'LIKE', 'BETWEEN', 'IS NULL', 'IS NOT NULL'] }
      return {
        kind: 'keywords',
        words: having ? ['AND', 'OR', 'ORDER BY', 'LIMIT'] : afterCondition,
      }
    }
    case 'GROUP BY':
      if (isKw(last, 'BY') || isSym(last, ',')) return { kind: 'fields' }
      return { kind: 'keywords', words: ['HAVING', 'ORDER BY', 'LIMIT'] }
    case 'ORDER BY':
      if (isKw(last, 'BY') || isSym(last, ',')) return { kind: 'fields' }
      if (isKw(last, 'ASC', 'DESC')) return { kind: 'keywords', words: ['LIMIT'] }
      return { kind: 'keywords', words: ['ASC', 'DESC', 'LIMIT'] }
    case 'LIMIT':
      return last?.kind === 'number' ? { kind: 'keywords', words: ['OFFSET'] } : { kind: 'nothing' }
    case 'OFFSET':
      return { kind: 'nothing' }
    default:
      return { kind: 'keywords', words: ['SELECT'] }
  }
}

// ---- matching what was typed
const PATH = /^[\p{L}_][\p{L}\p{N}_$]*(\.[\p{L}_][\p{L}\p{N}_$]*)*$/u
/** A field as SQL writes it: bare when the parser reads it so, else in backticks. */
export function fieldName(path: string): string {
  return PATH.test(path) && !KEYWORDS.has(path.toUpperCase()) ? path : `\`${path.replace(/`/g, '``')}\``
}
/** The parts a name may be found by: its path parts, words and camelCase humps. */
const parts = (label: string) =>
  label
    .split(/[.\s_]+|(?<=[a-z\d])(?=[A-Z])/)
    .filter(Boolean)
    .map((p) => p.toLowerCase())
/** How well `label` matches `typed`: 0 from its start, 1 from a part's start, 2 within, -1 not at all. */
function score(label: string, typed: string): number {
  if (!typed) return 0
  const l = label.toLowerCase()
  const t = typed.toLowerCase()
  if (l.startsWith(t)) return 0
  if (parts(label).some((p) => p.startsWith(t))) return 1
  return l.includes(t) ? 2 : -1
}
const unquote = (v: string) => (v.startsWith("'") ? v.slice(1, -1).replace(/''/g, "'") : v)

const FUNCTIONS: Item[] = [
  { label: 'COUNT(*)', kind: 'function', insert: 'COUNT(*)', tight: true },
  ...['SUM', 'AVG', 'MIN', 'MAX'].map((f): Item => ({
    label: `${f}()`,
    kind: 'function',
    insert: `${f}()`,
    caretAt: f.length + 1,
    tight: true,
  })),
]

/** The suggestions at `caret` in `sql`, or null where there are none. */
export function completionsAt(sql: string, caret: number, catalog: Catalog): Completions | null {
  const before = sql.slice(0, caret)
  const whole = read(before)
  let from: number
  let typed: string
  let quote: string | null = null
  if (whole.open?.kind === 'comment') return null
  if (whole.open?.kind === 'quote') {
    // Only a text being typed as a value is completed, never a quoted name.
    if (whole.open.char === '`') return null
    quote = whole.open.char
    from = whole.open.at
    typed = before.slice(from + 1)
  } else {
    typed = /[\p{L}\p{N}_$.]*$/u.exec(before)![0]
    from = caret - typed.length
  }
  const to = quote ? caret : caret + /^[\p{L}\p{N}_$.]*/u.exec(sql.slice(caret))![0].length
  const want = wantAfter(read(sql.slice(0, from)).toks)
  if (quote && want.kind !== 'values') return null

  // Keywords in the case the statement is written in.
  const lower = typed ? /[a-z]/.test(typed) && typed === typed.toLowerCase() : /^\s*select\b/.test(sql)
  const keyword = (word: string): Item => ({
    label: word,
    kind: 'keyword',
    insert: lower ? word.toLowerCase() : word,
  })

  let pool: Item[] = []
  switch (want.kind) {
    case 'nothing':
      return null
    case 'keywords':
      pool = want.words.map(keyword)
      break
    case 'collections':
      pool = catalog.collections.map((c) => ({ label: c, kind: 'collection', insert: fieldName(c) }))
      break
    case 'values': {
      const known = (catalog.values[want.field] ?? catalog.values[unquote(want.field)] ?? []).filter(
        (v) => !want.except.includes(v),
      )
      pool = known.map((v) => ({
        label: v,
        kind: 'value',
        insert: v,
        tight: want.except.length > 0 || isList(sql, from),
      }))
      if (!pool.length && !quote)
        pool = catalog.fields.map((f) => ({ label: f, kind: 'field', insert: fieldName(f) }))
      break
    }
    case 'fields':
      pool = [
        ...(want.star ? [{ label: '*', kind: 'field' as const, insert: '*' }] : []),
        ...catalog.fields.map((f): Item => ({ label: f, kind: 'field', insert: fieldName(f) })),
        ...(want.functions ? FUNCTIONS : []),
        ...(want.distinct ? [keyword('DISTINCT')] : []),
        ...(want.not ? [keyword('NOT')] : []),
      ]
      break
  }
  const ranked = pool
    .map((item, i) => ({
      item,
      i,
      s: score(want.kind === 'values' ? unquote(item.label) : item.label, typed),
    }))
    .filter(
      ({ item, s }) =>
        s >= 0 &&
        (!typed ||
          (want.kind === 'values' ? unquote(item.label) : item.label).toLowerCase() !== typed.toLowerCase()),
    )
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .slice(0, MAX_ITEMS)
    .map((r) => r.item)
  return ranked.length ? { from, to, items: ranked } : null
}

/** Whether `at` is inside an IN list (a value there is followed by a comma, not a space). */
function isList(sql: string, at: number): boolean {
  const toks = read(sql.slice(0, at)).toks
  let depth = 0
  for (let i = toks.length - 1; i >= 0; i--) {
    if (isSym(toks[i], ')')) depth++
    else if (isSym(toks[i], '(')) {
      if (depth-- > 0) continue
      return isKw(toks[i - 1], 'IN')
    }
  }
  return false
}

/** The text with `item` in place of what was typed, and where the caret goes. */
export function applyCompletion(
  sql: string,
  found: Completions,
  item: Item,
): { text: string; caret: number } {
  const next = sql[found.to]
  const space =
    !item.tight && item.caretAt === undefined && (next === undefined || !/[\s,)]/.test(next)) ? ' ' : ''
  const text = sql.slice(0, found.from) + item.insert + space + sql.slice(found.to)
  const caret = found.from + (item.caretAt ?? item.insert.length + space.length)
  return { text, caret }
}
