import { describe, expect, it } from 'vitest'
import {
  countOf,
  duplicatePipeline,
  fieldProblem,
  groupFilter,
  idsProjection,
  keysOf,
  splitFields,
  suggestFields,
  valueAt,
} from '../src/duplicates'

describe('the fields picked (plugin tabs redesign §2.4)', () => {
  it('takes field names, never an operator or an odd path', () => {
    expect(fieldProblem('email', [])).toBeNull()
    expect(fieldProblem('address.city', [])).toBeNull()
    for (const bad of ['$where', 'a b', '.a', 'a.', 'a..b', ''])
      expect(fieldProblem(bad, []), bad).toBe('bad')
  })

  it('takes a field once, and five at most', () => {
    expect(fieldProblem('email', ['email'])).toBe('twice')
    expect(fieldProblem('f', ['a', 'b', 'c', 'd', 'e'])).toBe('tooMany')
    expect(fieldProblem('e', ['a', 'b', 'c', 'd'])).toBeNull()
  })

  it('splits what was typed at the commas', () => {
    expect(splitFields(' city, status ,,name ')).toEqual(['city', 'status', 'name'])
    expect(splitFields('  ')).toEqual([])
  })
})

describe('a group’s documents (plugin tabs redesign §2.4)', () => {
  it('reads a count however the server wrote it', () => {
    expect(countOf({ $numberInt: '3' })).toBe(3)
    expect(countOf({ $numberLong: '12' })).toBe(12)
    expect(countOf(4)).toBe(4)
    expect(countOf('x')).toBe(0)
  })

  it('reads the _id and the fields, never a path twice (a parent and its child collide)', () => {
    expect(idsProjection(['email', 'address.city'])).toEqual({ _id: 1, email: 1, 'address.city': 1 })
    expect(idsProjection(['address', 'address.city', 'addressee'])).toEqual({
      _id: 1,
      address: 1,
      addressee: 1,
    })
    expect(idsProjection(['_id', 'a'])).toEqual({ _id: 1, a: 1 })
  })

  it('reads a value by its path, through arrays as the server does', () => {
    const doc = { a: { b: 'x' }, tags: [{ n: 1 }, { n: 2 }], e: null }
    expect(valueAt(doc, 'a.b')).toBe('x')
    expect(valueAt(doc, 'tags.n')).toEqual([1, 2])
    expect(valueAt(doc, 'e')).toBeNull()
    expect(valueAt(doc, 'a.c')).toBeUndefined()
    expect(valueAt(doc, 'missing.x')).toBeUndefined()
  })
})

describe('the duplicate finder (plugins wave 1)', () => {
  it('groups by the fields within the current query, the largest groups first', () => {
    expect(duplicatePipeline(['email'], { ignoreCase: false, skipMissing: false }, {})).toEqual([
      { $group: { _id: { email: '$email' }, count: { $sum: { $numberInt: '1' } } } },
      { $match: { count: { $gt: { $numberInt: '1' } } } },
      { $sort: { count: -1, _id: 1 } },
      // One more than listed: only the 201st tells there are more than 200 (review 2026-10-10).
      { $limit: { $numberInt: '201' } },
    ])
  })

  it('ignores letter case of strings and leaves out documents missing a field, when asked', () => {
    const [match, group] = duplicatePipeline(
      ['name', 'address.city'],
      { ignoreCase: true, skipMissing: true },
      { active: true },
    )
    expect(match).toEqual({
      $match: {
        $and: [
          { active: true },
          { name: { $exists: true, $ne: null } },
          { 'address.city': { $exists: true, $ne: null } },
        ],
      },
    })
    expect(group).toEqual({
      $group: {
        _id: {
          name: { $cond: [{ $eq: [{ $type: '$name' }, 'string'] }, { $toLower: '$name' }, '$name'] },
          address_city: {
            $cond: [
              { $eq: [{ $type: '$address.city' }, 'string'] },
              { $toLower: '$address.city' },
              '$address.city',
            ],
          },
        },
        count: { $sum: { $numberInt: '1' } },
      },
    })
  })

  it('shows a group by its values, each taken as a value (wave 1 review Minor 6)', () => {
    expect(
      groupFilter(
        ['email', 'address.city'],
        { email: 'a@b.c', address_city: { $numberInt: '7' } },
        false,
        {},
      ),
    ).toEqual({
      email: { $eq: 'a@b.c' },
      'address.city': { $eq: { $numberInt: '7' } },
    })
    // A stored document whose keys look like operators stays a value.
    expect(groupFilter(['meta'], { meta: { $where: 'x' } }, false, {})).toEqual({
      meta: { $eq: { $where: 'x' } },
    })
  })

  it('shows a group whose value is missing, or null, as just those documents (review Minor 6)', () => {
    expect(groupFilter(['email'], {}, false, {})).toEqual({ email: { $exists: false } })
    expect(groupFilter(['email'], { email: null }, false, {})).toEqual({ email: { $type: 'null' } })
  })

  it('shows a caseless group by the same folding as the grouping (review Minor 6)', () => {
    const lower = (f: string) => ({
      $cond: [{ $eq: [{ $type: `$${f}` }, 'string'] }, { $toLower: `$${f}` }, `$${f}`],
    })
    expect(groupFilter(['name'], { name: 'ada (x)' }, true, { active: true })).toEqual({
      $and: [{ active: true }, { $expr: { $eq: [lower('name'), { $literal: 'ada (x)' }] } }],
    })
    expect(
      groupFilter(['name', 'city', 'n'], { name: 'ada', city: 'izmir', n: { $numberInt: '1' } }, true, {}),
    ).toEqual({
      n: { $eq: { $numberInt: '1' } },
      $expr: {
        $and: [
          { $eq: [lower('name'), { $literal: 'ada' }] },
          { $eq: [lower('city'), { $literal: 'izmir' }] },
        ],
      },
    })
  })

  it('keeps apart fields whose keys would be the same (review I4)', () => {
    expect(keysOf(['a.b', 'a_b'])).toEqual(['a_b', 'a_b_2'])
    const [group] = duplicatePipeline(['a.b', 'a_b'], { ignoreCase: false, skipMissing: false }, {})
    expect(group).toEqual({
      $group: { _id: { a_b: '$a.b', a_b_2: '$a_b' }, count: { $sum: { $numberInt: '1' } } },
    })
    expect(groupFilter(['a.b', 'a_b'], { a_b: 'x', a_b_2: 'y' }, false, {})).toEqual({
      'a.b': { $eq: 'x' },
      a_b: { $eq: 'y' },
    })
  })

  it('suggests the fields a sample holds, the most common first, nested ones by path', () => {
    expect(
      suggestFields([
        { _id: 1, email: 'a', address: { city: 'x', zip: 'y' } },
        { _id: 2, email: 'b', phone: '1' },
        { _id: 3, email: 'c', address: { city: 'z' } },
      ]),
    ).toEqual(['email', 'address.city', 'address.zip', 'phone'])
  })
})
