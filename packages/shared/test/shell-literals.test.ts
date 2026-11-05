// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import {
  fillSnippet,
  isIdentifier,
  jsString,
  memberAccess,
  objectKey,
  paramLiteral,
  placeholdersOf,
  type SnippetParam,
} from '../src/shell/literals'

/**
 * Phase 3a-2 spec §3.2 (A3) and §3.5 (A8): database-derived names and snippet parameter values
 * become code in the shell editor. These primitives are the only way such text is inserted, and
 * each must turn hostile text into an inert literal.
 */
const HOSTILE = 'a"]);db.dropDatabase();x["'

describe('isIdentifier', () => {
  it('accepts plain identifiers and refuses everything else', () => {
    for (const name of ['a', '_x', '$in', 'a1']) expect(isIdentifier(name), name).toBe(true)
    for (const name of ['1a', 'a b', 'a-b', '', 'a"', 'ä']) expect(isIdentifier(name), name).toBe(false)
  })
})

describe('memberAccess and objectKey (review focus 2)', () => {
  it('uses dot access only for identifiers', () => {
    expect(memberAccess('orders')).toBe('.orders')
    expect(memberAccess('my coll')).toBe('["my coll"]')
  })

  it('turns a hostile name into one escaped string literal', () => {
    expect(memberAccess(HOSTILE)).toBe(`[${JSON.stringify(HOSTILE)}]`)
    expect(memberAccess(HOSTILE)).toBe('["a\\"]);db.dropDatabase();x[\\""]')
    // Reading the literal back gives the name exactly: nothing outside it is code.
    expect(JSON.parse(memberAccess(HOSTILE).slice(1, -1))).toBe(HOSTILE)
  })

  it('quotes object keys that are not identifiers', () => {
    expect(objectKey('name')).toBe('name')
    expect(objectKey('a.b')).toBe('"a.b"')
    const key = 'x":1}); db.dropDatabase(); ({"'
    expect(objectKey(key)).toBe(JSON.stringify(key))
  })
})

describe('placeholdersOf', () => {
  it('lists declared-looking placeholders once, in order', () => {
    expect(placeholdersOf('db.a.find({x: {{ v }}, y: {{w}}, z: {{v}}})')).toEqual(['v', 'w'])
  })

  it('ignores braces whose name is not a parameter name', () => {
    expect(placeholdersOf('{{1x}} {{a-b}} {{}} {{ }}')).toEqual([])
    expect(placeholdersOf(`{{${'a'.repeat(65)}}}`)).toEqual([])
  })
})

describe('paramLiteral (review focus 3)', () => {
  it('makes a string an inert JSON string literal', () => {
    const r = paramLiteral('string', '"); db.dropDatabase(); ("')
    expect(r).toEqual({ ok: true, literal: '"\\"); db.dropDatabase(); (\\""' })
    for (const value of ['line\nbreak', 'sep\u2028sep', 'back\\slash', '</script>']) {
      const lit = paramLiteral('string', value)
      expect(lit.ok && JSON.parse(lit.literal)).toBe(value)
    }
  })

  it('accepts only plain finite numbers', () => {
    expect(paramLiteral('number', '42')).toEqual({ ok: true, literal: '42' })
    // A negative number is parenthesised, so `a-{{n}}` cannot become `a--5` (final review I1).
    expect(paramLiteral('number', '-1.5e3')).toEqual({ ok: true, literal: '(-1500)' })
    expect(paramLiteral('number', '0')).toEqual({ ok: true, literal: '0' })
    for (const bad of ['NaN', 'Infinity', '1;drop', '0x10', '1e999', ' ', '01', '+1']) {
      expect(paramLiteral('number', bad), bad).toEqual({ ok: false, error: 'number' })
    }
  })

  it('refuses an integer a JavaScript number would silently round (final review M7)', () => {
    expect(paramLiteral('number', '9007199254740991')).toEqual({ ok: true, literal: '9007199254740991' })
    for (const bad of ['9007199254740993', '-9007199254740993', '12345678901234567890'])
      expect(paramLiteral('number', bad), bad).toEqual({ ok: false, error: 'number' })
  })

  it('accepts only true and false', () => {
    expect(paramLiteral('boolean', 'true')).toEqual({ ok: true, literal: 'true' })
    expect(paramLiteral('boolean', 'false')).toEqual({ ok: true, literal: 'false' })
    for (const bad of ['True', '1', 'tru'])
      expect(paramLiteral('boolean', bad)).toEqual({ ok: false, error: 'boolean' })
  })

  it('wraps EJSON in one string literal passed to EJSON.parse', () => {
    const raw = '{"a":{"$numberInt":"1"},"d":{"$date":{"$numberLong":"0"}}}'
    expect(paramLiteral('ejson', raw)).toEqual({ ok: true, literal: `EJSON.parse(${JSON.stringify(raw)})` })
    expect(paramLiteral('ejson', '{bad')).toEqual({ ok: false, error: 'ejson' })
    const hostile = paramLiteral('ejson', '{"s":"\\"); drop("}')
    expect(hostile.ok).toBe(true)
    if (hostile.ok) {
      // Exactly one call around one string literal.
      expect(hostile.literal.startsWith('EJSON.parse("')).toBe(true)
      expect(JSON.parse(hostile.literal.slice('EJSON.parse('.length, -1))).toBe('{"s":"\\"); drop("}')
    }
  })

  it('refuses a value over 64 KiB', () => {
    expect(paramLiteral('string', 'x'.repeat(64 * 1024 + 1))).toEqual({ ok: false, error: 'too_large' })
  })
})

