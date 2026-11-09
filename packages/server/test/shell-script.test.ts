// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { labelOf, splitScript } from '../src/shell/worker/script'

/**
 * User report 2026-10-12: an aggregation pasted after `use shop` never ran — mongosh reads the first
 * word of what it is given as a shell command and the rest as its words. Review 2026-10-12 (I1): a
 * cut by how the next line starts broke valid code (`db.orders.` and `find()` on the next line). The
 * worker cuts a script as mongosh runs it: each shell command on its own, the JavaScript between them
 * by its parser into statements — those on one line together, as one line is one input to mongosh.
 */
describe('splitScript', () => {
  it('runs a shell command apart from the code after it', () => {
    expect(splitScript('use shop\ndb.orders.find()')).toEqual(['use shop', 'db.orders.find()'])
    expect(splitScript('show dbs\nshow collections')).toEqual(['show dbs', 'show collections'])
    expect(splitScript('db.a.find()\nit')).toEqual(['db.a.find()', 'it'])
    expect(splitScript('use shop;\n  it // more')).toEqual(['use shop;', 'it // more'])
  })

  it('keeps a statement of many lines whole, its comments with it', () => {
    const pipeline = [
      'db.orders.aggregate([',
      '  // paid ones',
      "  { $match: { status: 'paid' } },",
      '  { $group: { _id: null, n: { $sum: 1 } } },',
      '])',
    ].join('\n')
    expect(splitScript(`use shop\n\n${pipeline}`)).toEqual(['use shop', pipeline])
  })

  it('runs each statement on a line of its own, as mongosh runs each line', () => {
    expect(splitScript('db.a.countDocuments()\ndb.b.countDocuments()')).toEqual([
      'db.a.countDocuments()',
      'db.b.countDocuments()',
    ])
    expect(splitScript('const p = [\n  { $match: {} },\n]\ndb.x.aggregate(p)')).toEqual([
      'const p = [\n  { $match: {} },\n]',
      'db.x.aggregate(p)',
    ])
    // Statements on one line are one input, as typed in mongosh.
    expect(splitScript('const a = 1; a + 1\nprint(a)')).toEqual(['const a = 1; a + 1', 'print(a)'])
  })

  it('keeps together what the language keeps together, wherever its lines break', () => {
    for (const code of [
      'db.orders.\n  find().\n  limit(3)',
      'db.orders\n  .find({})\n  .limit(3)',
      'const total = a +\n  b',
      'if (x)\n  print(1)',
      'if (x) {\n  a()\n}\nelse {\n  b()\n}',
      'try {\n  a()\n}\ncatch (e) {}\nfinally {}',
      'const f = x =>\n  x * 2',
      'const p =\n  [1]',
      'function f()\n{\n  return 1\n}',
      'outer:\nfor (const a of xs)\n  for (const b of a) continue outer',
      'for (const it of xs)\n  print(it)',
      'do {\n  i++\n} while (i < 3)',
      'x\n  ? 1\n  : 2',
    ])
      expect(splitScript(code), code).toEqual([code])
  })

  it('never takes a command from inside a string, a template, a comment or an open statement', () => {
    for (const code of [
      'const t = `\nuse shop\n`',
      '/*\nshow dbs\n*/\ndb.x.find()',
      'db.x.find({\nuse: 1 })',
      'const a = 1 +\nit',
      "const s = 'a\\\nuse shop'",
    ])
      expect(splitScript(code), code).toEqual([code])
  })

  it('reads a command as mongosh does: never `use(…)`, `use (…)` or a name assigned', () => {
    expect(splitScript("x\nuse('shop')")).toEqual(['x', "use('shop')"])
    expect(splitScript('show (x)\n  .length')).toEqual(['show (x)\n  .length'])
    expect(splitScript('show dbs\n  .length')).toEqual(['show dbs', '.length'])
  })

  it('reads a regular expression and a template as the language does', () => {
    expect(splitScript('db.links.find({ url: /^https?:\\/\\// })\nshow dbs')).toEqual([
      'db.links.find({ url: /^https?:\\/\\// })',
      'show dbs',
    ])
    expect(splitScript('print(`a ${ "`" } b`)\nprint(2)')).toEqual(['print(`a ${ "`" } b`)', 'print(2)'])
  })

  it('leaves out blank lines and comments with no code', () => {
    expect(splitScript('')).toEqual([])
    expect(splitScript('  \n\n')).toEqual([])
    expect(splitScript('// just a note')).toEqual([])
    expect(splitScript('/* a\n   note */')).toEqual([])
    expect(splitScript('// the report\ndb.x.find()')).toEqual(['// the report\ndb.x.find()'])
    expect(splitScript('db.x.find()\n// done')).toEqual(['db.x.find()'])
  })

  it('keeps code that does not parse whole: mongosh then says what is wrong', () => {
    expect(splitScript('db.x.find({')).toEqual(['db.x.find({'])
    expect(splitScript('use shop\na b c\nd()')).toEqual(['use shop', 'a b c\nd()'])
  })

  // Second review 2026-10-12 (minor 9): a comment ending a line went to the next piece, and named it.
  it('keeps a comment ending a line with its statement', () => {
    expect(splitScript('db.a.find() // note\ndb.b.find()')).toEqual(['db.a.find() // note', 'db.b.find()'])
    expect(splitScript('db.a.find() /* note */\ndb.b.find()')).toEqual([
      'db.a.find() /* note */',
      'db.b.find()',
    ])
  })

  it('names a piece by its code, the comments before it left out', () => {
    expect(labelOf('// the report\n/* more */\n  db.x.find()')).toBe('db.x.find()')
    expect(labelOf('db.x.find()')).toBe('db.x.find()')
    expect(labelOf('// only a note')).toBe('// only a note')
  })

  // Second review 2026-10-12 (minor 10): a helper declared at the end was not known above it.
  it('runs the functions a stretch declares first, as a script hoists them', () => {
    expect(splitScript('total()\nfunction total() {\n  return 1\n}\nprint(2)')).toEqual([
      'function total() {\n  return 1\n}',
      'total()',
      'print(2)',
    ])
  })

  // Second review 2026-10-12 (minor 11): `use x; db.y.find()` switched to a database named "x;"
  // and dropped the query (the confusion of the user's report).
  it('runs what follows a shell command after a `;` on its line as code of its own', () => {
    expect(splitScript('use shop; db.orders.find()')).toEqual(['use shop', 'db.orders.find()'])
    expect(splitScript('show dbs; // all of them')).toEqual(['show dbs'])
    expect(splitScript("use shop;\nprint('x')")).toEqual(['use shop;', "print('x')"])
  })

  it('cuts a large script in one pass', () => {
    const long = `db.x.insertMany([\n${'  { a: 1, b: "x/y", c: /z/ },\n'.repeat(20_000)}])\nprint(1)`
    const start = performance.now()
    expect(splitScript(long)).toHaveLength(2)
    expect(performance.now() - start).toBeLessThan(2000)
  })
})
