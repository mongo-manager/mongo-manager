import { describe, expect, it } from 'vitest'
import { problemOf, stagesOf, type Operation } from '../src/reshape'

/**
 * Plugins wave 3 (spec §6, Studio 3T's Reschema): operations on fields made into aggregation stages
 * ($set and $unset only), never touching the source; names a field may have only.
 */
describe('the stages of an operation', () => {
  it('renames, moving a field into or out of an object', () => {
    expect(stagesOf([{ kind: 'rename', from: 'fullName', to: 'name.full' }])).toEqual([
      { $set: { 'name.full': '$fullName' } },
      { $unset: 'fullName' },
    ])
  })

  it('flattens an object’s fields to its level, with a prefix', () => {
    expect(stagesOf([{ kind: 'flatten', path: 'address', keys: ['city', 'zip'], separator: '_' }])).toEqual([
      { $set: { address_city: '$address.city', address_zip: '$address.zip' } },
      // The moved keys leave the object, which goes only when the move emptied it (second review).
      expect.objectContaining({ $set: { address: expect.objectContaining({ $cond: expect.any(Array) }) } }),
    ])
  })

  it('nests fields into a new object', () => {
    expect(stagesOf([{ kind: 'nest', fields: ['lat', 'lng'], into: 'location' }])).toEqual([
      // An expression's result replaces the target (second review 14).
      { $set: { location: { $mergeObjects: [{ lat: '$lat', lng: '$lng' }] } } },
      { $unset: ['lat', 'lng'] },
    ])
  })

  it('converts a type, a value that cannot be made null or kept', () => {
    const convert = (path: string, onError: unknown, to: string) => ({
      $cond: [
        { $eq: [{ $type: `$${path}` }, 'missing'] },
        '$$REMOVE',
        { $convert: { input: `$${path}`, to, onError, onNull: null } },
      ],
    })
    expect(stagesOf([{ kind: 'convert', path: 'price', to: 'decimal', onError: 'null' }])).toEqual([
      { $set: { price: convert('price', null, 'decimal') } },
    ])
    expect(stagesOf([{ kind: 'convert', path: 'at', to: 'date', onError: 'keep' }])).toEqual([
      { $set: { at: convert('at', '$at', 'date') } },
    ])
  })

  it('removes, sets a default where missing, splits and joins', () => {
    expect(stagesOf([{ kind: 'remove', path: 'legacy' }])).toEqual([{ $unset: 'legacy' }])
    expect(stagesOf([{ kind: 'default', path: 'country', value: 'TR', when: 'missingOrNull' }])).toEqual([
      { $set: { country: { $ifNull: ['$country', { $literal: 'TR' }] } } },
    ])
    expect(stagesOf([{ kind: 'split', path: 'tags', separator: ',' }])).toEqual([
      {
        $set: {
          tags: {
            $cond: [
              { $eq: [{ $type: '$tags' }, 'string'] },
              { $split: ['$tags', { $literal: ',' }] },
              '$tags',
            ],
          },
        },
      },
    ])
    // A separator is a value, never read as a field ($…).
    expect(JSON.stringify(stagesOf([{ kind: 'split', path: 't', separator: '$x' }]))).toContain(
      '{"$literal":"$x"}',
    )
    const join = stagesOf([{ kind: 'join', path: 'tags', separator: ', ' }])[0] as {
      $set: { tags: { $cond: unknown[] } }
    }
    expect(join.$set.tags.$cond[0]).toEqual({ $isArray: '$tags' })
  })

  it('puts the operations in order, a literal default never read as a path or an operator', () => {
    const ops: Operation[] = [
      { kind: 'rename', from: 'a', to: 'b' },
      { kind: 'default', path: 'c', value: '$secret', when: 'missingOrNull' },
      { kind: 'remove', path: 'd' },
    ]
    expect(stagesOf(ops)).toEqual([
      { $set: { b: '$a' } },
      { $unset: 'a' },
      { $set: { c: { $ifNull: ['$c', { $literal: '$secret' }] } } },
      { $unset: 'd' },
    ])
  })
})

describe('what an operation may not do', () => {
  it('refuses names a field may not have, and operations that undo themselves', () => {
    const bad = (op: Operation) => problemOf(op)
    // Not given yet: unfinished, not wrong (second review).
    expect(bad({ kind: 'rename', from: 'a', to: '' })).toBe('incomplete')
    expect(bad({ kind: 'rename', from: 'a', to: '$where' })).toBe('name')
    expect(bad({ kind: 'rename', from: 'a', to: 'x..y' })).toBe('name')
    expect(bad({ kind: 'rename', from: 'a', to: 'x.$y' })).toBe('name')
    expect(bad({ kind: 'rename', from: '_id', to: 'id' })).toBe('id')
    expect(bad({ kind: 'remove', path: '_id' })).toBe('id')
    expect(bad({ kind: 'rename', from: 'a', to: 'a' })).toBe('same')
    expect(bad({ kind: 'rename', from: 'a', to: 'a.b' })).toBe('same')
    expect(bad({ kind: 'nest', fields: [], into: 'x' })).toBe('incomplete')
    expect(bad({ kind: 'nest', fields: ['x'], into: 'x' })).toBe('same')
    expect(bad({ kind: 'split', path: 'tags', separator: '' })).toBe('separator')
    expect(bad({ kind: 'flatten', path: 'address', keys: [], separator: '_' })).toBe('empty')
    expect(bad({ kind: 'rename', from: 'a', to: 'b.c' })).toBeNull()
  })
})
