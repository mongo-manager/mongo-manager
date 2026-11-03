import { describe, expect, it } from 'vitest'
import type { Document } from 'mongodb'
import { AppError } from '../src/errors'
import { compileRules } from '../src/masking/match'
import { newCtx, type GateDeps } from '../src/masking/gate/context'
import { guardStages, sourceShape } from '../src/masking/gate/pipeline'
import { typeGuard } from '../src/masking/gate/guard'

/**
 * W5 (completion §2 W5.2): $setWindowFields, $fill, $densify and $redact for restricted users,
 * allowed only where the gate can prove them safe, with their abuse cases.
 */
const masker = compileRules([
  { db: 'hr', coll: 'staff', field: 'email' },
  { db: 'hr', coll: 'staff', field: 'salary' },
  { db: 'hr', coll: 'staff', field: 'customer.phone' },
  { db: 'hr', coll: 'wild', field: '**.phone' },
])
const deps: GateDeps = { masker, view: async () => null, indexes: async () => [] }
async function guard(coll: string, stages: Document[]) {
  const gc = newCtx(deps, 'hr')
  const shape = await sourceShape('hr', coll, gc)
  const out = await guardStages(stages, shape, gc)
  return { ...out, output: shape.output(), nonce: gc.nonce }
}
async function reason(p: Promise<unknown>): Promise<unknown> {
  try {
    await p
  } catch (e) {
    if (!(e instanceof AppError)) throw e
    return (e.details as { reason?: unknown } | undefined)?.reason ?? e.code
  }
  return 'allowed'
}

describe('$setWindowFields for restricted users', () => {
  it('runs window functions over clean fields unchanged', async () => {
    const stage = {
      $setWindowFields: {
        partitionBy: '$dept',
        sortBy: { hired: 1 },
        output: {
          total: { $sum: '$hours', window: { documents: ['unbounded', 'current'] } },
          rank: { $rank: {} },
          moving: { $avg: '$hours', window: { range: [-7, 0], unit: 'day' } },
        },
      },
    }
    const { stages } = await guard('staff', [stage])
    expect(stages).toEqual([stage])
  })

  it('refuses a window function over a masked field', async () => {
    for (const op of ['$sum', '$avg', '$max', '$min', '$push', '$first', '$locf', '$addToSet'])
      expect(
        await reason(guard('staff', [{ $setWindowFields: { output: { x: { [op]: '$salary' } } } }])),
        op,
      ).toBe('personal_field')
    expect(
      await reason(
        guard('staff', [
          { $setWindowFields: { output: { x: { $shift: { output: '$email', by: -1, default: null } } } } },
        ]),
      ),
    ).toBe('personal_field')
    expect(
      await reason(
        guard('staff', [
          { $setWindowFields: { output: { x: { $derivative: { input: '$salary', unit: 'day' } } } } },
        ]),
      ),
    ).toBe('personal_field')
    expect(
      await reason(
        guard('staff', [{ $setWindowFields: { output: { x: { $covariancePop: ['$hours', '$salary'] } } } }]),
      ),
    ).toBe('personal_field')
  })

  it('refuses partitioning or sorting by a masked field', async () => {
    expect(
      await reason(
        guard('staff', [{ $setWindowFields: { partitionBy: '$email', output: { n: { $count: {} } } } }]),
      ),
    ).toBe('personal_field')
    expect(
      await reason(
        guard('staff', [{ $setWindowFields: { sortBy: { salary: -1 }, output: { r: { $rank: {} } } } }]),
      ),
    ).toBe('personal_field')
    expect(
      await reason(
        guard('staff', [
          { $setWindowFields: { sortBy: { 'salary.base': 1 }, output: { r: { $rank: {} } } } },
        ]),
      ),
    ).toBe('personal_field')
  })

  it('guards values, partitions and sort keys that may hold personal data', async () => {
    const { stages, nonce } = await guard('staff', [
      {
        $setWindowFields: {
          partitionBy: '$customer',
          sortBy: { customer: 1 },
          output: { n: { $addToSet: '$customer' }, c: { $count: {} } },
        },
      },
    ])
    const tmp = `__mm_w0_${nonce}`
    expect(stages).toEqual([
      { $addFields: { [tmp]: typeGuard('$customer') } },
      {
        $setWindowFields: {
          partitionBy: typeGuard('$customer'),
          sortBy: { [tmp]: 1 },
          output: { n: { $addToSet: typeGuard('$customer') }, c: { $count: {} } },
        },
      },
      { $unset: [tmp] },
    ])
  })

  it('re-roots values a window moves, so later stages and the output stay masked', async () => {
    const { output } = await guard('staff', [
      { $setWindowFields: { output: { prev: { $push: '$customer', window: { documents: [-1, 0] } } } } },
    ])
    expect(output.matches(['prev', 'phone'])).toBe(true)
    expect(
      await reason(
        guard('staff', [
          { $setWindowFields: { output: { prev: { $first: '$customer' } } } },
          { $match: { 'prev.phone': 'x' } },
        ]),
      ),
    ).toBe('personal_field')
  })

  it('refuses unknown keys, malformed windows and server-side code', async () => {
    expect(await reason(guard('staff', [{ $setWindowFields: { output: {}, extra: 1 } }]))).toBe(
      'masking_unsupported',
    )
    expect(await reason(guard('staff', [{ $setWindowFields: 'x' }]))).toBe('VALIDATION_ERROR')
    expect(await reason(guard('staff', [{ $setWindowFields: { output: { x: 1 } } }]))).toBe(
      'VALIDATION_ERROR',
    )
    for (const window of [
      { documents: ['$salary', 0] },
      { range: [{ $literal: 1 }, 0] },
      { documents: [0] },
      { unit: 'day', other: 1 },
      'x',
    ])
      expect(
        await reason(guard('staff', [{ $setWindowFields: { output: { x: { $sum: '$hours', window } } } }])),
        JSON.stringify(window),
      ).toBe('masking_unsupported')
    expect(
      await reason(
        guard('staff', [
          { $setWindowFields: { output: { x: { $function: { body: 'x', args: [], lang: 'js' } } } } },
        ]),
      ),
    ).toBe('masking_unsupported')
    expect(
      await reason(
        guard('staff', [
          { $setWindowFields: { sortBy: { hired: { $meta: 'x' } }, output: { r: { $rank: {} } } } },
        ]),
      ),
    ).toBe('masking_unsupported')
  })
})

