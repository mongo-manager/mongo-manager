import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { MongoClient } from 'mongodb'
import { startMongo, type TestMongo } from './support/mongo'
import { restrictedApp } from './support/restricted'
import { compileRules } from '../src/masking/match'
import { maskChangeEvent } from '../src/masking/change-event'
import { checkRestrictedFilter } from '../src/changestreams/pipeline'
import { reroot } from '../src/masking/patterns'
import { maskValidator } from '../src/masking/definitions'
import { Shape } from '../src/masking/gate/shape'
import { touchesPersonal } from '../src/masking/gate/write'
import type { TestApp } from './helpers'
import { slow } from './support/slowness'

/**
 * Security review 2026-10-13 (C1): a rule naming a sub-document or an array (`address`, `cards`)
 * hid it whole, but a path below it (`address.city`, `cards.no`) was not personal: a projection, a
 * pipeline, a filter, a sort, a bulk update or a change event read the values inside.
 */
const S = 'SUBTR33'
const RULES = [
  { db: 'crm', coll: 'users', field: 'address' },
  { db: 'crm', coll: 'users', field: 'cards' },
]
const NS = '/databases/crm/collections/users'
let mongo: TestMongo
beforeAll(async () => {
  mongo = await startMongo()
  const client = await new MongoClient(`mongodb://127.0.0.1:${mongo.port}`).connect()
  await client
    .db('crm')
    .collection('users')
    .insertOne({ name: 'Ali', address: { city: `${S}-city`, zip: '1' }, cards: [{ no: `${S}-4111` }] })
  await client.close()
}, slow(120_000))
afterAll(async () => {
  await mongo?.stop()
})
const apps: TestApp[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})
async function user(role: 'viewer' | 'editor' = 'viewer') {
  const r = await restrictedApp(mongo, RULES)
  apps.push(r.t)
  return r.as(role, true)
}