describe('fillSnippet (review focus 3)', () => {
  const params: SnippetParam[] = [
    { name: 'v', type: 'string' },
    { name: 'n', type: 'number', default: '5' },
    { name: 'other', type: 'string' },
  ]

  it('substitutes every occurrence and uses defaults', () => {
    const r = fillSnippet('db.a.find({v: {{v}}, w: {{ v }}}).limit({{n}})', params, { v: 'x' })
    expect(r).toEqual({ ok: true, code: 'db.a.find({v: "x", w: "x"}).limit(5)' })
  })

  it('never substitutes twice: a value that looks like a placeholder stays text', () => {
    const r = fillSnippet('print({{v}}, {{other}})', params, { v: '{{other}}', other: 'o' })
    expect(r).toEqual({ ok: true, code: 'print("{{other}}", "o")' })
  })

  it('collects every error at once', () => {
    const r = fillSnippet('{{v}} {{n}} {{missing}}', [...params.slice(0, 1), { name: 'n', type: 'number' }], {
      n: 'abc',
    })
    expect(r).toEqual({ ok: false, errors: { v: 'required', n: 'number', missing: 'undeclared' } })
  })

  it('refuses an empty value for a required parameter, even with a default (final review M7)', () => {
    const required: SnippetParam[] = [{ name: 's', type: 'string', default: 'd', required: true }]
    expect(fillSnippet('print({{s}})', required, { s: '' })).toEqual({ ok: false, errors: { s: 'required' } })
    expect(fillSnippet('print({{s}})', required, {})).toEqual({ ok: true, code: 'print("d")' })
    // Not required: an empty string is a value.
    expect(fillSnippet('print({{v}})', params, { v: '' })).toEqual({ ok: true, code: 'print("")' })
  })

  it('keeps a hostile string inert', () => {
    const r = fillSnippet('db.a.insertOne({v: {{v}}})', params, { v: '"}); db.dropDatabase(); ({"' })
    expect(r.ok && r.code).toBe(`db.a.insertOne({v: ${jsString('"}); db.dropDatabase(); ({"')}})`)
  })
})

describe('placeholders outside a value position (final review I1)', () => {
  const params: SnippetParam[] = [{ name: 's', type: 'string' }]
  const hostile = '+db.dropDatabase()+'

  it('refuses a placeholder inside a string, template, regex or comment', () => {
    for (const code of [
      'db.c.find({ name: "{{s}}" })',
      "db.c.find({ name: '{{s}}' })",
      'db.c.find({ name: `{{s}}` })',
      'db.c.find({ name: /{{s}}/ })',
      'db.c.find() // {{s}}',
      'db.c.find() /* {{s}} */',
    ]) {
      expect(fillSnippet(code, params, { s: hostile }), code).toEqual({ ok: false, errors: { s: 'context' } })
    }
  })

  it('still fills a placeholder in a value position, division included', () => {
    const numbers: SnippetParam[] = [
      { name: 'a', type: 'number' },
      { name: 'b', type: 'number' },
    ]
    expect(fillSnippet('print({{a}} / {{b}})', numbers, { a: '6', b: '-2' })).toEqual({
      ok: true,
      code: 'print(6 / (-2))',
    })
    expect(fillSnippet('x - {{a}}', numbers, { a: '-5' })).toEqual({ ok: true, code: 'x - (-5)' })
  })

  it('escapes the line separators that end a comment', () => {
    const r = paramLiteral('string', 'a\u2028b\u2029c')
    // The literal holds the escape sequences, not the raw separators.
    expect(r.ok && r.literal).toBe('"a\\u2028b\\u2029c"')
    expect(r.ok && r.literal).not.toMatch(/[\u2028\u2029]/)
    expect(r.ok && JSON.parse(r.literal)).toBe('a\u2028b\u2029c')
  })
})