describe('$fill for restricted users', () => {
  it('fills clean fields unchanged', async () => {
    const stage = {
      $fill: {
        partitionByFields: ['dept'],
        sortBy: { hired: 1 },
        output: { hours: { method: 'linear' }, dept: { value: 'none' }, note: { method: 'locf' } },
      },
    }
    expect((await guard('staff', [stage])).stages).toEqual([stage])
  })

  it('refuses filling a masked path in any way', async () => {
    for (const spec of [{ method: 'locf' }, { method: 'linear' }, { value: 0 }])
      expect(
        await reason(guard('staff', [{ $fill: { sortBy: { hired: 1 }, output: { salary: spec } } }])),
        JSON.stringify(spec),
      ).toBe('personal_field')
    expect(await reason(guard('staff', [{ $fill: { output: { 'customer.phone': { value: 'x' } } } }]))).toBe(
      'personal_field',
    )
  })

  it('refuses a fill value, sort or partition that reads a masked field', async () => {
    expect(await reason(guard('staff', [{ $fill: { output: { note: { value: '$email' } } } }]))).toBe(
      'personal_field',
    )
    expect(
      await reason(
        guard('staff', [{ $fill: { sortBy: { salary: 1 }, output: { hours: { method: 'linear' } } } }]),
      ),
    ).toBe('personal_field')
    expect(
      await reason(
        guard('staff', [{ $fill: { partitionByFields: ['email'], output: { note: { value: 1 } } } }]),
      ),
    ).toBe('personal_field')
    expect(
      await reason(guard('staff', [{ $fill: { partitionBy: '$salary', output: { note: { value: 1 } } } }])),
    ).toBe('personal_field')
  })

  it('refuses partitioning by the raw value of a field that may hold personal data', async () => {
    expect(
      await reason(
        guard('staff', [
          { $fill: { partitionByFields: ['customer'], output: { note: { method: 'locf' } } } },
        ]),
      ),
    ).toBe('masking_unsupported')
    // The expression form is guarded instead, as a group key is.
    const { stages } = await guard('staff', [
      { $fill: { partitionBy: { c: '$customer' }, output: { note: { method: 'locf' } } } },
    ])
    expect(stages).toEqual([
      { $fill: { partitionBy: { c: typeGuard('$customer') }, output: { note: { method: 'locf' } } } },
    ])
  })

  it('sorts by a guarded copy of a key that may hold personal data', async () => {
    const { stages, nonce } = await guard('wild', [
      { $fill: { sortBy: { ts: 1 }, output: { level: { method: 'linear' } } } },
    ])
    const tmp = `__mm_w0_${nonce}`
    expect(stages).toEqual([
      { $addFields: { [tmp]: typeGuard('$ts') } },
      { $fill: { sortBy: { [tmp]: 1 }, output: { level: { method: 'linear' } } } },
      { $unset: [tmp] },
    ])
  })

  it('refuses malformed fills', async () => {
    for (const spec of [
      'x',
      { output: 'x' },
      { output: { a: 'x' } },
      { output: { a: { method: 'mean' } } },
      { output: { a: { method: 'locf', value: 1 } } },
      { output: { a: {} } },
      { output: { a: { value: 1 } }, other: 1 },
      { partitionByFields: 'dept', output: { a: { value: 1 } } },
    ])
      expect(await reason(guard('staff', [{ $fill: spec }])), JSON.stringify(spec)).not.toBe('allowed')
  })
})

