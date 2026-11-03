import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { MAX_DEPTH, MAX_INPUT_LENGTH, parseShellExpression } from '../src/query/parse'
import { QueryParseError } from '../src/query/errors'

/** Parses, and fails the property on anything but a value or a QueryParseError. */
function parses(src: string): void {
  try {
    parseShellExpression(src)
  } catch (e) {
    if (!(e instanceof QueryParseError))
      throw new Error(`unexpected ${String(e)} for ${JSON.stringify(src)}`, { cause: e })
  }
}

// Pieces that stress the parser: syntax, constructors, prototype names, code-looking text.
const TOKENS = [
  '{',
  '}',
  '[',
  ']',
  '(',
  ')',
  ':',
  ',',
  '.',
  '-',
  '+',
  "'",
  '"',
  '`',
  '\\',
  '/',
  '//',
  '/*',
  '*/',
  '$gt',
  '$where',
  '$function',
  'ObjectId(',
  'ISODate(',
  'Date(',
  'NumberLong(',
  'NumberDecimal(',
  'UUID(',
  'BinData(',
  'Timestamp(',
  'RegExp(',
  'new ',
  'function',
  '=>',
  'this',
  'constructor',
  '__proto__',
  'prototype',
  'eval',
  'require',
  'process',
  'globalThis',
  'Infinity',
  'NaN',
  '1e999',
  '-0',
  '0x1F',
  '1_000',
  'null',
  'undefined',
  'true',
  'a',
  '"k"',
  ' ',
  '\n',
  '\t',
  '\u0000',
  '\u2028',
  '😀',
  'é',
]

describe('the shell parser under adversarial input (spec §9, Review Focus 3)', () => {
  it('returns a value or a QueryParseError for any text', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 300 }), (s) => parses(s)),
      { numRuns: 3000 },
    )
  })

  it('returns a value or a QueryParseError for any mix of its own syntax', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...TOKENS), { maxLength: 60 }), (parts) => parses(parts.join(''))),
      { numRuns: 5000 },
    )
  })

  it('refuses nesting beyond its limit and input beyond its length, quickly', () => {
    // Balanced, so the refusal is about the depth and not about a missing closing bracket;
    // 90_000 levels stay under MAX_INPUT_LENGTH for every shape and overflow a naive recursion.
    const shapes: [string, string][] = [
      ['[', ']'],
      ['{a:', '}'],
      ['(', ')'],
      ['ObjectId(', ')'],
    ]
    for (const [open, close] of shapes) {
      for (const n of [MAX_DEPTH + 1, 90_000]) {
        const started = performance.now()
        expect(() => parseShellExpression(open.repeat(n) + '1' + close.repeat(n)), `${open} × ${n}`).toThrow(
          /too deeply nested/,
        )
        expect(performance.now() - started).toBeLessThan(1000)
      }
      expect(() => parseShellExpression(open.repeat(MAX_DEPTH * 50))).toThrow(QueryParseError)
    }
    expect(() => parseShellExpression(' '.repeat(MAX_INPUT_LENGTH + 1))).toThrow(QueryParseError)
  })

  it('leaves global state untouched', () => {
    const globals = Object.getOwnPropertyNames(globalThis).sort()
    const objectProto = Object.getOwnPropertyNames(Object.prototype).sort()
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...TOKENS), { maxLength: 40 }), (parts) => parses(parts.join(''))),
      { numRuns: 2000 },
    )
    for (const src of ['{ __proto__: { polluted: 1 } }', '{ constructor: { prototype: { polluted: 1 } } }'])
      parses(src)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(Object.getOwnPropertyNames(globalThis).sort()).toEqual(globals)
    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(objectProto)
  })
})