describe('values below a personal field are personal too', () => {
  it('refuses a projection of a path below it, and shows the fields beside it', async () => {
    const as = await user()
    const res = await as('POST', `${NS}/find`, { filter: {}, projection: { c: '$address.city' }, limit: 5 })
    expect(res.body).not.toContain(S)
    expect(res.statusCode).toBe(403)
    expect(res.json().details).toMatchObject({ reason: 'personal_field' })
    const shown = await as('POST', `${NS}/find`, { filter: {}, projection: { name: 1 }, limit: 5 })
    expect(shown.json().documents[0].document).toMatchObject({ name: 'Ali' })
  })

  it('masks a pipeline that moves a value from below it', async () => {
    const as = await user()
    for (const stage of [{ $project: { c: '$cards.no' } }, { $addFields: { c: '$address.city' } }]) {
      const res = await as('POST', `${NS}/aggregate/run`, { stages: [stage], limit: 5 })
      expect([stage, res.body.includes(S)]).toEqual([stage, false])
    }
  })

  it.each([
    [{ filter: { 'address.city': { $regex: '^S' } } }],
    [{ filter: { 'cards.no': `${S}-4111` } }],
    [{ filter: {}, sort: { 'address.city': 1 } }],
  ])('refuses %j with personal_field', async (body) => {
    const as = await user()
    const res = await as('POST', `${NS}/find`, { limit: 5, ...body })
    expect(res.statusCode).toBe(403)
    expect(res.json().details).toMatchObject({ reason: 'personal_field' })
  })

  it('refuses a bulk update copying a value from below it', async () => {
    const as = await user('editor')
    const res = await as('POST', `${NS}/bulk/preview`, {
      filter: {},
      operation: 'update',
      update: [{ $set: { leak: '$address.city' } }],
    })
    expect(res.statusCode).toBe(403)
  })

  it('masks a change event naming a path below it, and refuses a change filter on one', () => {
    const ns = compileRules(RULES).forNs('crm', 'users')
    const event = maskChangeEvent(
      {
        operationType: 'update',
        update: { updated: { 'address.city': `${S}-new`, 'cards.0.no': `${S}-9`, name: 'Ala' }, removed: [] },
      } as never,
      ns,
    )
    expect(JSON.stringify(event)).not.toContain(S)
    expect((event as { update: { updated: Record<string, unknown> } }).update.updated.name).toBe('Ala')
    expect(() =>
      checkRestrictedFilter(
        { 'updateDescription.updatedFields.address.city': 'x' },
        { scope: 'collection', db: 'crm', coll: 'users' } as never,
        compileRules(RULES),
      ),
    ).toThrow()
  })

  // Review 2026-10-13 (I2): a validator's keywords that cannot be tied to one path, below a rule.
  it('masks the literals of a validator below a personal field', () => {
    const validator = {
      $jsonSchema: {
        properties: {
          address: { properties: { city: { if: { enum: [`${S}-city`] }, then: { minLength: 1 } } } },
          name: { enum: ['Ali'] },
        },
      },
    }
    const masked = JSON.stringify(maskValidator(validator, 'crm', 'users', compileRules(RULES)))
    expect(masked).not.toContain(S)
    expect(masked).toContain('Ali')
  })

  // Wave 3 second review: a $jsonSchema inside $and / $or / $nor is masked as a schema, its facts kept,
  // never turned whole into "***" (a data dictionary read nothing of it then).
  it('masks a $jsonSchema inside $and as a schema, never whole', () => {
    const validator = {
      $and: [
        {
          $jsonSchema: {
            required: ['name'],
            properties: {
              name: { bsonType: 'string', enum: ['Ali'] },
              address: { properties: { city: { enum: [`${S}-city`] } } },
            },
          },
        },
        { name: { $type: 'string' } },
      ],
      $or: [{ $jsonSchema: { properties: { name: { maxLength: 80 } } } }],
    }
    const masked = maskValidator(validator, 'crm', 'users', compileRules(RULES)) as {
      $and: Array<Record<string, unknown>>
      $or: Array<Record<string, unknown>>
    }
    const text = JSON.stringify(masked)
    expect(text).not.toContain(S)
    const schema = masked.$and[0]!.$jsonSchema as { required: string[]; properties: { name: unknown } }
    expect(schema.required).toEqual(['name'])
    expect(schema.properties.name).toEqual({ bsonType: 'string', enum: ['Ali'] })
    expect(masked.$or[0]).toEqual({ $jsonSchema: { properties: { name: { maxLength: 80 } } } })
  })

  // Wave 3 third review: a masked validator keeps its keys' order — a copy compares it as text and
  // dropped an unchanged validator as "holding values that would be masked".
  it('keeps a validator’s keys in their order', () => {
    const validator = { status: { $in: ['a', 'b'] }, $or: [{ type: 'a' }], $jsonSchema: { required: ['x'] } }
    const masked = maskValidator(validator, 'crm', 'users', compileRules(RULES))
    expect(JSON.stringify(masked)).toBe(JSON.stringify(validator))
  })

  // Third review (next to the diff): a value given for a whole object holding a personal field.
  it('masks an enum or const of an object above a personal field', () => {
    const validator = {
      $jsonSchema: {
        properties: {
          address: { enum: [{ city: `${S}-city` }] },
          cards: { const: [{ no: `${S}-card` }] },
          name: { enum: ['Ali'] },
        },
      },
    }
    const rules = compileRules([
      { db: 'crm', coll: 'users', field: 'address.city' },
      ...RULES.slice(1).map((r) => ({ ...r, field: 'cards.no' })),
    ])
    const masked = JSON.stringify(maskValidator(validator, 'crm', 'users', rules))
    expect(masked).not.toContain(S)
    expect(masked).toContain('Ali')
  })

  // Review I1: a path of thousands of segments held the server's one thread for seconds.
  it('refuses a path too deep to be a field, at once', () => {
    const shape = new Shape('crm.users', [['address']])
    const deep = Array.from({ length: 8000 }, () => 'a')
    const started = Date.now()
    expect(() => touchesPersonal(deep, shape)).toThrow()
    expect(() => shape.personal(deep)).toThrow()
    expect(Date.now() - started).toBeLessThan(200)
    expect(touchesPersonal(['address', 'city'], shape)).toBe(true)
    expect(touchesPersonal(['name'], shape)).toBe(false)
  })

  // Review M2: a pattern naming the root (a whole document) matched nothing.
  it('takes a pattern naming the root as the whole document', () => {
    const shape = new Shape('crm.users', [[]])
    expect(shape.personal(['name'])).toBe(true)
  })

  // Review M3: a target rule *.email counted as covering a source rule **.email.
  it('counts a rule as covering another only when it matches all it names', () => {
    const target = compileRules([{ db: 'crm', coll: 'users', field: '*.email' }]).forNs('crm', 'users')
    expect(target.covers(['**', 'email'])).toBe(false)
    expect(target.covers(['a', 'email'])).toBe(true)
    expect(target.covers(['*', 'email'])).toBe(true)
    const all = compileRules([{ db: 'crm', coll: 'users', field: '**.email' }]).forNs('crm', 'users')
    expect(all.covers(['**', 'email'])).toBe(true)
    expect(all.covers(['*', 'x', 'email'])).toBe(true)
    expect(all.covers(['email', 'x'])).toBe(true)
  })

  it('follows a path below a rule moved elsewhere', () => {
    expect(reroot([['address']], ['address', 'city'], ['c'])).toEqual([['c']])
    expect(reroot([['**', 'phone']], ['a', 'phone', 'x'], ['c'])).toEqual([['c']])
    expect(reroot([['address']], ['name'], ['c'])).toEqual([])
  })
})
