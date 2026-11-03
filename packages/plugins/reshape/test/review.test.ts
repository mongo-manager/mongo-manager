import { describe, expect, it } from 'vitest'
import { shapeOf } from '../../kit/src/shape'
import { MAX_STAGES, clashesOf, hiddenGuard, problemOf, stagesOf, type Operation } from '../src/reshape'

/**
 * Wave 3 review (2026-10-26): what the first reshape lost or let through — a hidden field copied
 * where the user sees it, flattened keys the sample missed, nulls made of missing fields, joins that
 * failed a whole pipeline, nested fields overwriting each other.
 */
const DOCS = [
  { _id: 1, name: 'Ada', contact: { phone: '***', city: 'Izmir' }, address: { city: 'X', zip: '1' } },
  { _id: 2, name: 'Grace', contact: { phone: '***', city: 'Ankara' }, address: 'unknown' },
]
const HIDDEN = [['contact', 'phone']]
const guard = hiddenGuard(HIDDEN, shapeOf(DOCS, HIDDEN))

describe('a field hidden from the user (review 23)', () => {
  it('is never read, moved, overwritten or removed by a step, even through the object holding it', () => {
    const refused: Operation[] = [
      { kind: 'flatten', path: 'contact', keys: ['city'], separator: '_' },
      { kind: 'rename', from: 'contact', to: 'info' },
      { kind: 'rename', from: 'contact.phone', to: 'phone' },
      { kind: 'rename', from: 'name', to: 'contact.phone' },
      // Written over whole, the object would lose what the user may not see.
      { kind: 'rename', from: 'name', to: 'contact' },
      { kind: 'nest', fields: ['contact'], into: 'c' },
      { kind: 'remove', path: 'contact' },
      { kind: 'convert', path: 'contact', to: 'string', onError: 'keep' },
      { kind: 'default', path: 'contact.phone', value: 'x', when: 'missing' },
      { kind: 'join', path: 'contact', separator: ',' },
    ]
    for (const op of refused) expect(problemOf(op, guard), JSON.stringify(op)).toBe('hidden')
    // A visible field beside it is still fine.
    expect(problemOf({ kind: 'nest', fields: ['contact.city', 'name'], into: 'c' }, guard)).toBeNull()
    expect(problemOf({ kind: 'rename', from: 'name', to: 'fullName' }, guard)).toBeNull()
    // The stages of the refused steps never name the hidden field.
    expect(JSON.stringify(stagesOf(refused, guard))).not.toMatch(/phone|contact/)
  })

  it('counts a rule on fields the sample did not meet, below an object', () => {
    const rules = [['**', 'phone']]
    const g = hiddenGuard(rules, shapeOf([{ name: 'a', address: { city: 'X' } }], rules))
    // `address.phone` may be in a document the sample missed.
    expect(problemOf({ kind: 'rename', from: 'address', to: 'where' }, g)).toBe('hidden')
    // A string holds no field below it.
    expect(problemOf({ kind: 'rename', from: 'name', to: 'fullName' }, g)).toBeNull()
  })
})

describe('flatten (review 24)', () => {
  it('moves the keys chosen, leaves others in place, and never loses a value that is not an object', () => {
    expect(stagesOf([{ kind: 'flatten', path: 'address', keys: ['city', 'zip'], separator: '_' }])).toEqual([
      { $set: { address_city: '$address.city', address_zip: '$address.zip' } },
      expect.anything(),
    ])
    // Only the keys moved leave the object; a value that is no object stays as it is.
    const kept = JSON.stringify(stagesOf([{ kind: 'flatten', path: 'a', keys: ['b'], separator: '-' }])[1])
    expect(kept).toContain('{"$literal":["b"]}')
    expect(kept).toContain('{"$eq":[{"$type":"$a"},"object"]}')
  })

  it('refuses a separator or a name holding . or $', () => {
    for (const separator of ['.', '$', 'a.b', '_$'])
      expect(problemOf({ kind: 'flatten', path: 'address', keys: ['city'], separator })).toBe('separator')
    expect(problemOf({ kind: 'flatten', path: 'address', keys: ['ci$ty'], separator: '_' })).toBe('name')
    expect(problemOf({ kind: 'rename', from: 'a', to: 'b$c' })).toBe('name')
    expect(problemOf({ kind: 'nest', fields: ['a'], into: 'x$' })).toBe('name')
    // A split's or join's separator is a value: any text.
    expect(problemOf({ kind: 'split', path: 'v', separator: '.' })).toBeNull()
    expect(problemOf({ kind: 'join', path: 'v', separator: ' $ ' })).toBeNull()
  })
})

