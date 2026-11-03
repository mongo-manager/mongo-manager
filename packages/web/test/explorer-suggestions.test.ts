import { describe, expect, it } from 'vitest'
import type { FieldStats, SchemaAnalysis } from '@mongo-manager/shared/browser'
import { filterSuggestions, recentSuggestions } from '../src/documents/suggestions'

// W1 (completion §2): suggestion chips under the composer, from a schema sample.
const field = (path: string, over: Partial<FieldStats> = {}): FieldStats => ({
  path,
  keys: path.split('.'),
  count: 100,
  types: { string: 100 },
  ...over,
})
const sample = (fields: FieldStats[]): SchemaAnalysis => ({ sampled: 100, fields, truncated: false })
const none = () => false

describe('filterSuggestions', () => {
  it('offers the common value of a categorical field, and sparse fields as "exists"', () => {
    const out = filterSuggestions(
      sample([
        field('_id', { types: { objectId: 100 } }),
        field('status', {
          top: [
            { value: 'paid', count: 60, type: 'string' },
            { value: 'open', count: 40, type: 'string' },
          ],
        }),
        field('active', { types: { bool: 100 }, top: [{ value: 'true', count: 90, type: 'bool' }] }),
        field('coupon', { count: 20 }),
      ]),
      none,
      [],
    )
    expect(out.map((s) => [s.label, s.condition])).toEqual([
      ['active = true', { active: true }],
      ['status = "paid"', { status: 'paid' }],
      ['coupon exists', { coupon: { $exists: true } }],
    ])
  })

  it('never offers a hidden field, by the server’s mark or the rules here', () => {
    const out = filterSuggestions(
      sample([
        field('email', { masked: true }),
        field('ssn', { top: [{ value: '123', count: 9, type: 'string' }] }),
        field('tier', { top: [{ value: 'gold', count: 9, type: 'string' }] }),
      ]),
      (p) => p[0] === 'ssn',
      [],
    )
    expect(out.map((s) => s.field)).toEqual(['tier'])
  })

  it('skips values seen once, cut values, ids, array elements, odd names and fields already filtered', () => {
    const out = filterSuggestions(
      sample([
        field('once', { top: [{ value: 'x', count: 1, type: 'string' }] }),
        field('long', { top: [{ value: 'y'.repeat(100), count: 5, type: 'string', cut: true }] }),
        field('ref', {
          types: { objectId: 50, string: 50 },
          top: [{ value: 'a'.repeat(24), count: 5, type: 'objectId' }],
        }),
        {
          path: 'tags[]',
          keys: ['tags', null],
          count: 300,
          types: { string: 300 },
          top: [{ value: 't', count: 50, type: 'string' }],
        },
        field('$weird', { top: [{ value: 'w', count: 9, type: 'string' }] }),
        field('status', { top: [{ value: 'paid', count: 9, type: 'string' }] }),
      ]),
      none,
      ['status'],
    )
    expect(out).toEqual([])
  })

  it('offers at most six', () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      field(`f${i}`, { top: [{ value: 'v', count: 5 + i, type: 'string' }] }),
    )
    expect(filterSuggestions(sample(many), none, [])).toHaveLength(6)
  })
})

// W1 review (minor 13): the conditions used lately on the collection, from its query history.
describe('recentSuggestions', () => {
  const history = (filter: Record<string, unknown>) => ({ type: 'history', body: { filter } }) as never
  it('offers the plain top-level conditions run lately, newest first, once each', () => {
    const out = recentSuggestions(
      [
        history({ status: 'open', qty: { $gt: { $numberInt: '5' } } }),
        history({ status: 'open' }),
        history({ $or: [{ a: 1 }], 'a.b': { $numberInt: '1' }, tags: ['x'] }),
        history({ at: { $date: '2026-01-02T00:00:00Z' } }),
      ],
      none,
      [],
    )
    expect(out.map((s) => s.label)).toEqual(['status = "open"', 'qty > 5', 'a.b = 1'])
    expect(out[1]!.field).toBe('qty')
  })

  it('never offers a hidden field nor one already filtered', () => {
    const out = recentSuggestions(
      [history({ email: 'a@b.c', status: 'open', tier: 'gold' })],
      (p) => p[0] === 'email',
      ['tier'],
    )
    expect(out.map((s) => s.field)).toEqual(['status'])
  })
})
