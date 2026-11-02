/**
 * User request 2026-10-12 ("kodları renklendir"): the shell's code, as it is typed, and its results,
 * in colour as mongosh shows them — keywords, strings, numbers and literals, regular expressions, the
 * shell's builtins (db, ObjectId…), calls, query operators ($gt…) and comments. A document's keys
 * stay plain, whatever they are called (review 2026-10-12).
 *
 * It works on text already made safe (writeSafe): it only puts the app's own colours (SGR, from the
 * terminal palette, so the chosen theme colours them) between its characters, never anything taken
 * from the text. The colours are palette indices: a theme changed recolours what is on screen.
 */
const ESC = String.fromCharCode(27)
const COLOUR = {
  keyword: `${ESC}[35m`,
  string: `${ESC}[32m`,
  literal: `${ESC}[33m`,
  builtin: `${ESC}[36m`,
  call: `${ESC}[34m`,
  operator: `${ESC}[95m`,
  comment: `${ESC}[90m`,
  regex: `${ESC}[31m`,
} as const
/** The default colour again (other attributes, as bold, kept). */
const DEFAULT = `${ESC}[39m`
/** Past this, a text is written plain: colouring it would cost more than it shows. */
const MAX_HIGHLIGHT = 256 * 1024

// prettier-ignore
const KEYWORDS = new Set([
  'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'default', 'delete', 'do',
  'else', 'export', 'extends', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'let',
  'new', 'of', 'return', 'switch', 'this', 'throw', 'try', 'typeof', 'var', 'void', 'while', 'yield',
])
const LITERALS = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity'])
// prettier-ignore
const BUILTINS = new Set([
  'db', 'rs', 'sh', 'sp', 'use', 'show', 'it', 'print', 'printjson', 'ObjectId', 'ISODate', 'Date',
  'NumberDecimal', 'NumberLong', 'NumberInt', 'Decimal128', 'Long', 'Int32', 'Double', 'Timestamp',
  'BinData', 'UUID', 'MinKey', 'MaxKey', 'BSONRegExp', 'Code', 'DBRef', 'BSONSymbol', 'Binary',
])
/** After these (or at the start, or after a keyword), a / starts a regular expression, not a division. */
// prettier-ignore
const BEFORE_REGEX = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^'])

/** A name, in any script (eşit, işin, é1 are one name each). */
const NAME = /[\p{ID_Start}$_][\p{ID_Continue}$\u200c\u200d]*/uy
const NAME_PART = /[\p{ID_Continue}$\u200c\u200d]/u
const NUMBER = /(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)n?/y

/** The code point ending just before `i`. */
function before(text: string, i: number): string {
  if (i <= 0) return ''
  const low = text.charCodeAt(i - 1)
  return low >= 0xdc00 && low <= 0xdfff && i >= 2 ? text.slice(i - 2, i) : text[i - 1]!
}

/** The end of a string opened at `i` with `quote` (a template's ${} followed, its strings too). */
function stringEnd(text: string, i: number, quote: string): number {
  let at = i + 1
  while (at < text.length) {
    const c = text[at]!
    if (c === '\\') at += 2
    else if (c === quote) return at + 1
    else if (quote !== '`' && (c === '\r' || c === '\n')) return at
    else if (quote === '`' && c === '$' && text[at + 1] === '{') {
      // An expression: to its closing brace, the strings in it skipped whole.
      let depth = 1
      at += 2
      while (at < text.length && depth > 0) {
        const e = text[at]!
        if (e === '"' || e === "'" || e === '`') at = stringEnd(text, at, e)
        else {
          if (e === '{') depth++
          else if (e === '}') depth--
          at++
        }
      }
    } else at++
  }
  return Math.min(at, text.length)
}

/** The end of a regular expression opened at `i`, or -1 when it is none (no closing / on its line). */
function regexEnd(text: string, i: number): number {
  let at = i + 1
  let inClass = false
  while (at < text.length) {
    const c = text[at]!
    if (c === '\r' || c === '\n') return -1
    if (c === '\\') at += 2
    else if (c === '[') {
      inClass = true
      at++
    } else if (c === ']') {
      inClass = false
      at++
    } else if (c === '/' && !inClass) {
      at++
      while (at < text.length && /[a-z]/.test(text[at]!)) at++
      return at
    } else at++
  }
  return -1
}

/** The text with the app's colours around its tokens. */
export function highlight(safe: string): string {
  if (safe.length > MAX_HIGHLIGHT) return safe
  let out = ''
  let i = 0
  const n = safe.length
  /** The last token that was not a space: after it a / is a division, or a regular expression. */
  let last = ''
  const paint = (colour: string, from: number, to: number) => {
    out += colour + safe.slice(from, to) + DEFAULT
  }
  while (i < n) {
    const ch = safe[i]!
    const next = safe[i + 1]
    if (ch === '/' && next === '/') {
      let end = i + 2
      while (end < n && safe[end] !== '\r' && safe[end] !== '\n') end++
      paint(COLOUR.comment, i, end)
      i = end
      continue
    }
    if (ch === '/' && next === '*') {
      const close = safe.indexOf('*/', i + 2)
      const end = close < 0 ? n : close + 2
      paint(COLOUR.comment, i, end)
      i = end
      continue
    }
    if (ch === '/' && (last === '' || BEFORE_REGEX.has(last) || KEYWORDS.has(last))) {
      const end = regexEnd(safe, i)
      if (end > 0) {
        paint(COLOUR.regex, i, end)
        last = 'regex'
        i = end
        continue
      }
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const end = stringEnd(safe, i, ch)
      paint(COLOUR.string, i, end)
      last = 'string'
      i = end
      continue
    }
    if (ch >= '0' && ch <= '9' && !NAME_PART.test(before(safe, i))) {
      NUMBER.lastIndex = i
      const m = NUMBER.exec(safe)
      const end = i + (m ? m[0].length : 1)
      paint(COLOUR.literal, i, end)
      last = 'number'
      i = end
      continue
    }
    NAME.lastIndex = i
    const name = NAME_PART.test(before(safe, i)) ? null : NAME.exec(safe)
    if (name) {
      const word = name[0]
      const end = i + word.length
      let after = end
      while (safe[after] === ' ') after++
      let back = i - 1
      while (back >= 0 && safe[back] === ' ') back--
      const property = back >= 0 && safe[back] === '.'
      const key = safe[after] === ':' && safe[after + 1] !== ':'
      const plain = key || property
      const colour =
        word.startsWith('$') && word.length > 1
          ? COLOUR.operator
          : plain
            ? property && safe[after] === '('
              ? COLOUR.call
              : null
            : KEYWORDS.has(word)
              ? COLOUR.keyword
              : LITERALS.has(word)
                ? COLOUR.literal
                : BUILTINS.has(word)
                  ? COLOUR.builtin
                  : safe[after] === '('
                    ? COLOUR.call
                    : null
      if (colour) paint(colour, i, end)
      else out += word
      last = !plain && KEYWORDS.has(word) ? word : 'name'
      i = end
      continue
    }
    out += ch
    if (ch !== ' ' && ch !== '\t' && ch !== '\r' && ch !== '\n') last = ch
    i += 1
  }
  return out
}