describe('convert (review 25)', () => {
  it('leaves a missing field missing and a null null', () => {
    expect(stagesOf([{ kind: 'convert', path: 'price', to: 'decimal', onError: 'null' }])).toEqual([
      {
        $set: {
          price: {
            $cond: [
              { $eq: [{ $type: '$price' }, 'missing'] },
              '$$REMOVE',
              { $convert: { input: '$price', to: 'decimal', onError: null, onNull: null } },
            ],
          },
        },
      },
    ])
  })
})

describe('join (review 26)', () => {
  it('joins any element without failing, counting elements rather than reading the text so far', () => {
    expect(stagesOf([{ kind: 'join', path: 'tags', separator: ', ' }])).toEqual([
      {
        $set: {
          tags: {
            $cond: [
              { $isArray: '$tags' },
              {
                $let: {
                  vars: {
                    joined: {
                      $reduce: {
                        input: '$tags',
                        initialValue: { text: '', count: 0 },
                        in: {
                          text: {
                            $concat: [
                              '$$value.text',
                              { $cond: [{ $eq: ['$$value.count', 0] }, '', { $literal: ', ' }] },
                              { $convert: { input: '$$this', to: 'string', onError: '', onNull: '' } },
                            ],
                          },
                          count: { $add: ['$$value.count', 1] },
                        },
                      },
                    },
                  },
                  in: '$$joined.text',
                },
              },
              '$tags',
            ],
          },
        },
      },
    ])
  })
})

describe('nest (review 27)', () => {
  it('refuses two fields of the same last name, one of which would be lost', () => {
    expect(problemOf({ kind: 'nest', fields: ['a.name', 'b.name'], into: 'x' })).toBe('duplicate')
    expect(problemOf({ kind: 'nest', fields: ['a.name', 'b.title'], into: 'x' })).toBeNull()
  })
})

describe('default (review 30)', () => {
  it('fills a missing field only, or a missing or null one when chosen', () => {
    expect(stagesOf([{ kind: 'default', path: 'country', value: 'TR', when: 'missing' }])).toEqual([
      {
        $set: {
          country: {
            $cond: [{ $eq: [{ $type: '$country' }, 'missing'] }, { $literal: 'TR' }, '$country'],
          },
        },
      },
    ])
    expect(stagesOf([{ kind: 'default', path: 'country', value: 'TR', when: 'missingOrNull' }])).toEqual([
      { $set: { country: { $ifNull: ['$country', { $literal: 'TR' }] } } },
    ])
  })
})

describe('what a step would overwrite (review 30)', () => {
  const shape = shapeOf(
    [{ fullName: 'Ada', name: 'Ada', address: { city: 'X' }, address_city: 'Y', location: { lat: 1 } }],
    [],
  )
  it('names an existing field a step writes over, or a value that is not an object it writes into', () => {
    const replaced = (path: string) => [{ path, how: 'replaced' }]
    expect(clashesOf({ kind: 'rename', from: 'name', to: 'fullName' }, shape)).toEqual(replaced('fullName'))
    expect(clashesOf({ kind: 'rename', from: 'fullName', to: 'name.full' }, shape)).toEqual(replaced('name'))
    expect(clashesOf({ kind: 'rename', from: 'fullName', to: 'address.full' }, shape)).toEqual([])
    // Replaced indeed: a nest's object is an expression's result (second review 14).
    expect(clashesOf({ kind: 'nest', fields: ['name'], into: 'location' }, shape)).toEqual(
      replaced('location'),
    )
    expect(clashesOf({ kind: 'flatten', path: 'address', keys: ['city'], separator: '_' }, shape)).toEqual(
      replaced('address_city'),
    )
    expect(clashesOf({ kind: 'remove', path: 'name' }, shape)).toEqual([])
  })

  it('caps the stages one preview and one hand-off may hold', () => {
    expect(MAX_STAGES).toBe(48)
  })
})
