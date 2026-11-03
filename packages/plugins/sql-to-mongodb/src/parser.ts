import { englishMessage, type SqlCode } from './messages'

/**
 * Plugins wave 1: a small SQL reader for the SELECT statements people write against one table — and
 * at most one join. Anything else is refused by name, with where it is, never guessed.
 */

/** A refusal: what (a code, with the words it names, review Minor 10) and where. */
export class SqlError extends Error {
  constructor(
    readonly code: SqlCode,
    readonly position: number,
    readonly values: Record<string, string> = {},
  ) {
    super(englishMessage(code, values))
  }
}

/** The largest whole number a double keeps exactly (wave 1 review I4). */
const exactNumber = (text: string, pos: number): number => {
  const n = Number(text)
  if (/^\d+$/.test(text) && !Number.isSafeInteger(n)) throw new SqlError('number_too_large', pos)
  return n
}

type TokenKind = 'word' | 'quoted' | 'string' | 'number' | 'symbol' | 'end'
interface Token {
  kind: TokenKind
  text: string
  pos: number
  /** A quoted token's quote: `"` or a backtick. */
  quote?: string
}

const SYMBOLS = ['<>', '!=', '<=', '>=', '=', '<', '>', '(', ')', ',', '*', ';', '-', '+']

export function lex(sql: string): Token[] {
  // Half a character (a lone surrogate) is refused where it is (wave 1 review Minor 4).
  for (let k = 0; k < sql.length; k++) {
    const c = sql.charCodeAt(k)
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = sql.charCodeAt(k + 1)
      if (d >= 0xdc00 && d <= 0xdfff) {
        k++
        continue
      }
      throw new SqlError('broken_char', k)
    }
    if (c >= 0xdc00 && c <= 0xdfff) throw new SqlError('broken_char', k)
  }
  const tokens: Token[] = []
  let i = 0
  while (i < sql.length) {
    const c = sql[i]!
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (sql.startsWith('--', i)) {
      const end = sql.indexOf('\n', i)
      i = end === -1 ? sql.length : end + 1
      continue
    }
    if (sql.startsWith('/*', i)) {
      const end = sql.indexOf('*/', i + 2)
      if (end === -1) throw new SqlError('comment_open', i)
      i = end + 2
      continue
    }
    if (c === "'") {
      let text = ''
      let j = i + 1
      for (;;) {
        if (j >= sql.length) throw new SqlError('string_open', i)
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            text += "'"
            j += 2
            continue
          }
          break
        }
        text += sql[j++]
      }
      tokens.push({ kind: 'string', text, pos: i })
      i = j + 1
      continue
    }
    if (c === '"' || c === '`') {
      // A doubled quote inside stands for itself, as in a '…' string.
      let text = ''
      let j = i + 1
      for (;;) {
        if (j >= sql.length) throw new SqlError('quoted_open', i)
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
      tokens.push({ kind: 'quoted', text, pos: i, quote: c })
      i = j + 1
      continue
    }
    const number = /^\d+(\.\d+)?([eE][+-]?\d+)?/.exec(sql.slice(i))
    if (number) {
      tokens.push({ kind: 'number', text: number[0], pos: i })
      i += number[0].length
      continue
    }
    const word = /^[\p{L}_][\p{L}\p{N}_$.]*/u.exec(sql.slice(i))
    if (word) {
      tokens.push({ kind: 'word', text: word[0], pos: i })
      i += word[0].length
      continue
    }
    const symbol = SYMBOLS.find((s) => sql.startsWith(s, i))
    if (!symbol) throw new SqlError('unexpected_char', i, { char: c })
    tokens.push({ kind: 'symbol', text: symbol, pos: i })
    i += symbol.length
  }
  tokens.push({ kind: 'end', text: '', pos: sql.length })
  return tokens
}