describe('$densify for restricted users', () => {
  it('densifies a clean field unchanged', async () => {
    const stage = {
      $densify: {
        field: 'hired',
        partitionByFields: ['dept'],
        range: { step: 1, unit: 'day', bounds: 'full' },
      },
    }
    expect((await guard('staff', [stage])).stages).toEqual([stage])
    const bounded = { $densify: { field: 'hours', range: { step: 5, bounds: [0, 100] } } }
    expect((await guard('staff', [bounded])).stages).toEqual([bounded])
  })

  it('refuses densifying a masked path, whose generated steps would trace its values', async () => {
    expect(
      await reason(guard('staff', [{ $densify: { field: 'salary', range: { step: 1, bounds: 'full' } } }])),
    ).toBe('personal_field')
    expect(
      await reason(
        guard('staff', [{ $densify: { field: 'salary.base', range: { step: 1, bounds: 'full' } } }]),
      ),
    ).toBe('personal_field')
    expect(
      await reason(
        guard('wild', [{ $densify: { field: 'a.phone', range: { step: 1, bounds: 'partition' } } }]),
      ),
    ).toBe('personal_field')
  })

  it('refuses partitions over masked fields, or over the raw value of one that may hold them', async () => {
    expect(
      await reason(
        guard('staff', [
          {
            $densify: {
              field: 'hired',
              partitionByFields: ['email'],
              range: { step: 1, bounds: 'partition' },
            },
          },
        ]),
      ),
    ).toBe('personal_field')
    expect(
      await reason(
        guard('staff', [
          {
            $densify: {
              field: 'hired',
              partitionByFields: ['customer'],
              range: { step: 1, bounds: 'partition' },
            },
          },
        ]),
      ),
    ).toBe('masking_unsupported')
  })

  it('refuses malformed ranges', async () => {
    for (const range of [
      'x',
      { step: '$salary', bounds: 'full' },
      { step: 1, bounds: ['$salary', 10] },
      { step: 1, bounds: 'all' },
      { step: 1, bounds: [0] },
      { step: 1, bounds: 'full', unit: 3 },
      { step: 1, bounds: 'full', extra: 1 },
    ])
      expect(
        await reason(guard('staff', [{ $densify: { field: 'hours', range } }])),
        JSON.stringify(range),
      ).not.toBe('allowed')
    expect(await reason(guard('staff', [{ $densify: { range: { step: 1, bounds: 'full' } } }]))).not.toBe(
      'allowed',
    )
    expect(
      await reason(
        guard('staff', [{ $densify: { field: 'hours', range: { step: 1, bounds: 'full' }, x: 1 } }]),
      ),
    ).toBe('masking_unsupported')
  })
})

