// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { Int32, ObjectId } from 'bson'
import { parsePipeline, parseQueryObject } from '../src/query/parse'
import { QueryParseError } from '../src/query/errors'
import { formatShell } from '../src/query/format'
import { serializeValue } from '../src/ejson'
import {
  MAX_QUERY_PARAMS,
  fillParams,
  isParam,
  paramOf,
  paramsOf,
  parseParamValue,
} from '../src/query/params'

/**
 * Query parameters (spec 2026-10-28-query-parameters-design.md): `{{name}}` where a value goes in the
 * query bar, read as a marker; values filled in before the query runs.
 */
const P = (src: string) => parseQueryObject(src, { params: true })

function parseError(fn: () => unknown): QueryParseError {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(QueryParseError)
    return e as QueryParseError
  }
  throw new Error('expected a QueryParseError')
}

describe('a parameter in the query bar', () => {
  it('is read as a marker where a value goes, in objects and arrays, once per name in order', () => {
    const q = P('{ status: {{status}}, age: { $gte: {{ minAge }} }, tag: { $in: [{{a}}, "x", {{status}}] } }')
    expect(q).toEqual({
      status: paramOf('status'),
      age: { $gte: paramOf('minAge') },
      tag: { $in: [paramOf('a'), 'x', paramOf('status')] },
    })
    expect(paramsOf(q)).toEqual(['status', 'minAge', 'a'])
    expect(isParam(paramOf('x'))).toBe(true)
    expect(isParam({ $$param: 'x', other: 1 })).toBe(false)
    expect(isParam({ $$param: '1x' })).toBe(false)
  })

  it('is plain text inside a string, a regular expression or a comment', () => {
    const q = P('{ a: "{{x}}", b: /{{y}}/, c: 1 /* {{z}} */ }')
    expect(q.a).toBe('{{x}}')
    expect(paramsOf(q)).toEqual([])
  })

  it('is refused as a field name, and as a constructor argument, saying why', () => {
    expect(parseError(() => P('{ {{f}}: 1 }')).message).toMatch(/stands for a value/)
    const e = parseError(() => P('{ _id: ObjectId({{id}}) }'))
    expect(e.message).toMatch(/\{\{id\}\} stands for a whole value/)
    // Where it is in the text is kept: the marker takes the placeholder's place, character for character.
    const at = parseError(() => P('{ a: {{x}}, b: nope }'))
    expect(at.column).toBe('{ a: {{x}}, b: '.length + 1)
  })

  it('is no parameter where parameters are not read: the query bar without them', () => {
    expect(() => parseQueryObject('{ a: {{x}} }')).toThrow(QueryParseError)
  })

  it('is read in a pipeline too', () => {
    const stages = parsePipeline('[{ $match: { n: {{n}} } }]', { params: true })
    expect(paramsOf(stages)).toEqual(['n'])
  })

  it('takes no more than 20 names', () => {
    const many = Array.from({ length: MAX_QUERY_PARAMS + 1 }, (_, i) => `f${i}: {{p${i}}}`).join(', ')
    expect(parseError(() => P(`{ ${many} }`)).message).toMatch(/20 parameters at most/)
  })

  it('is written back as {{name}}, and the marker survives canonical EJSON', () => {
    const q = P('{ a: {{x}}, b: { $in: [{{y}}] } }')
    expect(formatShell(q, { indent: 0, params: true })).toBe('{ a: {{x}}, b: { $in: [{{y}}] } }')
    // Elsewhere (a document's value) the marker is the object it is (final review, Minor 1).
    expect(formatShell(q, { indent: 0 })).toBe('{ a: { $$param: "x" }, b: { $in: [{ $$param: "y" }] } }')
    expect(serializeValue(q)).toEqual({ a: { $$param: 'x' }, b: { $in: [{ $$param: 'y' }] } })
  })
})

describe('a value given to a parameter', () => {
  it('is read as the query bar reads a value, and as text when it is not one', () => {
    expect(parseParamValue('18')).toBe(18)
    expect(parseParamValue('"18"')).toBe('18')
    expect(parseParamValue('true')).toBe(true)
    expect(parseParamValue('null')).toBeNull()
    expect(parseParamValue('ObjectId("65a1b2c3d4e5f60718293a4b")')).toEqual(
      new ObjectId('65a1b2c3d4e5f60718293a4b'),
    )
    expect(parseParamValue('NumberInt(5)')).toEqual(new Int32(5))
    expect(parseParamValue('{ $ne: 1 }')).toEqual({ $ne: 1 })
    expect(parseParamValue('active')).toBe('active')
    expect(parseParamValue('New York')).toBe('New York')
    expect(parseParamValue('2026-01-01')).toBe('2026-01-01')
    // Text as typed: spaces kept, nothing evaluated.
    expect(parseParamValue(' a ')).toBe(' a ')
    expect(parseParamValue('process.exit()')).toBe('process.exit()')
  })

  it('is never itself read for parameters', () => {
    expect(() => parseParamValue('{{x}}')).toThrow(QueryParseError)
    expect(fillParams(P('{ a: {{a}} }'), { a: '{ $$param: "b" }' })).toMatchObject({
      ok: false,
      errors: { a: 'invalid' },
    })
  })

  // Final review (Important 4): code with a mistake in it is said to be one, never searched for as text.
  it('says why a value written as code cannot be read, and keeps paths and phone numbers as text', () => {
    for (const text of [
      'ObjectId("bad")',
      '{ $ne: 1',
      'ISODate("2026-13-01")',
      '"unclosed',
      '[1, 2',
      'new Date(',
    ]) {
      expect(() => parseParamValue(text), text).toThrow(QueryParseError)
    }
    expect(parseParamValue('/api/users')).toBe('/api/users')
    expect(parseParamValue('(555) 123-4567')).toBe('(555) 123-4567')
    expect(parseParamValue('Smith (Jr)')).toBe('Smith (Jr)')
    const filled = fillParams(P('{ a: {{a}} }'), { a: 'ObjectId("bad")' })
    expect(filled).toMatchObject({ ok: false, errors: { a: 'invalid' } })
    expect(!filled.ok && filled.messages.a).toMatch(/ObjectId/)
  })
})