export type Literal = string | number | boolean | null
export type AggFn = 'count' | 'sum' | 'avg' | 'min' | 'max'
export type Expr =
  | { t: 'col'; name: string; pos: number }
  | { t: 'lit'; value: Literal; pos: number }
  | { t: 'agg'; fn: AggFn; arg: string; pos: number }
  | { t: 'cmp'; op: string; left: Expr; right: Expr; pos: number }
  | { t: 'in'; col: Expr; values: Literal[]; not: boolean; pos: number }
  | { t: 'like'; col: Expr; pattern: string; ci: boolean; not: boolean; pos: number }
  | { t: 'between'; col: Expr; low: Literal; high: Literal; not: boolean; pos: number }
  | { t: 'null'; col: Expr; not: boolean; pos: number }
  | { t: 'and' | 'or'; items: Expr[]; pos: number }
  | { t: 'not'; expr: Expr; pos: number }

export interface SelectItem {
  expr: Extract<Expr, { t: 'col' } | { t: 'agg' }>
  alias?: string
}
export interface Select {
  distinct: boolean
  columns: '*' | SelectItem[]
  from: { name: string; alias?: string }
  join?: { left: boolean; table: { name: string; alias?: string }; on: [string, string]; pos: number }
  where?: Expr
  groupBy: Array<{ name: string; pos: number }>
  having?: Expr
  orderBy: Array<{ expr: Extract<Expr, { t: 'col' } | { t: 'agg' }>; dir: 1 | -1 }>
  limit?: number
  offset?: number
}

export const KEYWORDS = new Set(
  'SELECT DISTINCT FROM AS JOIN INNER LEFT RIGHT FULL OUTER CROSS ON WHERE GROUP BY HAVING ORDER ASC DESC LIMIT OFFSET AND OR NOT IN LIKE ILIKE BETWEEN IS NULL TRUE FALSE UNION CASE WHEN THEN ELSE END EXCEPT INTERSECT'.split(
    ' ',
  ),
)
const AGGREGATES = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX'])

