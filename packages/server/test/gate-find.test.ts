import { describe, expect, it } from 'vitest'
import { AppError } from '../src/errors'
import { compileRules } from '../src/masking/match'
import { guardAggregate, guardCount, guardFind, type GateDeps } from '../src/masking/gate'

const masker = compileRules([
  { db: 'crm', coll: 'users', field: 'email' },
  { db: 'crm', coll: 'users', field: 'customer.phone' },
])
const deps: GateDeps = {
  masker,
  view: async () => null,
  indexes: async () => [
    { name: 'email_1', key: { email: 1 } },
    { name: 'name_1', key: { name: 1 } },
    { name: 'name_partial', key: { name: 1 }, partialFilterExpression: { email: { $exists: true } } },
    { name: 'customer_1', key: { customer: 1 } },
  ],
}
async function reason(p: Promise<unknown>): Promise<unknown> {
  try {
    await p
  } catch (e) {
    return ((e as AppError).details as { reason?: unknown }).reason
  }
  return 'allowed'
}

describe('find, count and hints (phase 3c §3.7)', () => {
  it('refuses a sort on a personal field and hints that order or count by one', async () => {
    expect(await reason(guardFind('crm', 'users', { filter: {}, sort: { email: 1 } }, deps))).toBe(
      'personal_field',
    )
    for (const hint of ['email_1', { email: 1 }, 'name_partial', 'customer_1'])
      expect(await reason(guardFind('crm', 'users', { filter: {}, hint }, deps))).toBe('personal_field')
    expect(await reason(guardFind('crm', 'users', { filter: {}, hint: 'name_1' }, deps))).toBe('allowed')
    expect(await reason(guardFind('crm', 'users', { filter: {}, hint: { $natural: 1 } }, deps))).toBe(
      'allowed',
    )
    expect(await reason(guardCount('crm', 'users', {}, 'email_1', deps))).toBe('personal_field')
  })

  it('refuses a response ordered by a sub-document, and removes the sort paths it added', async () => {
    const g = await guardFind(
      'crm',
      'users',
      { filter: {}, sort: { customer: 1 }, projection: { name: 1 } },
      deps,
    )
    expect(g.projection).toEqual({ name: 1, customer: 1 })
    expect(() => g.finish([{ name: 'a', customer: { phone: '1' } }])).toThrow(AppError)
    expect(g.finish([{ name: 'a', customer: 'plain' }])).toEqual([{ name: 'a' }])
  })

  it('keeps a projection that names personal fields (names are not values)', async () => {
    const g = await guardFind('crm', 'users', { filter: {}, projection: { email: 1, name: 1 } }, deps)
    expect(g.projection).toEqual({ email: 1, name: 1 })
    expect(g.output.matches(['email'])).toBe(true)
  })

  it('guards an aggregation and reports its output masker', async () => {
    const g = await guardAggregate('crm', 'users', [{ $project: { c: '$customer' } }], deps)
    expect(g.output.matches(['c', 'phone'])).toBe(true)
    // A $sort by _id comes first where rules apply (ninth review of explain masking): it is before
    // the user's first stage, so that stage ends one later.
    expect(g.ends).toEqual([2])
  })
})
