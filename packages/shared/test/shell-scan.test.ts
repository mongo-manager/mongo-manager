// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { CodeScanner, isIncomplete, shellCommand } from '../src/shell/scan'

/**
 * Review 2026-10-12 (I2): Enter only ever started a new line for complete code a naive scan took for
 * open — a regex with `//` or a quote in it, a template with a backtick inside `${}` — and code that
 * could not end where Enter was pressed (after `.`, an operator, `if (…)`) was run, a syntax error.
 * The scanner says what mongosh's own reader says: whether the code may go on.
 */
describe('isIncomplete', () => {
  it('goes on while a bracket, a string, a template or a block comment is open', () => {
    for (const code of ['db.x.find({', "db.x.find('ab", '`multi', '/* open', 'f([1, 2', '{ a: [ { b: 1 }'])
      expect(isIncomplete(code), code).toBe(true)
    for (const code of ['db.x.find({ a: 1 })', '// a comment', "db.x.find({ a: '}' })", '', '   ', '/* c */'])
      expect(isIncomplete(code), code).toBe(false)
  })

  it('reads a regular expression as one, its slashes, quotes and brackets inside it', () => {
    for (const code of [
      'db.links.find({ url: /^https?:\\/\\// })',
      '/[(]/.test(x)',
      "/it's/.test(x)",
      'x.replace(/[/]/g, "")',
      'const r = /a\\/b[/]c/',
      'if (/\\{/.test(s)) print(1)',
      'return /x/',
      'typeof /x/',
    ])
      expect(isIncomplete(code), code).toBe(false)
  })

  it('divides after a value, never opening a regular expression there', () => {
    expect(isIncomplete('a / b / c')).toBe(false)
    expect(isIncomplete('(a) / 2 / (b')).toBe(true)
    expect(isIncomplete('x[1] / 2')).toBe(false)
  })

  it('follows a template’s ${} however deep, a backtick or a brace inside it', () => {
    for (const code of ['`a ${ "`" } b`', '`a ${ { b: 1 }.b } c`', '`a ${ `inner ${ 1 }` } b`', '`${"}"}`'])
      expect(isIncomplete(code), code).toBe(false)
    for (const code of ['`a ${ "`" }', '`a ${ { b: 1 }', '`a ${ `inner ${ 1 }` }', '`${'])
      expect(isIncomplete(code), code).toBe(true)
  })

  it('goes on after what cannot end a statement: a dot, a comma, an operator, an arrow', () => {
    for (const code of [
      'db.orders.',
      'const total = a +',
      'const p =',
      'const f = x =>',
      'a &&',
      'x ?',
      'x ? 1 :',
      'a, ',
      'a + // the rest\n',
      'outer:',
      '!',
    ])
      expect(isIncomplete(code), code).toBe(true)
    for (const code of ['i++', 'i--', 'a = b', 'x => x', 'a.b', 'db.orders.find()', 'x // ends with a dot.'])
      expect(isIncomplete(code), code).toBe(false)
  })

  it('goes on after a control header or else, never after a do … while', () => {
    for (const code of ['if (x)', 'for (const it of xs)', 'while (i < 3)', 'if (a) print(1)\nelse', 'do'])
      expect(isIncomplete(code), code).toBe(true)
    // A statement after the header or `else`, ending in a word, is one: nothing more is to come.
    for (const code of [
      'if (x) print(1)',
      'do { i++ } while (i < 3)',
      'f(if_ (x))',
      'while (x) x--',
      'elseIf',
      'if (x) y',
      'if (a) b()\nelse c',
    ])
      expect(isIncomplete(code), code).toBe(false)
  })

  // Second review 2026-10-12 (minor 12).
  it('reads a regular expression right after a header, and keywords used as property names', () => {
    for (const code of [
      "if (x) /'/.test(s)",
      'x.do',
      'stats.in / total // a `b',
      'a?.new',
      'let x = 5.',
      'x = 1.5',
    ])
      expect(isIncomplete(code), code).toBe(false)
  })

  it('goes on after an operator word, a function or class head, try, switch (…) or catch (…)', () => {
    for (const code of [
      'x = typeof',
      'a instanceof',
      'k in',
      'x = new',
      'await',
      'delete',
      'void',
      'function f()',
      'function* gen()',
      'switch (x)',
      'class A',
      'class A extends B',
      'try',
      'try { a() }\ncatch (e)',
      'try { a() }\nfinally',
    ])
      expect(isIncomplete(code), code).toBe(true)
    for (const code of [
      'db.x.find({ function: 1, class: 2, try: 3 })',
      'function f() { return 1 }',
      'class A {}',
      'class A extends B.C {}',
      'const g = function () {}',
      'do x(); while (y)',
      'do {\n  i++\n} while (i < 3)',
      'x.typeof',
    ])
      expect(isIncomplete(code), code).toBe(false)
  })

  it('takes the spaces and line breaks JavaScript knows for spaces, never for part of a word', () => {
    const nbsp = String.fromCharCode(0xa0)
    const separator = String.fromCharCode(0x2028)
    expect(isIncomplete(`x =${nbsp}`)).toBe(true)
    expect(isIncomplete(`a +${separator}`)).toBe(true)
  })

  it('takes a string that a newline ended as ended (the shell then says what is wrong)', () => {
    expect(isIncomplete("x = 'a\n")).toBe(false)
    expect(isIncomplete('x = /a\n')).toBe(false)
  })
})

describe('shellCommand', () => {
  it('reads a line as mongosh does: never `use(…)`, `use (…)` or a name assigned', () => {
    expect(shellCommand('use shop')).toBe('use')
    expect(shellCommand('  show dbs;')).toBe('show')
    expect(shellCommand('it // more')).toBe('it')
    for (const word of ['exit', 'quit', 'cls']) expect(shellCommand(word)).toBe(word)
    for (const line of ["use('shop')", "use ('shop')", 'showAll()', 'db.use', '', 'x = 1'])
      expect(shellCommand(line), line).toBeNull()
  })
})

describe('CodeScanner', () => {
  it('reads text fed in parts as one text', () => {
    const whole = 'db.x.find({\n  a: `t ${ "}" }`,\n  b: /[{]/,\n})'
    const parts = new CodeScanner()
    for (const line of whole.split(/(?<=\n)/)) parts.feed(line)
    expect(parts.incomplete).toBe(false)
    const half = new CodeScanner().feed('db.x.find({\n  a: `t ${ "}" }`,\n')
    expect(half.incomplete).toBe(true)
    expect(half.topLevel).toBe(false)
  })

  it('says when it is at the top level: nothing open, whatever the last token', () => {
    expect(new CodeScanner().feed('a +\n').topLevel).toBe(true)
    expect(new CodeScanner().feed('f(\n').topLevel).toBe(false)
    expect(new CodeScanner().feed('/* x\n').topLevel).toBe(false)
    expect(new CodeScanner().feed('`x\n').topLevel).toBe(false)
  })

  it('reads a long text in one pass', () => {
    const long = `db.x.insertMany([\n${'  { a: 1, b: "x/y", c: /z/ },\n'.repeat(20_000)}])`
    const start = performance.now()
    expect(isIncomplete(long)).toBe(false)
    expect(performance.now() - start).toBeLessThan(500)
  })
})
