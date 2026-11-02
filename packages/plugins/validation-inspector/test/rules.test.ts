import { describe, expect, it } from 'vitest'
import { MAX_RULES, breaking, checkPlan, readCheck, splitValidator } from '../src/rules'

const SCHEMA = {
  $jsonSchema: {
    bsonType: 'object',
    title: 'Customer',
    required: ['name', 'email'],
    properties: {
      name: { bsonType: 'string', description: 'the name' },
      age: { bsonType: 'int', minimum: { $numberInt: '0' } },
      note: { description: 'free text' },
      _id: {},
    },
    additionalProperties: false,
    minProperties: { $numberInt: '2' },
  },
}

describe('a validator split into its rules', () => {
  it("reads a $jsonSchema's required fields, properties, additional properties and other keywords", () => {
    expect(splitValidator(SCHEMA)).toEqual([
      { kind: 'required', name: 'name', detail: null, filter: { $jsonSchema: { required: ['name'] } } },
      { kind: 'required', name: 'email', detail: null, filter: { $jsonSchema: { required: ['email'] } } },
      {
        kind: 'property',
        name: 'name',
        detail: { bsonType: 'string', description: 'the name' },
        filter: { $jsonSchema: { properties: { name: { bsonType: 'string', description: 'the name' } } } },
      },
      {
        kind: 'property',
        name: 'age',
        detail: { bsonType: 'int', minimum: { $numberInt: '0' } },
        filter: { $jsonSchema: { properties: { age: { bsonType: 'int', minimum: { $numberInt: '0' } } } } },
      },
      {
        kind: 'additional',
        name: '',
        detail: { names: ['name', 'age', 'note', '_id'], patterns: [] },
        filter: { $jsonSchema: { properties: SCHEMA.$jsonSchema.properties, additionalProperties: false } },
      },
      {
        kind: 'keyword',
        name: 'minProperties',
        detail: { $numberInt: '2' },
        filter: { $jsonSchema: { minProperties: { $numberInt: '2' } } },
      },
    ])
  })

  it('keeps pattern properties with additional properties, and alone as their own rule', () => {
    const together = { $jsonSchema: { patternProperties: { '^x_': {} }, additionalProperties: false } }
    expect(splitValidator(together)).toEqual([
      {
        kind: 'additional',
        name: '',
        detail: { names: [], patterns: ['^x_'] },
        filter: {
          $jsonSchema: { properties: {}, patternProperties: { '^x_': {} }, additionalProperties: false },
        },
      },
    ])
    const alone = { $jsonSchema: { patternProperties: { '^x_': { bsonType: 'int' } } } }
    expect(splitValidator(alone).map((r) => [r.kind, r.name])).toEqual([['keyword', 'patternProperties']])
    // A list of one object type says no more than the document being one.
    expect(
      splitValidator({ $jsonSchema: { bsonType: ['object'], required: ['a'] } }).map((r) => r.kind),
    ).toEqual(['required'])
    expect(splitValidator({ $jsonSchema: { bsonType: ['object', 'array'] } }).map((r) => r.kind)).toEqual([
      'keyword',
    ])
    // additionalProperties: true allows anything: no rule.
    expect(splitValidator({ $jsonSchema: { additionalProperties: true } })).toEqual([])
  })

  it("reads a query validator's conditions, $and split into its clauses", () => {
    const query = {
      status: { $in: ['a', 'b'] },
      $and: [{ qty: { $gte: { $numberInt: '1' } } }, { $or: [{ a: 1 }, { b: 1 }] }],
      $expr: { $lt: ['$a', '$b'] },
    }
    expect(splitValidator(query)).toEqual([
      {
        kind: 'condition',
        name: 'status',
        detail: { status: { $in: ['a', 'b'] } },
        filter: { status: { $in: ['a', 'b'] } },
      },
      {
        kind: 'condition',
        name: 'qty',
        detail: { qty: { $gte: { $numberInt: '1' } } },
        filter: { qty: { $gte: { $numberInt: '1' } } },
      },
      {
        kind: 'condition',
        name: '',
        detail: { $or: [{ a: 1 }, { b: 1 }] },
        filter: { $or: [{ a: 1 }, { b: 1 }] },
      },
      {
        kind: 'condition',
        name: '',
        detail: { $expr: { $lt: ['$a', '$b'] } },
        filter: { $expr: { $lt: ['$a', '$b'] } },
      },
    ])
  })

  it('reads a validator with both a schema and conditions, and nothing for none', () => {
    const both = { $jsonSchema: { required: ['a'] }, b: { $exists: true } }
    expect(splitValidator(both).map((r) => [r.kind, r.name])).toEqual([
      ['required', 'a'],
      ['condition', 'b'],
    ])
    expect(splitValidator({})).toEqual([])
    // Only names are required fields.
    expect(splitValidator({ $jsonSchema: { required: ['a', 5, null] } }).map((r) => r.name)).toEqual(['a'])
    expect(splitValidator(null)).toEqual([])
    expect(splitValidator([1])).toEqual([])
  })
})

describe('the check', () => {
  it('counts, in one pass over a sample, what was read, what breaks the validator and each rule', () => {
    const plan = checkPlan(SCHEMA, 1000)
    expect(plan.more).toBe(false)
    expect(plan.pipeline[0]).toEqual({ $sample: { size: { $numberInt: '1000' } } })
    const facets = (plan.pipeline[1] as { $facet: Record<string, unknown> }).$facet
    expect(facets.read).toEqual([{ $count: 'n' }])
    expect(facets.broken).toEqual([{ $match: { $nor: [SCHEMA] } }, { $count: 'n' }])
    expect(facets.r0).toEqual([{ $match: breaking(plan.rules[0]!.filter) }, { $count: 'n' }])
    expect(Object.keys(facets)).toHaveLength(2 + plan.rules.length)
    expect(breaking({ a: 1 })).toEqual({ $nor: [{ a: 1 }] })
  })

  it('reads the whole collection without a sample, and counts at most 40 rules', () => {
    expect(checkPlan(SCHEMA, null).pipeline).toHaveLength(1)
    const many = { $jsonSchema: { required: Array.from({ length: MAX_RULES + 5 }, (_, i) => `f${i}`) } }
    const plan = checkPlan(many, null)
    expect(plan.rules).toHaveLength(MAX_RULES)
    expect(plan.more).toBe(true)
  })

  it('reads the answer, the rules most broken first, the order of the validator between equals', () => {
    const plan = checkPlan({ $jsonSchema: { required: ['a', 'b', 'c', 'd'] } }, 10)
    const result = readCheck(plan, [
      {
        read: [{ n: 10 }],
        broken: [{ n: { $numberInt: '4' } }],
        r0: [{ n: 1 }],
        r1: [{ n: { $numberLong: '3' } }],
        r2: [],
        r3: [{ n: 1 }],
      },
    ])
    expect(result.read).toBe(10)
    expect(result.broken).toBe(4)
    expect(result.counts.map((c) => [c.rule.name, c.broken])).toEqual([
      ['b', 3],
      ['a', 1],
      ['d', 1],
      ['c', 0],
    ])
    // An answer not shaped as asked counts nothing.
    expect(readCheck(plan, null)).toMatchObject({ read: 0, broken: 0 })
  })
})
