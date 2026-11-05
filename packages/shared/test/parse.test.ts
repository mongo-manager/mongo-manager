// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { BSONRegExp } from 'bson'
import { MAX_INPUT_LENGTH, parsePipeline, parseQueryObject, parseShellExpression } from '../src/query/parse'
import { QueryParseError } from '../src/query/errors'

function parseError(fn: () => unknown): QueryParseError {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(QueryParseError)
    return e as QueryParseError
  }
  throw new Error('expected a QueryParseError')
}

describe('parseShellExpression: literals and structure', () => {
  it('parses scalars', () => {
    expect(parseShellExpression('42')).toBe(42)
    expect(parseShellExpression('-1.5')).toBe(-1.5)
    expect(parseShellExpression('+3')).toBe(3)
    expect(parseShellExpression("'single'")).toBe('single')
    expect(parseShellExpression('"double"')).toBe('double')
    expect(parseShellExpression('`template`')).toBe('template')
    expect(parseShellExpression('true')).toBe(true)
    expect(parseShellExpression('null')).toBeNull()
    expect(parseShellExpression('NaN')).toBeNaN()
    expect(parseShellExpression('-Infinity')).toBe(-Infinity)
  })

  it('parses objects with bare, quoted and $ keys, nested arrays and trailing commas', () => {
    expect(parseQueryObject('{ a: 1, "b c": [1, "x", { $gt: 2 },], $or: [], }')).toEqual({
      a: 1,
      'b c': [1, 'x', { $gt: 2 }],
      $or: [],
    })
  })

  it('keeps string contents untouched (old parser bug)', () => {
    expect(
      parseQueryObject(
        `{ url: "http://a/b", d: "2024/01/02", s: "ObjectId('x')", c: "// not a comment", r: "/x/i" }`,
      ),
    ).toEqual({ url: 'http://a/b', d: '2024/01/02', s: "ObjectId('x')", c: '// not a comment', r: '/x/i' })
  })

  it('parses regex literals into BSONRegExp', () => {
    const v = parseQueryObject('{ name: /^ab/i }')
    expect(v.name).toBeInstanceOf(BSONRegExp)
    expect((v.name as BSONRegExp).pattern).toBe('^ab')
    expect((v.name as BSONRegExp).options).toBe('i')
  })

  it('accepts comments and a trailing semicolon from pasted shell snippets', () => {
    expect(parseQueryObject('{ a: 1 };')).toEqual({ a: 1 })
    expect(parseQueryObject('{ a: 1 /* one */ } // done')).toEqual({ a: 1 })
    expect(parseQueryObject('// leading\n{ a: 1 }')).toEqual({ a: 1 })
  })

  it('accepts parentheses around any value, as the shell does', () => {
    expect(parseQueryObject('({ a: 1 })')).toEqual({ a: 1 })
    expect(parseShellExpression('((1))')).toBe(1)
    expect(parseShellExpression('[(1), -(2), { a: ("x") }]')).toEqual([1, -2, { a: 'x' }])
    expect(parseShellExpression('(ObjectId("0123456789abcdef01234567"))')).toBeDefined()
    expect(() => parseShellExpression('(1, 2)')).toThrow(QueryParseError)
  })

  it('treats empty input as an empty filter', () => {
    expect(parseQueryObject('')).toEqual({})
    expect(parseQueryObject('   \n ')).toEqual({})
  })

  it('stores __proto__ and constructor as own properties without polluting prototypes', () => {
    const v = parseQueryObject('{ "__proto__": { polluted: true }, constructor: 1 }')
    expect(Object.getPrototypeOf(v)).toBe(Object.prototype)
    expect(Object.hasOwn(v, '__proto__')).toBe(true)
    expect(Object.hasOwn(v, 'constructor')).toBe(true)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('parses pipelines', () => {
    expect(parsePipeline('[{ $match: { a: 1 } }, { $limit: 5 }]')).toEqual([
      { $match: { a: 1 } },
      { $limit: 5 },
    ])
  })
})

describe('parseShellExpression: rejection', () => {
  const rejected: Array<[string, RegExp]> = [
    ['this.constructor.constructor("return process")()', /Only direct calls/],
    ['process.exit(1)', /Only direct calls/],
    ['(() => 1)()', /Only direct calls/],
    ['function () { return 1 }', /not allowed|Unexpected/],
    ['{ a: 1 }); require("fs"); ({ b: 2 }', /single expression/],
    ['{ a: 1 }); require("fs"); ({', /single expression/],
    ['{ ...other }', /key: value/],
    ['{ [key]: 1 }', /Computed keys/],
    ['{ a }', /key: value/],
    ['{ get a() { return 1 } }', /key: value/],
    ['a = 1', /not allowed/],
    ['`${x}`', /Template literals/],
    ['new Proxy({}, {})', /Function "Proxy" is not allowed/],
    ['Math.max(1)', /Only direct calls/],
    ['toString()', /Function "toString" is not allowed/],
    ['constructor()', /Function "constructor" is not allowed/],
    ['1n', /BigInt/],
    ['undefined', /Unknown identifier "undefined"/],
    ['x', /Unknown identifier "x"/],
    ['[1, , 2]', /Empty array slots/],
    ['import("fs")', /not allowed/],
    ['a?.b', /not allowed/],
    ['{ _bsontype: "ObjectId" }', /_bsontype/],
    ['{ a: 1, a: 2 }', /Duplicate key "a"/],
  ]
  for (const [src, message] of rejected) {
    it(`rejects ${src}`, () => {
      expect(parseError(() => parseShellExpression(src)).message).toMatch(message)
    })
  }

  it('rejects empty expressions', () => {
    expect(parseError(() => parseShellExpression('  ')).message).toMatch(/empty/)
  })

  it('reports 1-based line and column of the offending node', () => {
    const e = parseError(() => parseQueryObject('{\n  a: 1,\n  b: foo\n}'))
    expect(e.message).toMatch(/Unknown identifier "foo"/)
    expect(e.line).toBe(3)
    expect(e.column).toBe(6)
  })

  it('reports syntax errors with a position', () => {
    const e = parseError(() => parseQueryObject('{ a: 1,, }'))
    expect(e.line).toBe(1)
    expect(e.column).toBeGreaterThan(1)
  })

  it('enforces the input length limit', () => {
    expect(parseError(() => parseShellExpression(' '.repeat(MAX_INPUT_LENGTH + 1) + '1')).message).toMatch(
      /exceeds/,
    )
  })

  it('enforces the nesting limit, including stack-overflowing input', () => {
    expect(parseError(() => parseShellExpression('['.repeat(150) + ']'.repeat(150))).message).toMatch(
      /too deeply nested/,
    )
    expect(parseError(() => parseShellExpression('['.repeat(200_000) + ']'.repeat(200_000))).message).toMatch(
      /too deeply nested/,
    )
  })

  it('requires the right top-level shape', () => {
    expect(parseError(() => parseQueryObject('[1]')).message).toMatch(/Expected an object/)
    expect(parseError(() => parsePipeline('{}')).message).toMatch(/Expected an array of stage objects/)
    expect(parseError(() => parsePipeline('[1]')).message).toMatch(/Expected an array of stage objects/)
  })
})
