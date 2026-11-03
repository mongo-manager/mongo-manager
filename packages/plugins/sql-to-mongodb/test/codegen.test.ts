import { describe, expect, it } from 'vitest'
import { code, LANGUAGES } from '../src/codegen'
import { canonical, translate } from '../src/translate'

const findModel = translate(
  "SELECT name FROM users WHERE name LIKE 'A%' AND age >= 18 ORDER BY age DESC LIMIT 5 OFFSET 10",
)
const aggModel = translate('SELECT city, COUNT(*) AS n FROM users GROUP BY city')

describe('driver code from a translated query', () => {
  it('writes the reported query with its value as text (user report 2026-10-10)', () => {
    expect(code(translate('SELECT * FROM orders WHERE status = "shipped" LIMIT 20'), 'mongosh')).toBe(
      'db.getCollection("orders").find({ status: "shipped" }).limit(20)',
    )
  })

  it('writes mongosh with a regex literal and the cursor chain', () => {
    expect(code(findModel, 'mongosh')).toBe(
      String.raw`db.getCollection("users").find(` +
        '\n' +
        String.raw`  { name: /^A[\s\S]*\z/, age: { $gte: 18 } },` +
        '\n  { name: 1, _id: 0 }\n).sort({ age: -1 }).skip(10).limit(5)',
    )
    expect(code(aggModel, 'mongosh')).toBe(
      'db.getCollection("users").aggregate([\n  { $group: { _id: { city: "$city" }, n: { $sum: 1 } } },\n  { $project: { _id: 0, city: "$_id.city", n: "$n" } }\n])',
    )
  })

  it('writes a whole program for each driver, through the app’s own generator (wave 2)', () => {
    const node = code(findModel, 'node', 'shop')
    expect(node).toContain('client.db("shop").collection("users")')
    expect(node).toContain(String.raw`name: new BSONRegExp("^A[\\s\\S]*\\z", "")`)
    expect(node).toContain('age: { $gte: 18 }')
    expect(node).toContain('sort: { age: -1 }')
    expect(node).toContain('skip: 10')
    expect(node).toContain('limit: 5')
    expect(node).toContain('process.env.MONGODB_URI')
    expect(code(findModel, 'python')).toContain('sort=[("age", -1)]')
    expect(code(findModel, 'java')).toContain('.sort(new Document("age", -1))')
    expect(code(findModel, 'csharp')).toContain('.Sort(new BsonDocument { { "age", -1 } })')
    expect(code(findModel, 'go')).toContain('SetSort(bson.D{{Key: "age", Value: int32(-1)}})')
    expect(code(findModel, 'rust')).toContain('.sort(doc! { "age": (-1_i32) })')
    expect(code(aggModel, 'php')).toContain('$coll->aggregate($pipeline)')
    for (const lang of LANGUAGES) expect(code(aggModel, lang).length, lang).toBeGreaterThan(20)
  })

  it('writes Python values as Python', () => {
    const m = translate('SELECT * FROM t WHERE a = TRUE AND b IS NULL AND c = FALSE')
    expect(code(m, 'python')).toContain('{"a": True, "b": None, "c": False}')
  })

  it('escapes what a string literal needs in every language', () => {
    const m = translate(`SELECT * FROM t WHERE note = 'say "hi" \\ there'`)
    for (const lang of LANGUAGES) {
      const text = code(m, lang)
      expect(text, lang).not.toContain('"say "hi"')
    }
  })
})

describe('the query as the app takes it', () => {
  it('turns numbers and patterns into canonical Extended JSON', () => {
    expect(
      canonical({ a: 1, b: 1.5, c: 2 ** 40, d: { $regex: '^x', $options: 'i' }, e: [1, 'x'], f: null }),
    ).toEqual({
      a: { $numberInt: '1' },
      b: { $numberDouble: '1.5' },
      c: { $numberLong: String(2 ** 40) },
      d: { $regularExpression: { pattern: '^x', options: 'i' } },
      e: [{ $numberInt: '1' }, 'x'],
      f: null,
    })
  })
})
