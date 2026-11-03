import { describe, expect, it } from 'vitest'
import { formatSql } from '../src/format'
import { translate } from '../src/translate'

// User request 2026-10-10: "use a beautifier for the SQL here".
describe('formatting SQL', () => {
  it('puts each clause on its line, the columns and the conditions under it, keywords in capitals', () => {
    const sql =
      "select city, count(*) as n from orders o join customers c on o.customerId = c._id where o.status = 'shipped' and o.total >= 100 group by city having count(*) > 2 order by n desc limit 10 offset 5"
    expect(formatSql(sql)).toBe(
      [
        'SELECT',
        '  city,',
        '  COUNT(*) AS n',
        'FROM orders o',
        'JOIN customers c',
        '  ON o.customerId = c._id',
        "WHERE o.status = 'shipped'",
        '  AND o.total >= 100',
        'GROUP BY city',
        'HAVING COUNT(*) > 2',
        'ORDER BY n DESC',
        'LIMIT 10',
        'OFFSET 5',
      ].join('\n'),
    )
  })

  it('keeps one column on the SELECT line, and a LEFT JOIN whole', () => {
    expect(formatSql('SELECT   *   FROM a LEFT   JOIN b ON a.x=b.y')).toBe(
      ['SELECT *', 'FROM a', 'LEFT JOIN b', '  ON a.x = b.y'].join('\n'),
    )
    expect(formatSql('select distinct city , status from orders')).toBe(
      ['SELECT DISTINCT', '  city,', '  status', 'FROM orders'].join('\n'),
    )
  })

  it('keeps BETWEEN … AND, parentheses and lists on one line', () => {
    expect(
      formatSql(
        "select * from t where (a = 1 or b = 2) and n between 1 and 5 and s in ('x','y') or not c like 'a%'",
      ),
    ).toBe(
      [
        'SELECT *',
        'FROM t',
        'WHERE (a = 1 OR b = 2)',
        '  AND n BETWEEN 1 AND 5',
        "  AND s IN ('x', 'y')",
        "  OR NOT c LIKE 'a%'",
      ].join('\n'),
    )
  })

  it('leaves texts, quoted names, numbers and comments exactly as written', () => {
    expect(
      formatSql(
        'select `first name`, "total" from t -- the orders\nwhere note = \'select from where\' and x > -1.5e3 /* keep */ limit 2;',
      ),
    ).toBe(
      [
        'SELECT',
        '  `first name`,',
        '  "total"',
        'FROM t -- the orders',
        "WHERE note = 'select from where'",
        '  AND x > -1.5e3 /* keep */',
        'LIMIT 2;',
      ].join('\n'),
    )
    expect(formatSql("select * from t where a = 'it''s'")).toContain("'it''s'")
  })

  it('never puts code after a line comment, a comma included', () => {
    const sql = ['select a -- the first', ', b from t -- end', ''].join('\n')
    const out = formatSql(sql)!
    expect(out).toBe(['SELECT', '  a -- the first', '  ,', '  b', 'FROM t -- end'].join('\n'))
    expect(translate(out)).toEqual(translate(sql))
  })

  it('never lets a comment swallow a sign (review I1)', () => {
    const sql = ['SELECT * FROM t WHERE x = - -- note', ' 5'].join('\n')
    const out = formatSql(sql)!
    expect(translate(out)).toEqual(translate(sql))
    expect(out).toContain('- -- note')
  })

  it('leaves an OUTER that no JOIN follows as written (review I2)', () => {
    const sql = "SELECT * FROM a LEFT OUTER b ON a.x = b.y WHERE s = 'Ada' AND n > 5"
    const out = formatSql(sql)!
    for (const kept of ["'Ada'", '5', 'a.x', 'b.y', '='].values()) expect(out).toContain(kept)
    expect(out).not.toContain('A.X')
    expect(formatSql(out)).toBe(out)
    expect(formatSql('SELECT * FROM a LEFT OUTER /* c */ JOIN b ON a.x = b.y')).toContain('/* c */')
  })

  it('formats nothing it cannot read to its end', () => {
    expect(formatSql("SELECT * FROM t WHERE a = 'open")).toBeNull()
    expect(formatSql('SELECT * /* open')).toBeNull()
    expect(formatSql('   ')).toBeNull()
  })

  it('never changes what a query means', () => {
    for (const sql of [
      'SELECT name, age FROM people WHERE age > 30 ORDER BY name',
      "select city, count(*) as n from orders where status <> 'x' group by city having count(*) > 1 order by n desc limit 5",
      'SELECT o.orderNo, c.name FROM orders o LEFT JOIN customers c ON o.customerId = c._id WHERE c.name IS NULL',
      "SELECT * FROM t WHERE a BETWEEN 1 AND 3 AND (b = 'x' OR NOT c IN (1, 2)) LIMIT 5, 10",
      'SELECT `my field` FROM `my coll` WHERE x = -2',
      'SELECT DISTINCT status FROM orders',
    ])
      expect(translate(formatSql(sql)!), sql).toEqual(translate(sql))
  })

  it('is the same the second time', () => {
    const once = formatSql("select a, b from t where x = 1 and y = 'z' order by a")!
    expect(formatSql(once)).toBe(once)
  })
})