describe('filling the values in', () => {
  it('replaces every marker, deep, leaving the rest as it was', () => {
    const q = P('{ s: {{s}}, a: { $gte: {{n}} }, l: [{{s}}, 2] }')
    expect(fillParams(q, { s: 'open', n: '3' })).toEqual({
      ok: true,
      value: { s: 'open', a: { $gte: 3 }, l: ['open', 2] },
    })
    // The template is left as it was.
    expect(paramsOf(q)).toEqual(['s', 'n'])
  })

  it('names every parameter with no value, or one too large, at once', () => {
    const q = P('{ a: {{a}}, b: {{b}}, c: {{c}} }')
    expect(fillParams(q, { a: '', c: 'x'.repeat(64 * 1024 + 1) })).toEqual({
      ok: false,
      errors: { a: 'required', b: 'required', c: 'too_large' },
      messages: {},
    })
  })

  it('fills nothing in a value with no parameters', () => {
    expect(fillParams({ a: 1 }, {})).toEqual({ ok: true, value: { a: 1 } })
  })
})

// Final review of the query parameters: what the parameters must never be.
describe('parameters, final review', () => {
  it('takes names every object has as names like any other (Important 1)', () => {
    const q = P('{ a: {{constructor}}, b: {{__proto__}}, c: {{toString}} }')
    expect(paramsOf(q)).toEqual(['constructor', '__proto__', 'toString'])
    expect(fillParams(q, {})).toMatchObject({
      ok: false,
      errors: { constructor: 'required', __proto__: 'required', toString: 'required' },
    })
    const errors = (fillParams(q, {}) as { errors: Record<string, string> }).errors
    expect(Object.keys(errors)).toEqual(['constructor', '__proto__', 'toString'])
    const values = JSON.parse('{"constructor":"1","__proto__":"2","toString":"3"}') as Record<string, string>
    expect(fillParams(q, values)).toEqual({ ok: true, value: { a: 1, b: 2, c: 3 } })
    // A value only the values' prototype holds is none (a polluted prototype gives nothing).
    const inherited = Object.create({ x: 'evil' }) as Record<string, string>
    expect(fillParams(P('{ a: {{x}} }'), inherited)).toMatchObject({ ok: false, errors: { x: 'required' } })
  })

  it('finds a parameter anywhere in a typed value, and refuses it there (Important 2)', () => {
    expect(
      parseError(() => P('{ r: DBRef("c", ObjectId("65a1b2c3d4e5f60718293a4b"), "db", { x: {{id}} }) }'))
        .message,
    ).toMatch(/\{\{id\}\} stands for a whole value/)
    expect(parseError(() => P('{ c: { $code: "x", $scope: { a: {{p}} } } }')).message).toMatch(
      /\{\{p\}\} stands for a whole value/,
    )
    expect(parseError(() => P('{ d: { $date: {{d}} } }')).message).toMatch(
      /\{\{d\}\} stands for a whole value/,
    )
  })

  it('refuses a whole part, or a whole stage, written as one parameter (Important 3)', () => {
    expect(parseError(() => P('{{f}}')).message).toMatch(/Expected an object/)
    expect(parseError(() => parsePipeline('[{{s}}]', { params: true })).message).toMatch(
      /Expected an array of stage objects/,
    )
    expect(parseError(() => parsePipeline('{{p}}', { params: true })).message).toMatch(/Expected an array/)
  })

  it('says in plain words a parameter that does not stand alone, or is misnamed (Minor 2)', () => {
    for (const text of ['{ a: x{{p}} }', '{ a: {{p}}{{q}} }', '{ a: {{f}}(1) }', '{ a: {{p}}x }']) {
      const e = parseError(() => P(text))
      expect(e.message, text).toMatch(/stands alone for a whole value/)
      expect(e.message).not.toMatch(/[\u0278\u0298\u01c2\u01c0]/)
    }
    expect(parseError(() => P(`{ a: {{${'n'.repeat(65)}}} }`)).message).toMatch(/64 at most/)
  })

  it('reads no escaped identifier as a parameter (Minor 3)', () => {
    // The text holds no placeholder where the identifier is: it is unknown, as any other.
    const escaped = '{ a: {{p}}, b: \\u0278\\u0030\\u0278\\u0278\\u0278 }'
    expect(parseError(() => P(escaped)).message).toMatch(/Unknown identifier/)
  })

  it('says a text holding every letter a parameter could stand in as cannot be read for parameters', () => {
    const all = '{ s: "\u0278\u0298\u01c2\u01c0", a: {{p}} }'
    expect(parseError(() => P(all)).message).toMatch(/Parameters cannot be read in this text/)
  })
})
