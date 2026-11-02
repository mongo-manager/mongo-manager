import { describe, expect, it } from 'vitest'
import { AppError } from '../src/errors'
import { compileRules } from '../src/masking/match'
import { Shape } from '../src/masking/gate/shape'
import { newCtx, type GateCtx } from '../src/masking/gate/context'
import { guardValue } from '../src/masking/gate/expression'
import { typeGuard } from '../src/masking/gate/guard'

const masker = compileRules([
  { db: 'crm', coll: 'users', field: 'email' },
  { db: 'crm', coll: 'users', field: 'customer.phone' },
  { db: 'crm', coll: 'users', field: 'items.cardNo' },
])
const deps = { masker, view: async () => null, indexes: async () => [] }
const shape = () => new Shape('crm.users', masker.forNs('crm', 'users').patterns)
const ctx = (over: Partial<GateCtx> = {}): GateCtx => ({ ...newCtx(deps, 'crm'), ...over })

function reason(f: () => unknown): unknown {
  try {
    f()
  } catch (e) {
    return ((e as AppError).details as { reason?: unknown }).reason
  }
  return 'allowed'
}

describe('expressions (phase 3c §3.2)', () => {
  it('refuses every reference to a personal path', () => {
    expect(reason(() => guardValue({ $toUpper: '$email' }, shape(), ctx()))).toBe('personal_field')
    expect(reason(() => guardValue('$items.cardNo', shape(), ctx()))).toBe('personal_field')
  })

  it('guards a reference that may hold personal data, and leaves clean ones alone', () => {
    expect(guardValue({ $size: '$customer' }, shape(), ctx())).toEqual({ $size: typeGuard('$customer') })
    expect(guardValue({ $toUpper: '$name' }, shape(), ctx())).toEqual({ $toUpper: '$name' })
    expect(guardValue({ $objectToArray: '$$ROOT' }, shape(), ctx())).toEqual({
      $objectToArray: typeGuard('$$ROOT'),
    })
  })

  it('resolves iteration variables to the array path', () => {
    expect(reason(() => guardValue({ $map: { input: '$items', in: '$$this.cardNo' } }, shape(), ctx()))).toBe(
      'personal_field',
    )
    // items.qty is clean (only items.cardNo is personal): it is not guarded.
    expect(guardValue({ $map: { input: '$items', as: 'i', in: '$$i.qty' } }, shape(), ctx())).toEqual({
      $map: { input: '$items', as: 'i', in: '$$i.qty' },
    })
    expect(guardValue({ $map: { input: '$items', in: '$$this' } }, shape(), ctx())).toEqual({
      $map: { input: '$items', in: typeGuard('$$this') },
    })
  })

  it('guards what $filter hands out of an array that may hold personal data', () => {
    const out = guardValue({ $filter: { input: '$items', cond: true } }, shape(), ctx()) as Record<
      string,
      unknown
    >
    expect(out).toHaveProperty('$let')
  })

  it('makes $let variables safe by guarding their values', () => {
    expect(guardValue({ $let: { vars: { c: '$customer' }, in: '$$c' } }, shape(), ctx())).toEqual({
      $let: { vars: { c: typeGuard('$customer') }, in: '$$c' },
    })
  })

  it('refuses code, implicit document reads, unknown variables and reserved names', () => {
    expect(reason(() => guardValue({ $function: { body: 'x', args: [], lang: 'js' } }, shape(), ctx()))).toBe(
      'masking_unsupported',
    )
    expect(reason(() => guardValue({ $getField: 'email' }, shape(), ctx()))).toBe('masking_unsupported')
    expect(reason(() => guardValue('$$undeclared', shape(), ctx()))).toBe('masking_unsupported')
    expect(reason(() => guardValue({ $let: { vars: { mm_x: 1 }, in: 1 } }, shape(), ctx()))).toBe(
      'masking_unsupported',
    )
    expect(reason(() => guardValue({ $meta: 'indexKey' }, shape(), ctx()))).toBe('masking_unsupported')
  })

  it('refuses instead of guarding in strict mode (a stored view)', () => {
    expect(reason(() => guardValue({ $size: '$customer' }, shape(), ctx({ strict: true })))).toBe(
      'masking_unsupported',
    )
  })

  it('keeps literals, system variables and $literal as they are', () => {
    expect(guardValue({ $literal: '$email' }, shape(), ctx())).toEqual({ $literal: '$email' })
    expect(guardValue(['$$NOW', 3, 'text'], shape(), ctx())).toEqual(['$$NOW', 3, 'text'])
  })
})
