import { describe, expect, it } from 'vitest'
import type { AppError } from '../src/errors'
import { toAppError, writeRefusal } from '../src/data/mongo-errors'
import { forRestricted } from '../src/masking/errors'
import { namesOnly, validationProblems, validationSummary } from '../src/data/validation-errors'

/**
 * A write the collection's validator refuses (code 121): MongoDB says why in errInfo.details, which
 * the app used to drop — only "Document failed validation" reached the page. The value that failed
 * is never passed on (it can be personal data); the rule, the field and what was expected are.
 */
const S = 'S3NT1N3L'
const mongo = (props: Record<string, unknown>) =>
  Object.assign(new Error(String(props.message)), { name: 'MongoServerError', ...props })

// The shapes below are MongoDB's own (docs: "Schema Validation", detailed error output).
const SCHEMA = {
  operatorName: '$jsonSchema',
  title: 'Student',
  schemaRulesNotSatisfied: [
    {
      operatorName: 'properties',
      propertiesNotSatisfied: [
        {
          propertyName: 'gpa',
          description: 'must be a double',
          details: [
            {
              operatorName: 'bsonType',
              specifiedAs: { bsonType: ['double'] },
              reason: 'type did not match',
              consideredValue: S,
              consideredType: 'string',
            },
          ],
        },
        {
          propertyName: 'address',
          details: [
            {
              operatorName: 'properties',
              propertiesNotSatisfied: [
                {
                  propertyName: 'zip',
                  details: [
                    {
                      operatorName: 'minLength',
                      specifiedAs: { minLength: 5 },
                      reason: 'specified string length was not satisfied',
                      consideredValue: S.slice(0, 3),
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    { operatorName: 'required', specifiedAs: { required: ['name', 'year'] }, missingProperties: ['year'] },
    {
      operatorName: 'additionalProperties',
      specifiedAs: { additionalProperties: false },
      additionalProperties: ['nick'],
    },
  ],
}

describe('the problems a validator names', () => {
  it('lists each failed rule with its field, nested fields as dotted paths', () => {
    expect(validationProblems({ details: SCHEMA })).toEqual({
      problems: [
        {
          path: 'gpa',
          rule: 'bsonType',
          reason: 'type did not match',
          expected: '["double"]',
          found: 'string',
          description: 'must be a double',
        },
        {
          path: 'address.zip',
          rule: 'minLength',
          reason: 'specified string length was not satisfied',
          expected: '5',
        },
        { path: 'year', rule: 'required' },
        { path: 'nick', rule: 'additionalProperties', schemaPath: '' },
      ],
      more: false,
    })
  })

  it('never passes on the value that failed', () => {
    expect(JSON.stringify(validationProblems({ details: SCHEMA }))).not.toContain(S.slice(0, 3))
  })

  it('names the item of an array that failed', () => {
    const items = {
      operatorName: '$jsonSchema',
      schemaRulesNotSatisfied: [
        {
          operatorName: 'properties',
          propertiesNotSatisfied: [
            {
              propertyName: 'tags',
              details: [
                {
                  operatorName: 'items',
                  reason: 'At least one item did not match the sub-schema',
                  itemIndex: 2,
                  details: [
                    {
                      operatorName: 'bsonType',
                      specifiedAs: { bsonType: 'string' },
                      reason: 'type did not match',
                      consideredValue: 7,
                      consideredType: 'int',
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }
    expect(validationProblems({ details: items })?.problems).toEqual([
      { path: 'tags.2', rule: 'bsonType', reason: 'type did not match', expected: '"string"', found: 'int' },
    ])
  })

  it('reads a query validator: each clause that failed, its field taken from the rule', () => {
    const query = {
      operatorName: '$and',
      clausesNotSatisfied: [
        {
          index: 0,
          details: {
            operatorName: '$gte',
            specifiedAs: { age: { $gte: 18 } },
            reason: 'comparison failed',
            consideredValue: 3,
          },
        },
        {
          index: 1,
          details: {
            operatorName: '$eq',
            specifiedAs: { status: 'active' },
            reason: 'comparison failed',
            consideredValue: S,
          },
        },
        {
          index: 2,
          details: {
            operatorName: '$expr',
            specifiedAs: { $expr: { $lt: ['$a', '$b'] } },
            reason: 'expression did not match',
            expressionResult: false,
          },
        },
      ],
    }
    expect(validationProblems({ details: query })?.problems).toEqual([
      { path: 'age', rule: '$gte', reason: 'comparison failed', expected: '18' },
      { path: 'status', rule: '$eq', reason: 'comparison failed', expected: '"active"' },
      { path: '', rule: '$expr', reason: 'expression did not match', expected: '{"$lt":["$a","$b"]}' },
    ])
  })

  it('reads the schemas an anyOf found unmet as one group: one of them met is enough', () => {
    const any = {
      operatorName: '$jsonSchema',
      schemaRulesNotSatisfied: [
        {
          operatorName: 'anyOf',
          schemasNotSatisfied: [
            { index: 0, details: [{ operatorName: 'required', missingProperties: ['email'] }] },
            { index: 1, details: [{ operatorName: 'required', missingProperties: ['phone'] }] },
          ],
        },
        { operatorName: 'required', missingProperties: ['name'] },
      ],
    }
    expect(validationProblems({ details: any })?.problems).toEqual([
      { path: 'email', rule: 'required', group: 1 },
      { path: 'phone', rule: 'required', group: 1 },
      { path: 'name', rule: 'required' },
    ])
  })

  // Final review: the shapes below are what MongoDB 8 answered (probed against a real server).
  const prop = (name: string, details: unknown[]) => ({
    operatorName: '$jsonSchema',
    schemaRulesNotSatisfied: [
      { operatorName: 'properties', propertiesNotSatisfied: [{ propertyName: name, details }] },
    ],
  })

  it('says what a $not, a $nor or a schema not matched, never the rule under it as if required', () => {
    const not = {
      operatorName: '$not',
      details: {
        operatorName: '$eq',
        specifiedAs: { status: { $eq: 'banned' } },
        reason: 'comparison succeeded',
        consideredValue: S,
      },
    }
    expect(validationProblems({ details: not })?.problems).toEqual([
      { path: 'status', rule: '$not', expected: '{"$eq":"banned"}' },
    ])
    const nor = {
      operatorName: '$nor',
      clausesSatisfied: [
        {
          index: 0,
          details: {
            operatorName: '$eq',
            specifiedAs: { a: 1 },
            reason: 'comparison succeeded',
            consideredValue: 1,
          },
        },
      ],
    }
    expect(validationProblems({ details: nor })?.problems).toEqual([
      { path: 'a', rule: '$nor', expected: '1' },
    ])
    const schemaNot = prop('x', [{ operatorName: 'not', reason: 'child expression matched' }])
    expect(validationProblems({ details: schemaNot })?.problems).toEqual([
      { path: 'x', rule: 'not', reason: 'child expression matched' },
    ])
  })

  it('groups the clauses of an $or, and says a oneOf matched by several as such', () => {
    const or = {
      operatorName: '$or',
      clausesNotSatisfied: [
        {
          index: 0,
          details: {
            operatorName: '$type',
            specifiedAs: { a: { $type: 'string' } },
            reason: 'type did not match',
            consideredValue: 1,
            consideredType: 'int',
          },
        },
        {
          index: 1,
          details: {
            operatorName: '$gt',
            specifiedAs: { a: { $gt: 5 } },
            reason: 'comparison failed',
            consideredValue: 1,
          },
        },
      ],
    }
    expect(validationProblems({ details: or })?.problems).toEqual([
      {
        path: 'a',
        rule: '$type',
        reason: 'type did not match',
        expected: '"string"',
        found: 'int',
        group: 1,
      },
      { path: 'a', rule: '$gt', reason: 'comparison failed', expected: '5', group: 1 },
    ])
    const many = prop('x', [
      { operatorName: 'oneOf', reason: 'more than one subschema matched', matchingSchemaIndexes: [0, 1] },
    ])
    expect(validationProblems({ details: many })?.problems).toEqual([
      { path: 'x', rule: 'oneOf', reason: 'more than one subschema matched' },
    ])
    // allOf: every one of them is needed, so no group.
    const all = prop('x', [
      {
        operatorName: 'allOf',
        schemasNotSatisfied: [
          {
            index: 1,
            details: [
              {
                operatorName: 'maximum',
                specifiedAs: { maximum: 10 },
                reason: 'comparison failed',
                consideredValue: 50,
              },
            ],
          },
        ],
      },
    ])
    expect(validationProblems({ details: all })?.problems).toEqual([
      { path: 'x', rule: 'maximum', reason: 'comparison failed', expected: '10' },
    ])
  })

  it("names a pattern's and an additional property's key, telling which part the schema names", () => {
    const pattern = {
      operatorName: '$jsonSchema',
      schemaRulesNotSatisfied: [
        {
          operatorName: 'patternProperties',
          details: [
            {
              propertyName: 'n_a',
              regexMatched: '^n_',
              details: [
                {
                  operatorName: 'bsonType',
                  specifiedAs: { bsonType: 'int' },
                  reason: 'type did not match',
                  consideredValue: S,
                  consideredType: 'string',
                },
              ],
            },
          ],
        },
        {
          operatorName: 'additionalProperties',
          reason: 'at least one additional property did not match the subschema',
          failingProperty: 'b',
          details: [
            {
              operatorName: 'bsonType',
              specifiedAs: { bsonType: 'int' },
              reason: 'type did not match',
              consideredValue: S,
              consideredType: 'string',
            },
          ],
        },
      ],
    }
    expect(validationProblems({ details: pattern })?.problems).toEqual([
      {
        path: 'n_a',
        rule: 'bsonType',
        reason: 'type did not match',
        expected: '"int"',
        found: 'string',
        schemaPath: '',
      },
      {
        path: 'b',
        rule: 'bsonType',
        reason: 'type did not match',
        expected: '"int"',
        found: 'string',
        schemaPath: '',
      },
    ])
    // Under a property the schema names, that part is kept.
    const nested = prop('o', [
      {
        operatorName: 'additionalProperties',
        specifiedAs: { additionalProperties: false },
        additionalProperties: ['k'],
      },
    ])
    expect(validationProblems({ details: nested })?.problems).toEqual([
      { path: 'o.k', rule: 'additionalProperties', schemaPath: 'o' },
    ])
  })

  it("reads a dependency's missing fields and its subschema, saying while which field it applies", () => {
    const deps = {
      operatorName: '$jsonSchema',
      schemaRulesNotSatisfied: [
        {
          operatorName: 'dependencies',
          failingDependencies: [
            { conditionalProperty: 'card', missingProperties: ['address'] },
            {
              conditionalProperty: 'iban',
              details: [
                { operatorName: 'required', specifiedAs: { required: ['zip'] }, missingProperties: ['zip'] },
              ],
            },
          ],
        },
      ],
    }
    expect(validationProblems({ details: deps })?.problems).toEqual([
      { path: 'address', rule: 'required', when: 'card' },
      { path: 'zip', rule: 'required', when: 'iban' },
    ])
  })

  it("gives a property's description to its own rules, not to its items'", () => {
    const tags = {
      operatorName: '$jsonSchema',
      schemaRulesNotSatisfied: [
        {
          operatorName: 'properties',
          propertiesNotSatisfied: [
            {
              propertyName: 'tags',
              description: 'the tags',
              details: [
                {
                  operatorName: 'items',
                  itemIndex: 0,
                  details: [{ operatorName: 'bsonType', specifiedAs: { bsonType: 'string' }, reason: 'r' }],
                },
                { operatorName: 'minItems', specifiedAs: { minItems: 2 }, reason: 'r' },
              ],
            },
          ],
        },
      ],
    }
    expect(validationProblems({ details: tags })?.problems).toEqual([
      { path: 'tags.0', rule: 'bsonType', reason: 'r', expected: '"string"' },
      { path: 'tags', rule: 'minItems', reason: 'r', expected: '2', description: 'the tags' },
    ])
  })

  it('reads only what the rule itself specifies, never an inherited property', () => {
    const spec = Object.create({ minimum: 99 }) as Record<string, unknown>
    const inherited = prop('a', [{ operatorName: 'minimum', specifiedAs: spec, reason: 'r' }])
    expect(validationProblems({ details: inherited })?.problems).toEqual([
      { path: 'a', rule: 'minimum', reason: 'r' },
    ])
  })

  it('stops at 20 problems and says there are more', () => {
    const many = {
      operatorName: '$jsonSchema',
      schemaRulesNotSatisfied: [
        { operatorName: 'required', missingProperties: Array.from({ length: 30 }, (_, i) => `f${i}`) },
      ],
    }
    const found = validationProblems({ details: many })!
    expect(found.problems).toHaveLength(20)
    expect(found.more).toBe(true)
  })

  it('caps long text and survives nesting far deeper than any schema', () => {
    let deep: Record<string, unknown> = { operatorName: 'minimum', reason: 'comparison failed' }
    for (let i = 0; i < 500; i++)
      deep = {
        operatorName: 'properties',
        propertiesNotSatisfied: [{ propertyName: 'p', details: [deep] }],
      }
    expect(() => validationProblems({ details: deep })).not.toThrow()
    // Read no deeper than 32 levels: the rule at the bottom is not reached.
    expect(validationProblems({ details: deep })!.problems.map((p) => p.rule)).toEqual(['properties'])
    // A path built of many names is capped too, not only each name.
    const nested = (names: string[]): Record<string, unknown> =>
      names.length === 0
        ? { operatorName: 'minimum', reason: 'r' }
        : {
            operatorName: 'properties',
            propertiesNotSatisfied: [{ propertyName: names[0], details: [nested(names.slice(1))] }],
          }
    const [path] = validationProblems({ details: nested(['a'.repeat(150), 'b'.repeat(150)]) })!.problems
    expect(path!.path).toHaveLength(200)
    const long = {
      operatorName: 'properties',
      propertiesNotSatisfied: [
        {
          propertyName: 'x'.repeat(1000),
          description: 'd'.repeat(1000),
          details: [{ operatorName: 'enum', specifiedAs: { enum: ['y'.repeat(1000)] }, reason: 'r' }],
        },
      ],
    }
    const [one] = validationProblems({ details: long })!.problems
    expect(one!.path.length).toBeLessThanOrEqual(200)
    expect(one!.description!.length).toBeLessThanOrEqual(200)
    expect(one!.expected!.length).toBeLessThanOrEqual(120)
  })

  it('takes no field name from a rule specified on several fields or on an operator', () => {
    const odd = {
      operatorName: '$and',
      clausesNotSatisfied: [
        { details: { operatorName: '$eq', specifiedAs: { a: 1, b: 2 }, reason: 'r' } },
        { details: { operatorName: '$size', specifiedAs: { $comment: 'x' }, reason: 'r' } },
      ],
    }
    expect(validationProblems({ details: odd })?.problems).toEqual([
      { path: '', rule: '$eq', reason: 'r' },
      { path: '', rule: '$size', reason: 'r' },
    ])
  })

  it('names only the fields given as names, and no field for a required rule naming none', () => {
    const odd = {
      operatorName: '$jsonSchema',
      schemaRulesNotSatisfied: [
        { operatorName: 'required', missingProperties: ['a', 5, null, { b: 1 }] },
        { operatorName: 'required', specifiedAs: { required: ['c'] } },
        { operatorName: 'additionalProperties', specifiedAs: { additionalProperties: false } },
      ],
    }
    expect(validationProblems({ details: odd })?.problems).toEqual([{ path: 'a', rule: 'required' }])
  })

  it('gives nothing for an answer with no details, or details not shaped as MongoDB writes them', () => {
    expect(validationProblems(undefined)).toBeNull()
    expect(validationProblems({})).toBeNull()
    expect(validationProblems({ details: 'text' })).toBeNull()
    expect(validationProblems({ details: { schemaRulesNotSatisfied: 'x', operatorName: 5 } })).toBeNull()
  })
})

describe('a refused write answered with its problems', () => {
  const refused = (extra: Record<string, unknown> = {}) =>
    mongo({
      code: 121,
      codeName: 'DocumentValidationFailure',
      message: 'Document failed validation',
      errInfo: { failingDocumentId: S, details: SCHEMA },
      ...extra,
    })

  it('carries the problems in the details, never the failing document id or value', () => {
    const e = toAppError(refused()) as AppError
    expect([e.statusCode, e.code]).toEqual([400, 'MONGO_ERROR'])
    expect(e.details).toMatchObject({ code: 121, codeName: 'DocumentValidationFailure', more: false })
    expect((e.details as { problems: unknown[] }).problems).toHaveLength(4)
    expect(JSON.stringify(e.toBody())).not.toContain(S.slice(0, 3))
  })

  it('reads them from a bulk write too (insertMany)', () => {
    const bulk = mongo({
      name: 'MongoBulkWriteError',
      code: 121,
      message: 'Document failed validation',
      writeErrors: [
        { err: { code: 121, errmsg: 'Document failed validation', errInfo: { details: SCHEMA } } },
      ],
    })
    expect(((toAppError(bulk) as AppError).details as { problems: unknown[] }).problems).toHaveLength(4)
  })

  it('keeps the field and the rule for a restricted user, not what was expected or described', () => {
    const shown = forRestricted(toAppError(refused()) as AppError)
    expect(shown.details).toMatchObject({ code: 121, hidden: true, more: false })
    expect((shown.details as { problems: unknown[] }).problems).toEqual([
      { path: 'gpa', rule: 'bsonType', reason: 'type did not match', found: 'string' },
      { path: 'address.zip', rule: 'minLength', reason: 'specified string length was not satisfied' },
      { path: 'year', rule: 'required' },
      { path: '', rule: 'additionalProperties' },
    ])
    expect(JSON.stringify(shown.toBody())).not.toContain(S.slice(0, 3))
  })

  it('answers a refusal with no details as before', () => {
    const e = toAppError(mongo({ code: 121, message: 'Document failed validation' })) as AppError
    expect(e.message).toBe('Document failed validation')
    expect(e.details).toEqual({ code: 121, codeName: undefined })
  })
})

describe("a job report's summary of the rules", () => {
  it('names five rules with what they asked for, or the field and rule alone, then says there are more', () => {
    expect(validationSummary({ details: SCHEMA })).toBe(
      'gpa: bsonType ["double"]; address.zip: minLength 5; year: required; nick: additionalProperties',
    )
    expect(validationSummary({ details: SCHEMA }, true)).toBe(
      'gpa bsonType; address.zip minLength; year required; document additionalProperties',
    )
    const many = {
      operatorName: '$jsonSchema',
      schemaRulesNotSatisfied: [
        { operatorName: 'required', missingProperties: ['a', 'b', 'c', 'd', 'e', 'f'] },
      ],
    }
    expect(validationSummary({ details: many })).toBe(
      'a: required; b: required; c: required; d: required; e: required; …',
    )
    expect(validationSummary({})).toBeNull()
    const whole = { operatorName: '$expr', specifiedAs: { $expr: false }, reason: 'expression did not match' }
    expect(validationSummary({ details: whole })).toBe('document: $expr false')
    expect(validationSummary({ details: whole }, true)).toBe('document $expr')
  })
})

describe('a job report’s summary, review fixes', () => {
  it('joins the alternatives of one rule with "or", and says while which field a dependency applies', () => {
    const details = {
      operatorName: '$jsonSchema',
      schemaRulesNotSatisfied: [
        {
          operatorName: 'anyOf',
          schemasNotSatisfied: [
            { index: 0, details: [{ operatorName: 'required', missingProperties: ['email'] }] },
            { index: 1, details: [{ operatorName: 'required', missingProperties: ['phone'] }] },
          ],
        },
        {
          operatorName: 'dependencies',
          failingDependencies: [{ conditionalProperty: 'card', missingProperties: ['zip'] }],
        },
      ],
    }
    expect(validationSummary({ details })).toBe(
      'email: required or phone: required; zip: required (when card is there)',
    )
  })

  it('stays short: a long rule ends the summary with "…", whole rules before it', () => {
    const long = (name: string) => ({
      operatorName: 'properties',
      propertiesNotSatisfied: [
        {
          propertyName: name,
          details: [{ operatorName: 'enum', specifiedAs: { enum: ['v'.repeat(200)] }, reason: 'r' }],
        },
      ],
    })
    const summary = validationSummary({
      details: { operatorName: '$jsonSchema', schemaRulesNotSatisfied: [long('a'), long('b'), long('c')] },
    })!
    expect(summary.length).toBeLessThanOrEqual(310)
    expect(summary.endsWith('; …')).toBe(true)
    expect(summary.split('; ')).toHaveLength(3)
  })

  it('reads a bulk write whose one error the driver gives as itself, not in a list', () => {
    const bulk = mongo({
      name: 'MongoBulkWriteError',
      code: 121,
      message: 'Document failed validation',
      writeErrors: { err: { code: 121, errInfo: { details: SCHEMA } } },
    })
    expect(((toAppError(bulk) as AppError).details as { problems: unknown[] }).problems).toHaveLength(4)
    const dup = mongo({
      name: 'MongoBulkWriteError',
      code: 11000,
      message: 'E11000',
      writeErrors: {
        err: { errmsg: 'E11000 index: email_1 dup key: { email: 1 }', keyPattern: { email: 1 } },
      },
    })
    expect((toAppError(dup) as AppError).details).toMatchObject({ index: 'email_1' })
  })

  it('cuts nothing in the middle of a report reason, and keeps its closing text', () => {
    const many = {
      operatorName: '$jsonSchema',
      schemaRulesNotSatisfied: Array.from({ length: 8 }, (_, i) => ({
        operatorName: 'properties',
        propertiesNotSatisfied: [
          {
            propertyName: `f${i}`,
            details: [{ operatorName: 'enum', specifiedAs: { enum: ['v'.repeat(90)] }, reason: 'r' }],
          },
        ],
      })),
    }
    const refused = mongo({ code: 121, message: 'Document failed validation', errInfo: { details: many } })
    expect(writeRefusal(refused, true)).toMatch(/^MongoDB refused the write \(code 121: f0 enum; .*\)$/)
    const open = writeRefusal(refused, false)
    expect(open.endsWith('; …')).toBe(true)
    expect(open.length).toBeLessThanOrEqual(500)
  })
})

describe('the walker, review fixes (mutation checks)', () => {
  it('says the whole condition a $not matched when it names no single field', () => {
    const not = {
      operatorName: '$not',
      details: { operatorName: '$and', specifiedAs: { a: 1, b: 2 }, reason: 'r' },
    }
    expect(validationProblems({ details: not })?.problems).toEqual([
      { path: '', rule: '$not', expected: '{"a":1,"b":2}' },
    ])
  })

  it("keeps the schema's part of a path once a document's key is in it", () => {
    const pattern = {
      operatorName: '$jsonSchema',
      schemaRulesNotSatisfied: [
        {
          operatorName: 'patternProperties',
          details: [
            {
              propertyName: 'n_a',
              regexMatched: '^n_',
              details: [
                {
                  operatorName: 'properties',
                  propertiesNotSatisfied: [
                    { propertyName: 'z', details: [{ operatorName: 'minimum', reason: 'r' }] },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }
    expect(validationProblems({ details: pattern })?.problems).toEqual([
      { path: 'n_a.z', rule: 'minimum', reason: 'r', schemaPath: '' },
    ])
  })

  it("gives a property's description to its own rules, not to an allOf's", () => {
    const all = {
      operatorName: 'properties',
      propertiesNotSatisfied: [
        {
          propertyName: 'x',
          description: 'd',
          details: [
            {
              operatorName: 'allOf',
              schemasNotSatisfied: [{ index: 0, details: [{ operatorName: 'maximum', reason: 'r' }] }],
            },
          ],
        },
      ],
    }
    expect(validationProblems({ details: all })?.problems).toEqual([
      { path: 'x', rule: 'maximum', reason: 'r' },
    ])
  })

  it('reads nothing under a schema not matched', () => {
    const not = {
      operatorName: 'not',
      reason: 'child expression matched',
      details: [
        { operatorName: 'bsonType', specifiedAs: { bsonType: 'string' }, reason: 'type did not match' },
      ],
    }
    expect(validationProblems({ details: not })?.problems).toEqual([
      { path: '', rule: 'not', reason: 'child expression matched' },
    ])
  })

  it("keeps a restricted user's alternatives together and a dependency's condition", () => {
    expect(
      namesOnly([
        { path: 'a', rule: 'required', group: 3, expected: 'x' },
        { path: 'b', rule: 'required', when: 'card', description: 'd' },
      ]),
    ).toEqual([
      { path: 'a', rule: 'required', group: 3 },
      { path: 'b', rule: 'required', when: 'card' },
    ])
  })
})
