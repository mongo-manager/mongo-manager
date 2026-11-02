import { KEYWORDS } from './parser'

/**
 * SQL formatting (user request 2026-10-10: "use a beautifier for the SQL"): each clause on its own
 * line, the columns of a SELECT of several and the AND/OR of its conditions under it, keywords in
 * capitals — texts, quoted names, numbers and comments exactly as written. Only spaces and line
 * breaks change, so the query means what it meant; what cannot be read to its end (an open text or
 * comment) is not formatted.
 */
type Kind = 'word' | 'string' | 'quoted' | 'number' | 'symbol' | 'line-comment' | 'block-comment'
interface Token {
  kind: Kind
  text: string
}

const SYMBOLS = ['<>', '!=', '<=', '>=', '=', '<', '>', '(', ')', ',', '*', ';', '-', '+', '.']
const AGGREGATES = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX'])
const JOINS = new Set(['INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS'])
const CLAUSES = new Set([
  'SELECT',
  'FROM',
  'WHERE',
  'HAVING',
  'LIMIT',
  'OFFSET',
  'UNION',
  'EXCEPT',
  'INTERSECT',
])

function lex(sql: string): Token[] | null {
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
      const stop = end === -1 ? sql.length : end
      tokens.push({ kind: 'line-comment', text: sql.slice(i, stop).trimEnd() })
      i = stop
      continue
    }
    if (sql.startsWith('/*', i)) {
      const end = sql.indexOf('*/', i + 2)
      if (end === -1) return null
      tokens.push({ kind: 'block-comment', text: sql.slice(i, end + 2) })
      i = end + 2
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1
      for (;;) {
        if (j >= sql.length) return null
        if (sql[j] === c) {
          if (sql[j + 1] === c) {
            j += 2
            continue
          }
          break
        }
        j++
      }
      tokens.push({ kind: c === "'" ? 'string' : 'quoted', text: sql.slice(i, j + 1) })
      i = j + 1
      continue
    }
    const number = /^\d+(\.\d+)?([eE][+-]?\d+)?/.exec(sql.slice(i))
    if (number) {
      tokens.push({ kind: 'number', text: number[0] })
      i += number[0].length
      continue
    }
    const word = /^[\p{L}_][\p{L}\p{N}_$.]*/u.exec(sql.slice(i))
    if (word) {
      tokens.push({ kind: 'word', text: word[0] })
      i += word[0].length
      continue
    }
    const symbol = SYMBOLS.find((s) => sql.startsWith(s, i)) ?? c
    tokens.push({ kind: 'symbol', text: symbol })
    i += symbol.length
  }
  return tokens
}

const upper = (t: Token | undefined) => (t?.kind === 'word' ? t.text.toUpperCase() : '')
const isKeyword = (t: Token | undefined) => !!t && t.kind === 'word' && KEYWORDS.has(t.text.toUpperCase())

/** The SQL formatted, or null where it cannot be read to its end. */
export function formatSql(sql: string): string | null {
  const tokens = lex(sql)
  if (!tokens || !tokens.length) return null
  const lines: string[] = []
  let line = ''
  /** The next piece sticks to the last one (after "(", a unary sign, a function's name). */
  let glue = false
  let depth = 0
  let clause = ''
  /** The SELECT lists several columns: one per line. */
  let columns = false
  /** An AND that closes a BETWEEN stays on its line. */
  let between = false
  /** A line comment ended the line: the next piece starts a new one. */
  let broken = false

  const newline = (indent: number) => {
    if (line.trim()) lines.push(line.trimEnd())
    line = ' '.repeat(indent)
    glue = true
    broken = false
  }
  const put = (text: string, space = true) => {
    if (broken) newline(2)
    line += line.trim() && space && !glue ? ` ${text}` : text
    glue = false
  }
  /** Whether the SELECT starting at `i` lists more than one column. */
  const severalColumns = (i: number) => {
    let level = 0
    for (let j = i + 1; j < tokens.length; j++) {
      const t = tokens[j]!
      if (t.kind === 'symbol' && t.text === '(') level++
      else if (t.kind === 'symbol' && t.text === ')') level--
      else if (level === 0 && t.kind === 'symbol' && t.text === ',') return true
      else if (level === 0 && (upper(t) === 'FROM' || t.text === ';')) return false
    }
    return false
  }

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    const prev = tokens[i - 1]
    const word = upper(t)
    if (t.kind === 'line-comment') {
      // Never stuck to what comes before: a sign glued to "--" would turn into the comment (review I1).
      glue = false
      put(t.text)
      broken = true
      continue
    }
    if (t.kind === 'block-comment') {
      glue = false
      put(t.text)
      continue
    }
    if (t.kind === 'word' && depth === 0) {
      if (word === 'SELECT') {
        newline(0)
        clause = 'SELECT'
        columns = severalColumns(i)
        put('SELECT')
        if (upper(tokens[i + 1]) === 'DISTINCT') put(tokens[++i]!.text.toUpperCase())
        if (columns) newline(2)
        continue
      }
      if (CLAUSES.has(word)) {
        newline(0)
        clause = word
        put(word)
        continue
      }
      if ((word === 'GROUP' || word === 'ORDER') && upper(tokens[i + 1]) === 'BY') {
        newline(0)
        clause = word
        put(`${word} BY`)
        i++
        continue
      }
      if (word === 'JOIN' || (JOINS.has(word) && ['JOIN', 'OUTER'].includes(upper(tokens[i + 1])))) {
        newline(0)
        clause = 'JOIN'
        // Only OUTER and JOIN join the words: anything else is left where it is (review I2).
        let words = word
        while (!words.endsWith('JOIN') && ['OUTER', 'JOIN'].includes(upper(tokens[i + 1])))
          words += ` ${upper(tokens[++i])}`
        put(words)
        continue
      }
      if (word === 'ON') {
        newline(2)
        clause = 'ON'
        put('ON')
        continue
      }
      if ((word === 'AND' || word === 'OR') && ['WHERE', 'HAVING', 'ON'].includes(clause)) {
        if (word === 'AND' && between) {
          between = false
          put('AND')
          continue
        }
        newline(2)
        put(word)
        continue
      }
      if (word === 'BETWEEN') between = true
    }
    if (t.kind === 'symbol') {
      switch (t.text) {
        case ',':
          // Never at the end of a line comment: it would be read as part of the comment.
          if (broken) newline(2)
          line += ','
          if (clause === 'SELECT' && depth === 0 && columns) newline(2)
          continue
        case '(': {
          // A function call keeps its "(", a keyword ("IN (") its space.
          const call = prev?.kind === 'word' && (!isKeyword(prev) || AGGREGATES.has(upper(prev)))
          put('(', !call)
          depth++
          glue = true
          continue
        }
        case ')':
          depth = Math.max(0, depth - 1)
          put(')', false)
          continue
        case ';':
          put(';', false)
          continue
        case '-':
        case '+': {
          // A sign before a number ("> -1.5"), not a sum.
          const unary =
            !prev ||
            (prev.kind === 'symbol' && prev.text !== ')') ||
            (prev.kind === 'word' && isKeyword(prev))
          put(t.text)
          if (unary) glue = true
          continue
        }
      }
    }
    const text =
      t.kind === 'word' && (KEYWORDS.has(word) || (AGGREGATES.has(word) && tokens[i + 1]?.text === '('))
        ? word
        : t.text
    put(text)
  }
  if (line.trim()) lines.push(line.trimEnd())
  return lines.join('\n')
}
