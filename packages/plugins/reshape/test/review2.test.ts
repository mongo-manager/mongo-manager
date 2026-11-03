import { describe, expect, it } from 'vitest'
import { shapeOf } from '../../kit/src/shape'
import { clashesOf, hiddenGuard, problemOf, stagesOf } from '../src/reshape'

/**
 * Wave 3 second review (2026-10-26): what the reshape fixes still got wrong — a nest merged into an
 * object it said it replaced, a target inside a list of documents set in each of them unsaid, a field
 * nested with one inside it, an already empty object removed by a flatten, a rule below a field the
 * sample met only as a value, an unfinished step called a problem.
 */
describe('nest (second review 14)', () => {
  it('replaces its target with a new object, never merging into one there', () => {
    // A document literal in $set merges into an existing object (and into each document of a
    // list); an expression's result replaces the field.
    expect(stagesOf([{ kind: 'nest', fields: ['lat', 'lng'], into: 'location' }])).toEqual([
      { $set: { location: { $mergeObjects: [{ lat: '$lat', lng: '$lng' }] } } },
      { $unset: ['lat', 'lng'] },
    ])
  })

  it('refuses a field together with one inside it', () => {
    expect(problemOf({ kind: 'nest', fields: ['a', 'a.b'], into: 'x' })).toBe('overlap')
    expect(problemOf({ kind: 'nest', fields: ['a.b', 'a'], into: 'x' })).toBe('overlap')
    expect(problemOf({ kind: 'nest', fields: ['a', 'ab'], into: 'x' })).toBeNull()
  })
})

describe('what a step writes over (second review 14)', () => {
  const shape = shapeOf([{ name: 'Ada', location: { lat: 1 }, items: [{ sku: 'a', qty: 1 }], tag: 'x' }], [])
  it('says a target is replaced, or set in each document of a list it is inside', () => {
    expect(clashesOf({ kind: 'nest', fields: ['name'], into: 'location' }, shape)).toEqual([
      { path: 'location', how: 'replaced' },
    ])
    expect(clashesOf({ kind: 'rename', from: 'name', to: 'items.note' }, shape)).toEqual([
      { path: 'items', how: 'each' },
    ])
    expect(clashesOf({ kind: 'rename', from: 'name', to: 'tag.full' }, shape)).toEqual([
      { path: 'tag', how: 'replaced' },
    ])
    expect(clashesOf({ kind: 'rename', from: 'name', to: 'location.label' }, shape)).toEqual([])
  })
})

describe('flatten (second review 15)', () => {
  it('removes the object only when the move emptied it, never one that was empty before', () => {
    expect(stagesOf([{ kind: 'flatten', path: 'address', keys: ['city', 'zip'], separator: '_' }])).toEqual([
      { $set: { address_city: '$address.city', address_zip: '$address.zip' } },
      {
        $set: {
          address: {
            $cond: [
              { $eq: [{ $type: '$address' }, 'object'] },
              {
                $let: {
                  vars: {
                    rest: {
                      $arrayToObject: {
                        $filter: {
                          input: { $objectToArray: '$address' },
                          cond: { $not: { $in: ['$$this.k', { $literal: ['city', 'zip'] }] } },
                        },
                      },
                    },
                  },
                  in: {
                    $cond: [
                      {
                        $and: [
                          { $eq: ['$$rest', { $literal: {} }] },
                          { $ne: ['$address', { $literal: {} }] },
                        ],
                      },
                      '$$REMOVE',
                      '$$rest',
                    ],
                  },
                },
              },
              '$address',
            ],
          },
        },
      },
    ])
  })
})

describe('a rule below a field the sample met as a value (second review 15)', () => {
  it('counts a rule naming a field below it, not one any field could match', () => {
    const named = [['profile', 'ssn']]
    const g = hiddenGuard(named, shapeOf([{ profile: 'n/a', name: 'Ada' }], named))
    expect(problemOf({ kind: 'rename', from: 'profile', to: 'p' }, g)).toBe('hidden')
    expect(problemOf({ kind: 'rename', from: 'name', to: 'n' }, g)).toBeNull()
    // Third review: a rule reaching it only through * does not hold it back.
    const star = [['*', 'ssn']]
    const s = hiddenGuard(star, shapeOf([{ profile: 'n/a' }], star))
    expect(problemOf({ kind: 'rename', from: 'profile', to: 'p' }, s)).toBeNull()
    // `**` could reach below any field: a value seen as a value is taken as one.
    const deep = [['**', 'phone']]
    const d = hiddenGuard(deep, shapeOf([{ name: 'Ada' }], deep))
    expect(problemOf({ kind: 'rename', from: 'name', to: 'n' }, d)).toBeNull()
  })
})

describe('an unfinished step (second review 15)', () => {
  it('is incomplete, not a problem, until its names are given', () => {
    expect(problemOf({ kind: 'rename', from: 'a', to: '' })).toBe('incomplete')
    expect(problemOf({ kind: 'nest', fields: [], into: '' })).toBe('incomplete')
    expect(problemOf({ kind: 'nest', fields: ['a'], into: '' })).toBe('incomplete')
    expect(problemOf({ kind: 'nest', fields: [], into: 'x' })).toBe('incomplete')
    expect(problemOf({ kind: 'flatten', path: '', keys: [], separator: '_' })).toBe('incomplete')
    expect(problemOf({ kind: 'remove', path: '' })).toBe('incomplete')
    // Once typed, a bad name is a problem.
    expect(problemOf({ kind: 'rename', from: 'a', to: 'b$' })).toBe('name')
    expect(stagesOf([{ kind: 'rename', from: 'a', to: '' }])).toEqual([])
  })
})