export function parse(sql: string): Select {
  const tokens = lex(sql)
  let i = 0
  const peek = (offset = 0) => tokens[Math.min(i + offset, tokens.length - 1)]!
  const next = () => tokens[i++]!
  const isWord = (t: Token, ...words: string[]) => t.kind === 'word' && words.includes(t.text.toUpperCase())
  const isSymbol = (t: Token, s: string) => t.kind === 'symbol' && t.text === s
  const fail = (code: SqlCode, t: Token = peek(), values: Record<string, string> = {}): never => {
    throw new SqlError(code, t.pos, values)
  }
  const expectWord = (word: string) => {
    if (!isWord(peek(), word)) fail('expected_keyword', peek(), { word })
    return next()
  }
  const expectSymbol = (s: string) => {
    if (!isSymbol(peek(), s)) fail('expected_symbol', peek(), { symbol: s })
    return next()
  }
  const name = (what: 'expected_name' | 'expected_field' | 'expected_collection'): Token => {
    const t = peek()
    if (t.kind === 'quoted' || (t.kind === 'word' && !KEYWORDS.has(t.text.toUpperCase()))) return next()
    return fail(what)
  }
  const alias = (): string | undefined => {
    if (isWord(peek(), 'AS')) {
      next()
      return name('expected_name').text
    }
    const t = peek()
    if (t.kind === 'quoted' || (t.kind === 'word' && !KEYWORDS.has(t.text.toUpperCase()))) return next().text
    return undefined
  }
  const refuseUnsupported = (t: Token) => {
    if (isWord(t, 'CASE')) fail('case_unsupported', t)
    if (isWord(t, 'SELECT')) fail('subquery_unsupported', t)
  }

  /**
   * User report 2026-10-10: where a value is meant, "…" is text (as MySQL and Studio 3T read it);
   * where a name is meant it stays a name, and a backticked one is a name everywhere.
   */
  const isText = (t: Token) => t.kind === 'string' || (t.kind === 'quoted' && t.quote === '"')
  const literal = (): Literal => {
    const t = peek()
    if (isSymbol(t, '-') || isSymbol(t, '+')) {
      next()
      if (peek().kind !== 'number') fail('expected_number')
      const n = exactNumber(peek().text, peek().pos)
      next()
      return t.text === '-' ? -n : n
    }
    if (t.kind === 'number') return exactNumber(next().text, t.pos)
    if (isText(t)) return next().text
    if (isWord(t, 'TRUE')) return (next(), true)
    if (isWord(t, 'FALSE')) return (next(), false)
    if (isWord(t, 'NULL')) return (next(), null)
    refuseUnsupported(t)
    return fail('expected_value')
  }
  const aggregate = (): Extract<Expr, { t: 'agg' }> => {
    const t = next()
    expectSymbol('(')
    if (isWord(peek(), 'DISTINCT')) fail('count_distinct')
    let arg: string
    if (isSymbol(peek(), '*')) {
      if (t.text.toUpperCase() !== 'COUNT') fail('star_invalid', peek(), { fn: t.text.toUpperCase() })
      next()
      arg = '*'
    } else arg = name('expected_field').text
    expectSymbol(')')
    return { t: 'agg', fn: t.text.toLowerCase() as AggFn, arg, pos: t.pos }
  }
  const isAggregate = () =>
    peek().kind === 'word' && AGGREGATES.has(peek().text.toUpperCase()) && isSymbol(peek(1), '(')
  const column = (): Extract<Expr, { t: 'col' }> => {
    const t = peek()
    refuseUnsupported(t)
    const n = name('expected_field')
    return { t: 'col', name: n.text, pos: t.pos }
  }
  const operand = (value = false): Expr => {
    const t = peek()
    if (value && isText(t)) return { t: 'lit', value: next().text, pos: t.pos }
    if (isAggregate()) return aggregate()
    refuseUnsupported(t)
    if (t.kind === 'quoted' || (t.kind === 'word' && !KEYWORDS.has(t.text.toUpperCase()))) return column()
    return { t: 'lit', value: literal(), pos: t.pos }
  }
  const list = (): Literal[] => {
    expectSymbol('(')
    refuseUnsupported(peek())
    const values = [literal()]
    while (isSymbol(peek(), ',')) {
      next()
      values.push(literal())
    }
    expectSymbol(')')
    return values
  }
  const predicate = (): Expr => {
    const start = peek()
    if (isSymbol(start, '(')) {
      next()
      refuseUnsupported(peek())
      const inner = or()
      expectSymbol(')')
      return inner
    }
    const left = operand()
    const t = peek()
    if (isWord(t, 'IS')) {
      next()
      const not = isWord(peek(), 'NOT') ? (next(), true) : false
      expectWord('NULL')
      return { t: 'null', col: left, not, pos: t.pos }
    }
    const not = isWord(t, 'NOT') ? (next(), true) : false
    const k = peek()
    if (isWord(k, 'IN')) {
      next()
      return { t: 'in', col: left, values: list(), not, pos: k.pos }
    }
    if (isWord(k, 'LIKE', 'ILIKE')) {
      next()
      if (!isText(peek())) fail('like_pattern')
      const pattern = next().text
      if (isWord(peek(), 'ESCAPE')) fail('like_escape')
      return { t: 'like', col: left, pattern, ci: k.text.toUpperCase() === 'ILIKE', not, pos: k.pos }
    }
    if (isWord(k, 'BETWEEN')) {
      next()
      const low = literal()
      expectWord('AND')
      const high = literal()
      return { t: 'between', col: left, low, high, not, pos: k.pos }
    }
    if (not) fail('not_needs')
    if (k.kind === 'symbol' && ['=', '<>', '!=', '<', '<=', '>', '>='].includes(k.text)) {
      next()
      return { t: 'cmp', op: k.text === '!=' ? '<>' : k.text, left, right: operand(true), pos: k.pos }
    }
    return fail('expected_comparison')
  }
  const notExpr = (): Expr => {
    const t = peek()
    if (isWord(t, 'NOT')) {
      next()
      return { t: 'not', expr: notExpr(), pos: t.pos }
    }
    return predicate()
  }
  const and = (): Expr => {
    const first = notExpr()
    const items = [first]
    while (isWord(peek(), 'AND')) {
      next()
      items.push(notExpr())
    }
    return items.length === 1 ? first : { t: 'and', items, pos: first.pos }
  }
  const or = (): Expr => {
    const first = and()
    const items = [first]
    while (isWord(peek(), 'OR')) {
      next()
      items.push(and())
    }
    return items.length === 1 ? first : { t: 'or', items, pos: first.pos }
  }
  const integer = (word: string): number => {
    const t = peek()
    if (t.kind !== 'number' || !/^\d+$/.test(t.text)) fail('whole_number', t, { word })
    return exactNumber(next().text, t.pos)
  }

  // ---- the statement
  const first = peek()
  if (!isWord(first, 'SELECT')) fail('only_select', first)
  next()
  const distinct = isWord(peek(), 'DISTINCT') ? (next(), true) : false
  let columns: Select['columns']
  if (isSymbol(peek(), '*')) {
    next()
    columns = '*'
  } else {
    columns = []
    for (;;) {
      const t = peek()
      const expr = isAggregate()
        ? aggregate()
        : t.kind === 'string' || t.kind === 'number'
          ? fail('select_fields')
          : column()
      const a = alias()
      columns.push(a ? { expr, alias: a } : { expr })
      if (!isSymbol(peek(), ',')) break
      next()
    }
  }
  expectWord('FROM')
  const fromName = name('expected_collection').text
  const fromAlias = alias()
  const select: Select = {
    distinct,
    columns,
    from: { name: fromName, ...(fromAlias ? { alias: fromAlias } : {}) },
    groupBy: [],
    orderBy: [],
  }
  const joinStart = peek()
  if (isWord(joinStart, 'RIGHT', 'FULL', 'CROSS'))
    fail('join_unsupported', joinStart, { kind: joinStart.text.toUpperCase() })
  if (isWord(joinStart, 'JOIN', 'INNER', 'LEFT')) {
    const left = isWord(joinStart, 'LEFT')
    if (!isWord(joinStart, 'JOIN')) {
      next()
      if (left && isWord(peek(), 'OUTER')) next()
    }
    expectWord('JOIN')
    const table = name('expected_collection').text
    const tableAlias = alias()
    expectWord('ON')
    const a = name('expected_field').text
    if (!isSymbol(peek(), '=')) fail('join_on')
    next()
    const b = name('expected_field').text
    select.join = {
      left,
      table: { name: table, ...(tableAlias ? { alias: tableAlias } : {}) },
      on: [a, b],
      pos: joinStart.pos,
    }
    if (isWord(peek(), 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS')) fail('one_join')
  }
  if (isWord(peek(), 'WHERE')) {
    next()
    select.where = or()
  }
  if (isWord(peek(), 'GROUP')) {
    next()
    expectWord('BY')
    for (;;) {
      const t = peek()
      select.groupBy.push({ name: name('expected_field').text, pos: t.pos })
      if (!isSymbol(peek(), ',')) break
      next()
    }
  }
  if (isWord(peek(), 'HAVING')) {
    next()
    select.having = or()
  }
  if (isWord(peek(), 'ORDER')) {
    next()
    expectWord('BY')
    for (;;) {
      const expr = isAggregate() ? aggregate() : column()
      let dir: 1 | -1 = 1
      if (isWord(peek(), 'ASC')) next()
      else if (isWord(peek(), 'DESC')) {
        next()
        dir = -1
      }
      select.orderBy.push({ expr, dir })
      if (!isSymbol(peek(), ',')) break
      next()
    }
  }
  if (isWord(peek(), 'LIMIT')) {
    next()
    const a = integer('LIMIT')
    if (isSymbol(peek(), ',')) {
      next()
      select.offset = a
      select.limit = integer('LIMIT')
    } else select.limit = a
  }
  if (isWord(peek(), 'OFFSET')) {
    next()
    select.offset = integer('OFFSET')
  }
  if (isSymbol(peek(), ';')) next()
  const rest = peek()
  if (rest.kind !== 'end') {
    if (isWord(rest, 'UNION', 'EXCEPT', 'INTERSECT'))
      fail('unsupported', rest, { word: rest.text.toUpperCase() })
    fail('unexpected', rest, { text: rest.text })
  }
  return select
}
