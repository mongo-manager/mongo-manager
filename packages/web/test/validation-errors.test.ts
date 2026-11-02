import { afterEach, describe, expect, it } from 'vitest'
import { ApiError } from '../src/api/client'
import { describeError } from '../src/api/errors'
import { i18n } from '../src/i18n'

/**
 * Research 2026-10-28 (SERVER-20547): a write the validator refused said only "Document failed
 * validation". The server now names the rules it did not meet; the sentence says them.
 */
const t = (key: string, values?: Record<string, unknown>) => i18n.global.t(key, values ?? {})
const refused = (problems: unknown[], extra: Record<string, unknown> = {}) =>
  new ApiError(400, 'MONGO_ERROR', 'Document failed validation', {
    code: 121,
    codeName: 'DocumentValidationFailure',
    problems,
    more: false,
    ...extra,
  })

afterEach(() => {
  i18n.global.locale.value = 'en'
})

describe('a write the validator refused', () => {
  it('names each rule: required, not allowed, type, choices, and the rest with what it asked for', () => {
    i18n.global.locale.value = 'en'
    expect(
      describeError(
        refused([
          { path: 'name', rule: 'required' },
          { path: 'nick', rule: 'additionalProperties' },
          { path: 'gpa', rule: 'bsonType', expected: '["double"]', found: 'string' },
          { path: 'status', rule: 'enum', expected: '["a","b"]' },
          { path: 'age', rule: 'minimum', expected: '0' },
        ]),
        t,
      ),
    ).toBe(
      "The document does not pass the collection's validation: name is required; nick is not allowed; " +
        'gpa must be of type double, not string; status must be one of ["a","b"]; age: minimum 0.',
    )
  })

  it("says the schema's own description of a field when it has one", () => {
    expect(
      describeError(refused([{ path: 'age', rule: 'minimum', expected: '0', description: '0 or more' }]), t),
    ).toBe("The document does not pass the collection's validation: age: 0 or more (minimum 0).")
  })

  it('names the whole document for a rule on no field, and a rule with nothing more to say', () => {
    expect(
      describeError(
        refused([
          { path: '', rule: '$expr', expected: '{"$lt":["$a","$b"]}' },
          { path: 'x', rule: 'minItems' },
        ]),
        t,
      ),
    ).toBe(
      'The document does not pass the collection\'s validation: the document: $expr {"$lt":["$a","$b"]}; x: minItems.',
    )
  })

  // Final review: rules said as they are meant — alternatives with "or", what must not match,
  // a dependency's condition, the reason when nothing else is known, a description with its rule.
  it('says alternatives, negations, dependencies and query operators as they are meant', () => {
    expect(
      describeError(
        refused([
          { path: 'a', rule: '$type', expected: '"string"', found: 'int', group: 1 },
          { path: 'a', rule: '$gt', expected: '5', group: 1 },
          { path: 'status', rule: '$not', expected: '{"$eq":"banned"}' },
          { path: 'zip', rule: 'required', when: 'card' },
          { path: 'x', rule: 'not', reason: 'child expression matched' },
          { path: 'y', rule: 'oneOf', reason: 'more than one subschema matched' },
        ]),
        t,
      ),
    ).toBe(
      "The document does not pass the collection's validation: a must be of type string, not int or a: $gt 5; " +
        'status must not match {"$eq":"banned"}; zip is required (when card is there); ' +
        'x matches a schema it must not match; y matches more than one of its allowed schemas.',
    )
    expect(
      describeError(
        refused([
          { path: 'n', rule: '$in', expected: '[1,2]' },
          { path: 'n', rule: '$nin', expected: '[3]' },
          { path: 'k', rule: '$nor', expected: '1' },
          { path: 'y', rule: 'oneOf', reason: 'more than one subschema matched' },
          { path: 'z', rule: 'uniqueItems', reason: 'found a duplicate item' },
          { path: 'w', rule: 'minimum', expected: '0', description: 'zero or more. ' },
        ]),
        t,
      ),
    ).toBe(
      "The document does not pass the collection's validation: n must be one of [1,2]; n must not be one of [3]; " +
        'k must not match 1; y matches more than one of its allowed schemas; z: uniqueItems (found a duplicate item); and 1 more.',
    )
  })

  it('counts the alternatives of one rule as one, says a description with its rule, and says it in Turkish', () => {
    const grouped = Array.from({ length: 6 }, (_, i) => ({ path: `f${i}`, rule: 'required', group: 1 }))
    expect(describeError(refused(grouped), t)).not.toMatch(/more/)
    expect(
      describeError(
        refused([{ path: 'w', rule: 'minimum', expected: '0', description: 'zero or more. ' }]),
        t,
      ),
    ).toBe("The document does not pass the collection's validation: w: zero or more (minimum 0).")
    i18n.global.locale.value = 'tr'
    expect(
      describeError(
        refused([
          { path: 'a', rule: 'required', group: 2 },
          { path: 'b', rule: 'required', group: 2 },
          { path: 'zip', rule: 'required', when: 'card' },
          { path: 's', rule: '$not', expected: '1' },
          { path: 'x', rule: 'not' },
          { path: 'y', rule: 'oneOf' },
        ]),
        t,
      ),
    ).toBe(
      'Belge koleksiyonun doğrulama kurallarına uymuyor: a zorunlu ya da b zorunlu; zip zorunlu (card varken); ' +
        's şuna uymamalı: 1; x uymaması gereken bir şemaya uyuyor; y izin verilen şemalardan birden fazlasına uyuyor.',
    )
  })

  it('lists five, then says how many more, also when the server listed only some', () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ path: `f${i}`, rule: 'required' }))
    expect(describeError(refused(many), t)).toMatch(/f4 is required; and 2 more\.$/)
    // The server stopped counting: how many more is not known.
    expect(describeError(refused(many, { more: true }), t)).toMatch(/f4 is required; and more\.$/)
    expect(describeError(refused(many.slice(0, 5), { more: true }), t)).toMatch(/f4 is required; and more\.$/)
  })

  it('says it in Turkish', () => {
    i18n.global.locale.value = 'tr'
    expect(
      describeError(
        refused([
          { path: 'name', rule: 'required' },
          { path: 'gpa', rule: 'bsonType', expected: '"int"', found: 'string' },
          { path: '', rule: '$expr' },
        ]),
        t,
      ),
    ).toBe(
      'Belge koleksiyonun doğrulama kurallarına uymuyor: name zorunlu; gpa int türünde olmalı, string değil; belge: $expr.',
    )
  })

  it('says the rules to a restricted user too, whose details are hidden', () => {
    expect(
      describeError(refused([{ path: 'email', rule: 'pattern' }], { hidden: true, codeName: null }), t),
    ).toBe("The document does not pass the collection's validation: email: pattern.")
  })

  it('is said as before with no problems, or problems not shaped as the server sends them', () => {
    const bare = new ApiError(400, 'MONGO_ERROR', 'Document failed validation', { code: 121 })
    expect(describeError(bare, t)).toBe('MongoDB: Document failed validation')
    expect(describeError(refused([]), t)).toBe('MongoDB: Document failed validation')
    expect(describeError(refused(['x', { rule: 5 }, null]), t)).toBe('MongoDB: Document failed validation')
    // Problems only on a MongoDB refusal: another error's details are not read as rules.
    expect(
      describeError(
        new ApiError(400, 'VALIDATION_ERROR', 'x', { problems: [{ path: 'a', rule: 'required' }] }),
        t,
      ),
    ).toBe('Please check the entered values.')
  })

  it('takes an empty value as none', () => {
    expect(describeError(refused([{ path: 'x', rule: 'minimum', expected: '', description: '' }]), t)).toBe(
      "The document does not pass the collection's validation: x: minimum.",
    )
  })
})
