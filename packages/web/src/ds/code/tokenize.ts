export type TokenType =
  'string' | 'number' | 'key' | 'operator' | 'constructor' | 'keyword' | 'comment' | 'punct' | 'text'

export interface Token {
  type: TokenType
  text: string
}

const CONSTRUCTORS = new Set([
  'ObjectId',
  'ISODate',
  'Date',
  'NumberInt',
  'NumberLong',
  'NumberDecimal',
  'Decimal128',
  'Double',
  'UUID',
  'BinData',
  'Timestamp',
  'MinKey',
  'MaxKey',
  'RegExp',
  'DBRef',
])
const KEYWORDS = new Set(['true', 'false', 'null', 'undefined', 'new', 'Infinity', 'NaN'])

// Sticky patterns tried in order at the current position; the last one always matches one character.
const PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['comment', /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/y],
  ['string', /"(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?/y],
  ['number', /0[xX][\da-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y],
  ['operator', /\$[\w$]*/y],
  ['word', /[A-Za-z_][\w$]*/y],
  ['space', /\s+/y],
  ['punct', /[\s\S]/uy],
]

function nextNonSpace(src: string, from: number): string | undefined {
  let i = from
  while (i < src.length && /\s/.test(src[i]!)) i++
  return src[i]
}

function classify(kind: string, text: string, src: string, end: number): TokenType {
  switch (kind) {
    case 'space':
      return 'text'
    case 'string':
      return nextNonSpace(src, end) === ':' ? 'key' : 'string'
    case 'word':
      if (nextNonSpace(src, end) === ':') return 'key'
      if (CONSTRUCTORS.has(text)) return 'constructor'
      if (KEYWORDS.has(text)) return 'keyword'
      return 'text'
    default:
      return kind as TokenType
  }
}

/** Display-only tokenizer for shell-style values; lossless (texts concatenate back to src). */
export function tokenize(src: string): Token[] {
  const tokens: Token[] = []
  let pos = 0
  while (pos < src.length) {
    for (const [kind, pattern] of PATTERNS) {
      pattern.lastIndex = pos
      const match = pattern.exec(src)
      if (!match || match[0] === '') continue
      const text = match[0]
      const type = classify(kind, text, src, pos + text.length)
      const last = tokens.at(-1)
      if (last && last.type === type) last.text += text
      else tokens.push({ type, text })
      pos += text.length
      break
    }
  }
  return tokens
}