describe('$redact for restricted users', () => {
  it('runs any $redact where no rule applies', async () => {
    const stage = {
      $redact: { $cond: [{ $in: ['secret', { $ifNull: ['$tags', []] }] }, '$$PRUNE', '$$DESCEND'] },
    }
    expect((await guard('notes', [stage])).stages).toEqual([stage])
  })

  it("refuses reading each level's own fields where rules apply: any level may be a masked one", async () => {
    // "$tags" is read at every level $redact descends into, customer.tags and salary.tags included.
    for (const expr of [
      { $cond: [{ $eq: ['$tags', 'x'] }, '$$KEEP', '$$PRUNE'] },
      { $cond: [{ $eq: ['$$CURRENT.tags', 'x'] }, '$$KEEP', '$$PRUNE'] },
      { $cond: [{ $eq: ['$email', 'a@b.c'] }, '$$PRUNE', '$$DESCEND'] },
      { $cond: [{ $gt: [{ $size: { $ifNull: ['$items', []] } }, 0] }, '$$DESCEND', '$$PRUNE'] },
      { $let: { vars: { c: '$$CURRENT' }, in: '$$KEEP' } },
      { $cond: [{ $eq: [{ $getField: 'phone' }, '1'] }, '$$PRUNE', '$$KEEP'] },
    ])
      expect(await reason(guard('staff', [{ $redact: expr }])), JSON.stringify(expr)).not.toBe('allowed')
  })

  it('refuses $redact comparing a masked value through $$ROOT', async () => {
    expect(
      await reason(
        guard('staff', [{ $redact: { $cond: [{ $eq: ['$$ROOT.email', 'a@b.c'] }, '$$PRUNE', '$$KEEP'] } }]),
      ),
    ).toBe('personal_field')
    expect(
      await reason(
        guard('staff', [{ $redact: { $cond: [{ $gt: ['$$ROOT.salary', 5000] }, '$$PRUNE', '$$KEEP'] } }]),
      ),
    ).toBe('personal_field')
  })

  it('allows $$ROOT fields, guarded where they may hold personal data, and the $redact variables', async () => {
    const { stages } = await guard('staff', [
      {
        $redact: {
          $cond: [
            { $and: [{ $eq: ['$$ROOT.dept', 'ops'] }, { $ne: ['$$ROOT.customer', null] }] },
            '$$DESCEND',
            '$$PRUNE',
          ],
        },
      },
    ])
    expect(stages).toEqual([
      {
        $redact: {
          $cond: [
            { $and: [{ $eq: ['$$ROOT.dept', 'ops'] }, { $ne: [typeGuard('$$ROOT.customer'), null] }] },
            '$$DESCEND',
            '$$PRUNE',
          ],
        },
      },
    ])
  })

  it('keeps the $redact variables out of other stages', async () => {
    expect(await reason(guard('staff', [{ $addFields: { x: '$$PRUNE' } }]))).toBe('masking_unsupported')
    expect(await reason(guard('notes', [{ $addFields: { x: '$$DESCEND' } }]))).toBe('masking_unsupported')
  })

  it('refuses a $redact after a join brings rules in', async () => {
    expect(
      await reason(
        guard('notes', [
          { $lookup: { from: 'staff', pipeline: [], as: 'who' } },
          { $redact: { $cond: [{ $eq: ['$x', 1] }, '$$KEEP', '$$PRUNE'] } },
        ]),
      ),
    ).toBe('masking_unsupported')
  })
})
